// The engine: polls Surf topic feeds on staggered schedules, keeps a rolling
// per-topic post store (persisted to disk so baselines survive restarts and
// deepen over days), runs the significance gate each cycle, manages event
// lifecycle (first-seen, headlines, corroboration — each paid for exactly once),
// and fans out ticks to SSE clients.
//
// API-call budget (keyless): ~2,600 feed reads/day — well inside free-tier limits.
// AI budget: one batched Claude call per cycle *only if* new events passed the gate.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTopicPosts, corroborate, postStatus, LIVE } from "./surf.mjs";
import { extractTerms, extractDomains, scanTopic, gate, poissonTail, ALPHA } from "./stats.mjs";
import { writeHeadlines, templateHeadline, writeDailyNote, AI_LIVE } from "./ai.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || join(__dir, "..", "data");
const STATE_FILE = join(DATA, "state.json");

// name, poll interval — matched to measured feed velocity (see README)
const TOPICS = [
  { name: "news", every: 4 * 60e3 },
  { name: "science", every: 4 * 60e3 },
  { name: "movies", every: 5 * 60e3 },
  { name: "world-news", every: 5 * 60e3 },
  { name: "business", every: 8 * 60e3 },
  { name: "economics", every: 8 * 60e3 },
  { name: "health", every: 10 * 60e3 },
  { name: "sports", every: 10 * 60e3 },
  { name: "gaming", every: 10 * 60e3 },
  { name: "space", every: 10 * 60e3 },
  { name: "technology", every: 12 * 60e3 },
  { name: "climate", every: 12 * 60e3 },
  { name: "music", every: 20 * 60e3 },
  { name: "artificial-intelligence", every: 20 * 60e3 },
  { name: "politics", every: 20 * 60e3 },
  { name: "cybersecurity", every: 5 * 60e3 },
  { name: "finance", every: 8 * 60e3 },
  { name: "weather", every: 8 * 60e3 },
  { name: "energy", every: 10 * 60e3 },
  { name: "elections", every: 20 * 60e3 },
];
const MAX_POSTS_PER_TOPIC = 2500;
const MAX_AGE = 7 * 24 * 3600e3;
const EVENT_TTL = 24 * 3600e3;
const CYCLE = 60e3;

const topics = new Map();   // name -> { posts:[], lastPoll:0, lastError:null }
const events = new Map();   // id -> event
let counters = { postsAnalyzed: 0, termsTested: 0, passedEver: 0, day: dayKey(), postsToday: 0, termsToday: 0, passedToday: 0 };
let lastGate = { m: 0, alpha: ALPHA, noise: [] };
let tickerBuf = [];
let history = [];           // permanent ledger of everything that ever passed
let days = [];              // finished-day rollups {day, posts, terms, passed, note}
let seismo = {};            // topic -> [[t, maxZ], ...] sampled ~10min, 24h retained
let lastPassAt = null;      // for the null-streak clock
let launchedAt = Date.now();
const clients = new Set();
let dirty = false;
const BOT = process.env.SIG_BOT === "1";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://significant.freeq.at").replace(/\/$/, "");

function dayKey(t = Date.now()) { return new Date(t).toISOString().slice(0, 10); }
function eid(topic, term) { return createHash("md5").update(topic + ":" + term).digest("hex").slice(0, 12); }

function indexPost(p) {
  const { terms, display } = extractTerms(p.text);
  p.terms = terms;
  p.termDisplay = display;
  p.domains = extractDomains(p.text);
  return p;
}

// ---------- persistence ----------

async function load() {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
    for (const [name, t] of Object.entries(raw.topics || {})) {
      topics.set(name, { posts: (t.posts || []).map(indexPost), lastPoll: 0, lastError: null, firstPolledAt: t.firstPolledAt || null });
    }
    // operator knob: PURGE_TERMS='regex' drops matching events/history at load
    // (for retracting gate artifacts — e.g. a tokenizer bug's "ycombinator" event)
    const keep = (term, headline) => !PURGE_RE || !(PURGE_RE.test(term || "") || PURGE_RE.test(headline || ""));
    for (const ev of raw.events || []) {
      if (keep(ev.lead && ev.lead.term, ev.headline)) events.set(ev.id, ev);
    }
    if (raw.counters) counters = { ...counters, ...raw.counters };
    vetoed = raw.vetoed || {};
    const rawHist = raw.history || [];
    history = rawHist.filter((e) => keep(e.term, e.headline));
    const purged = rawHist.length - history.length;
    if (purged) {
      console.log(`[engine] PURGE_TERMS retracted ${purged} ledger entries`);
      counters.passedEver = Math.max(0, counters.passedEver - purged);
      counters.passedToday = Math.max(0, counters.passedToday - purged);
      dirty = true;
    }
    days = raw.days || [];
    seismo = raw.seismo || {};
    lastPassAt = raw.lastPassAt || (history.length ? history[history.length - 1].firstSeen : null);
    launchedAt = raw.launchedAt || Date.now();
    console.log(`[engine] restored ${[...topics.values()].reduce((s, t) => s + t.posts.length, 0)} posts, ${events.size} events`);
  } catch { /* fresh start */ }
  for (const t of TOPICS) if (!topics.has(t.name)) topics.set(t.name, { posts: [], lastPoll: 0, lastError: null, firstPolledAt: null });
}

async function persist() {
  if (!dirty) return;
  dirty = false;
  const out = {
    counters,
    history: history.slice(-5000),
    days: days.slice(-400),
    seismo,
    lastPassAt,
    launchedAt,
    topics: Object.fromEntries([...topics].map(([name, t]) => [name, {
      firstPolledAt: t.firstPolledAt,
      posts: t.posts.map(({ terms, termDisplay, domains, ...p }) => p),
    }])),
    events: [...events.values()],
  };
  await mkdir(DATA, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(out));
}

// ---------- polling ----------

async function pollTopic(name, limit) {
  const t = topics.get(name);
  try {
    const posts = await fetchTopicPosts(name, limit);
    if (!t.firstPolledAt) t.firstPolledAt = Date.now();
    const known = new Set(t.posts.map((p) => p.id));
    const fresh = posts.filter((p) => !known.has(p.id)).map(indexPost);
    if (fresh.length) {
      t.posts.push(...fresh);
      t.posts.sort((a, b) => a.at - b.at);
      const cutoff = Date.now() - MAX_AGE;
      t.posts = t.posts.filter((p) => p.at >= cutoff).slice(-MAX_POSTS_PER_TOPIC);
      rollDay();
      counters.postsAnalyzed += fresh.length;
      counters.postsToday += fresh.length;
      dirty = true;
    }
    t.lastError = null;
    t.lastPoll = Date.now();
    return fresh;
  } catch (e) {
    t.lastError = e.message;
    t.lastPoll = Date.now();
    console.error(`[poll] ${name}: ${e.message}`);
    return [];
  }
}

function rollDay() {
  const k = dayKey();
  if (counters.day !== k) {
    const finished = {
      day: counters.day,
      posts: counters.postsToday, terms: counters.termsToday, passed: counters.passedToday,
      topTerms: lastGate.noise.slice(0, 6).map((c) => c.display || c.term),
      note: null,
    };
    days.push(finished);
    counters.day = k;
    counters.postsToday = 0; counters.termsToday = 0; counters.passedToday = 0;
    dirty = true;
    // one Claude call per finished day, ever — fire and forget
    writeDailyNote(finished).then((note) => { finished.note = note; dirty = true; broadcast(); })
      .catch(() => {});
  }
}

// ---------- velocity anomaly (the seismograph gate) ----------
//
// Is this topic posting way above ITS OWN normal rate for this hour — before we
// even know what about? Poisson test on the last hour's post count.
//
// HARD RULE: rates come only from throughput WE OBSERVED (≥48h of our own
// polling). A one-shot bootstrap fetch is a biased sample — topic feeds mix
// firehose sources (dozens/hr) with slow ones (a few/day), so the most-recent-N
// snapshot wildly under-measures true velocity and fakes a "333× normal" burst.
// Also ≥6 distinct authors: one source flooding is spam, not an event.
function velocityScan(now) {
  const out = [];
  const hourAgo = now - 3600e3;
  for (const [name, t] of topics) {
    if (!t.firstPolledAt || now - t.firstPolledAt < 48 * 3600e3) continue; // must have watched ≥48h
    const observed = t.posts.filter((p) => p.at >= t.firstPolledAt); // only what we saw arrive
    const recent = observed.filter((p) => p.at >= hourAgo);
    const x = recent.length;
    if (x < 6) continue;
    if (new Set(recent.map((p) => p.handle)).size < 6) continue;
    const base = observed.filter((p) => p.at < hourAgo);
    if (base.length < 40) continue;
    const baseHours = (hourAgo - t.firstPolledAt) / 3600e3;
    const utcHour = new Date(now).getUTCHours();
    const daysOfHistory = baseHours / 24;
    const overallRate = base.length / baseHours;
    const sameHourRate = daysOfHistory >= 3
      ? base.filter((p) => new Date(p.at).getUTCHours() === utcHour).length / daysOfHistory
      : overallRate;
    const lambda = Math.max(overallRate, sameHourRate, 0.5);
    const p = poissonTail(x, lambda);
    out.push({ topic: name, x, lambda, ratio: x / lambda, p });
  }
  return out;
}

// ---------- the cycle ----------

async function cycle(bootstrap = false) {
  const now = Date.now();
  const due = TOPICS.filter((cfg) => bootstrap || now - topics.get(cfg.name).lastPoll >= cfg.every);
  let freshPosts = [];
  // small parallelism, be a polite keyless citizen
  for (let i = 0; i < due.length; i += 4) {
    const batch = due.slice(i, i + 4);
    const results = await Promise.all(batch.map((cfg) => pollTopic(cfg.name, bootstrap ? 100 : 60)));
    for (let j = 0; j < batch.length; j++) freshPosts.push(...results[j].map((p) => ({ ...p, topic: batch[j].name })));
  }

  // scan + gate
  const scans = new Map();
  for (const [name, t] of topics) scans.set(name, scanTopic(t.posts, now, observedSinceFor(t)));
  const g = gate(scans);
  const velo = velocityScan(now);
  g.m += velo.length; // velocity tests count toward the correction too
  g.alpha = g.m > 0 ? ALPHA / g.m : ALPHA;
  rollDay();
  if (due.length) { counters.termsTested += g.m; counters.termsToday += g.m; }
  lastGate = g;

  // seismograph: sample each topic's max |z| this cycle (~every 10 min)
  const lastSample = seismoLastAt || 0;
  if (now - lastSample >= 10 * 60e3) {
    seismoLastAt = now;
    for (const [name, s] of scans) {
      const z = s.testable && s.candidates.length ? Math.max(0, ...s.candidates.slice(0, 50).map((c) => c.z)) : 0;
      if (!seismo[name]) seismo[name] = [];
      seismo[name].push([now, Math.round(z * 10) / 10]);
      seismo[name] = seismo[name].filter(([t2]) => now - t2 < 24 * 3600e3);
    }
    dirty = true;
  }

  // velocity events pass the same corrected gate
  const veloEvents = velo.filter((v) => v.p < g.alpha);

  // event lifecycle
  const seen = new Set();
  let newborn = [];
  for (const v of veloEvents) {
    const id = eid(v.topic, "⊘velocity");
    seen.add(id);
    const prev = events.get(id);
    const t = topics.get(v.topic);
    const receipts = t.posts.slice(-8).reverse().map((p) => ({ handle: p.handle, name: p.name, text: p.text.slice(0, 300), service: p.service, url: p.url, at: p.at }));
    const ev = {
      id, topic: v.topic, type: "velocity",
      lead: { term: "posting rate", display: "posting rate", x: v.x, n: v.x, xb: 0, N: 0, p0: 0, p: v.p, z: round2((v.x - v.lambda) / Math.sqrt(v.lambda)), authors: 0, lambda: round2(v.lambda), ratio: round2(v.ratio) },
      cluster: [], receipts, spark: hourlyCounts(v.topic, now),
      firstSeen: prev ? prev.firstSeen : now, lastSeen: now, active: true,
      headline: prev?.headline || `#${v.topic.replace(/-/g, " ")} is posting at ${v.ratio.toFixed(1)}× its normal rate`,
      dek: prev?.dek || `${v.x} posts in the last hour vs an expected ${v.lambda.toFixed(1)} — something is happening before we know what.`,
      corro: null,
    };
    events.set(id, ev);
    if (!prev) { newborn.push(ev); counters.passedEver++; counters.passedToday++; }
    dirty = true;
  }
  for (const e of g.events) {
    const id = eid(e.topic, e.lead.term);
    seen.add(id);
    const postIndex = new Map(topics.get(e.topic).posts.map((p) => [p.id, p]));
    const clusterTerms = e.cluster.map((c) => c.term);
    const leadTerm = e.lead.term;
    const seenText = new Set();
    const receipts = e.postIds.map((pid) => postIndex.get(pid)).filter(Boolean)
      // receipts ARE the evidence: rank by how much of the cluster a post carries,
      // and drop stragglers that only matched a generic cluster member
      .map((p) => ({ p, hits: clusterTerms.filter((t) => p.terms.has(t)).length, lead: p.terms.has(leadTerm) }))
      .filter((r) => r.lead || r.hits >= 2)
      .sort((a, b) => (b.hits - a.hits) || (b.p.at - a.p.at))
      .map((r) => r.p)
      .filter((p) => { // dedupe wire-syndication copies of the same text
        const k = p.text.slice(0, 80).toLowerCase();
        if (seenText.has(k)) return false;
        seenText.add(k); return true;
      })
      .slice(0, 12)
      .map((p) => ({ handle: p.handle, name: p.name, text: p.text.slice(0, 300), service: p.service, url: p.url, at: p.at }));
    const spark = sparkline(e.topic, e.lead.term, now);
    const prev = events.get(id);

    // continuation check: is this the same story we already track, resurfacing under
    // an incidental new term? ("cars" bursting because the data-center story's viral
    // stat is "as much CO2 as 24 million cars"). Re-confirm the original instead of
    // manufacturing a duplicate card.
    if (!prev) {
      const urls = new Set(receipts.map((r) => r.url).filter(Boolean));
      let parent = null;
      for (const old of events.values()) {
        if (old.type !== "burst" || old.id === id || !old.receipts) continue;
        const overlap = old.receipts.filter((r) => r.url && urls.has(r.url)).length;
        if (overlap >= 3 || overlap / Math.max(1, Math.min(old.receipts.length, receipts.length)) >= 0.34) { parent = old; break; }
      }
      if (parent) {
        parent.active = true;
        parent.lastSeen = now;
        parent.continuations = [...(parent.continuations || []), { term: e.lead.display || e.lead.term, at: now, p: e.lead.p }].slice(-8);
        seen.add(parent.id);
        dirty = true;
        continue;
      }
    }
    const ev = {
      id, topic: e.topic, type: "burst",
      crossTopics: e.crossTopics || null,
      coherence: round2(e.coherence || 0), cohTerm: e.cohTerm || null,
      lead: strip(e.lead), cluster: e.cluster.map(strip),
      receipts, spark,
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now, active: true,
      headline: prev?.headline || null, dek: prev?.dek || null,
      corro: prev?.corro || null,
    };

    events.set(id, ev);
    if (!prev) {
      newborn.push(ev);
      counters.passedEver++; counters.passedToday++;
    }
    dirty = true;
  }
  if (newborn.length) lastPassAt = now;
  for (const ev of events.values()) {
    if (!seen.has(ev.id) && ev.active) { ev.active = false; dirty = true; }
    if (now - ev.lastSeen > EVENT_TTL) { events.delete(ev.id); dirty = true; }
  }

  // headlines: ONE batched call for all newborns (plus any survivor missing one)
  const needH = [...events.values()].filter((ev) => ev.active && !ev.headline);
  if (needH.length) {
    const withSnips = needH.map((ev) => ({ ...ev, snippets: ev.receipts.slice(0, 8).map((r) => r.text.slice(0, 200)) }));
    const map = await writeHeadlines(withSnips);
    for (const ev of needH) {
      const h = map.get(ev.id) || templateHeadline(ev);
      // Claude's veto: it may never admit an event, but it may drop one whose posts
      // don't tell the story the numbers implied. Logged, counters corrected.
      if (h.incoherent) {
        console.log(`[veto] headline writer judged incoherent: #${ev.topic} "${ev.lead.display || ev.lead.term}"`);
        events.delete(ev.id);
        counters.passedEver = Math.max(0, counters.passedEver - 1);
        counters.passedToday = Math.max(0, counters.passedToday - 1);
        dirty = true;
        continue;
      }
      ev.headline = h.headline; ev.dek = h.dek; dirty = true;
    }
    newborn = newborn.filter((ev) => events.has(ev.id));
  }

  // corroboration (LIVE only, once per event)
  if (LIVE) {
    for (const ev of newborn.filter((e) => e.type === "burst")) {
      const c = await corroborate(ev.lead.display || ev.lead.term);
      if (c) { ev.corro = c; dirty = true; }
    }
  }

  // ledger: everything that ever passed, forever
  for (const ev of newborn) {
    history.push({
      id: ev.id, topic: ev.topic, type: ev.type,
      term: ev.lead.term, display: ev.lead.display,
      headline: ev.headline, dek: ev.dek,
      x: ev.lead.x, n: ev.lead.n, p: ev.lead.p, z: ev.lead.z,
      crossTopics: ev.crossTopics || null,
      firstSeen: ev.firstSeen,
    });
    dirty = true;
  }

  // the silent bot: one post per passing event, nothing otherwise (SIG_BOT=1)
  if (BOT && newborn.length) {
    for (const ev of newborn) {
      const txt = `${ev.headline}\n\np = ${ev.lead.p.toExponential(1)} · Bonferroni-corrected · #${ev.topic}\nreceipts: ${PUBLIC_URL}/e/${ev.id}`;
      const r = await postStatus(txt.slice(0, 480));
      console.log(`[bot] ${ev.id}: ${r.ok ? "posted " + (r.url || "") : "failed: " + r.reason}`);
    }
  }

  // headlines arrived after the ledger push — sync them back
  for (const ev of newborn) {
    const h = history.find((x) => x.id === ev.id);
    if (h && ev.headline && h.headline !== ev.headline) { h.headline = ev.headline; h.dek = ev.dek; }
  }

  // ticker: verdicts for fresh posts
  if (freshPosts.length) {
    const candByTopic = new Map();
    for (const [name, s] of scans) {
      const m = new Map();
      for (const c of s.candidates || []) m.set(c.term, c);
      candByTopic.set(name, m);
    }
    const items = freshPosts.slice(-60).map((p) => {
      let best = null;
      const cands = candByTopic.get(p.topic);
      if (cands) for (const t of p.terms) {
        const c = cands.get(t);
        if (c && (!best || c.p < best.p)) best = c;
      }
      return {
        topic: p.topic, handle: p.handle, service: p.service, at: p.at,
        text: p.text.slice(0, 110),
        term: best ? (best.display || best.term) : null,
        p: best ? best.p : null, z: best ? round2(best.z) : null,
        pass: best ? best.p < g.alpha && best.x >= 4 && best.authors >= 3 : false,
      };
    });
    tickerBuf.push(...items);
    tickerBuf = tickerBuf.slice(-120);
  }

  broadcast();
  await persist().catch((e) => console.error("[persist]", e.message));
}

let seismoLastAt = 0;

// Was this topic's bootstrap snapshot representative? A slow feed's 100-post
// snapshot spans days (complete-ish record → trustworthy baseline). A fast feed's
// spans hours and undersamples its firehose sources → baseline must be built only
// from posts we observed arriving (scanTopic then enforces a 24h watch period).
function observedSinceFor(t) {
  if (!t.firstPolledAt) return null;
  const boot = t.posts.filter((p) => p.at < t.firstPolledAt);
  if (!boot.length) return null;
  const span = boot[boot.length - 1].at - boot[0].at;
  return span >= 48 * 3600e3 ? null : t.firstPolledAt;
}

function hourlyCounts(topic, now) {
  const t = topics.get(topic);
  const H = 48, buckets = new Array(H).fill(0);
  for (const p of t.posts) {
    const age = now - p.at;
    if (age < 0 || age >= H * 3600e3) continue;
    buckets[H - 1 - Math.floor(age / 3600e3)]++;
  }
  return buckets;
}

function strip(c) {
  return { term: c.term, display: c.display, x: c.x, n: c.n, xb: c.xb, N: c.N, p0: c.p0, p: c.p, z: round2(c.z), authors: c.authors };
}
function round2(v) { return Math.round(v * 100) / 100; }

function sparkline(topic, term, now) {
  const t = topics.get(topic);
  const H = 48, buckets = new Array(H).fill(0);
  for (const p of t.posts) {
    const age = now - p.at;
    if (age < 0 || age >= H * 3600e3) continue;
    if (p.terms.has(term)) buckets[H - 1 - Math.floor(age / 3600e3)]++;
  }
  return buckets;
}

// ---------- public API ----------

export function snapshot() {
  const now = Date.now();
  const evs = [...events.values()].sort((a, b) =>
    (b.active - a.active) || (a.lead.p - b.lead.p) || (b.lastSeen - a.lastSeen));
  return {
    live: { surf: LIVE, ai: AI_LIVE, bot: BOT },
    now,
    lastPassAt,
    launchedAt,
    seismo,
    lastNote: days.length ? { day: days[days.length - 1].day, note: days[days.length - 1].note } : null,
    stats: {
      ...counters,
      m: lastGate.m,
      alpha: lastGate.alpha,
      activeEvents: evs.filter((e) => e.active).length,
      topics: TOPICS.map((cfg) => {
        const t = topics.get(cfg.name);
        const s = scanTopic(t.posts, now, observedSinceFor(t));
        return {
          name: cfg.name, posts: t.posts.length,
          testable: s.testable, reason: s.reason || null,
          currentN: s.currentN || 0, baselineN: s.baselineN || 0,
          lastPoll: t.lastPoll, error: t.lastError,
        };
      }),
    },
    events: evs.slice(0, 40),
    noise: lastGate.noise.map((c) => ({ topic: c.topic, ...strip(c), failed: c.failed, structuralPass: !!c.structuralPass })),
    ticker: tickerBuf.slice(-60),
  };
}

export function getEvent(id) { return events.get(id) || null; }

export function getLedger() {
  return {
    launchedAt,
    lastPassAt,
    totals: { passedEver: counters.passedEver, postsAnalyzed: counters.postsAnalyzed, termsTested: counters.termsTested },
    days,
    today: { day: counters.day, posts: counters.postsToday, terms: counters.termsToday, passed: counters.passedToday },
    events: history.slice(-500).reverse(),
  };
}

export function subscribe(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
  send(res, "snapshot", snapshot());
}

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clients.delete(res); }
}
function broadcast() {
  const snap = snapshot();
  for (const res of clients) send(res, "snapshot", snap);
}

export async function start() {
  await load();
  console.log(`[engine] surf: ${LIVE ? "LIVE (keyed)" : "keyless public reads"} · ai: ${AI_LIVE ? "claude" : "templates"}`);
  await cycle(true); // bootstrap: deep fetch every topic
  setInterval(() => cycle(false).catch((e) => console.error("[cycle]", e)), CYCLE);
}
