// The significance gate. Honest by construction:
//
//   For each topic feed we split stored posts into a CURRENT window (recent) and a
//   BASELINE (everything older). A term that appears in x of n current posts, with
//   baseline proportion p0 (Laplace-smoothed), is tested with an exact binomial
//   tail: p = P(X >= x | n, p0). Exposure is measured in POSTS, not wall-clock
//   time, so a 4-posts/day feed and a 3,400-posts/day feed face the same gate.
//
//   Every term tested this cycle counts toward m, and the gate is Bonferroni:
//   a term passes only if p < ALPHA / m. Plus structural gates: x >= MIN_X,
//   >= MIN_AUTHORS distinct authors (one loud account is not news).
//
// Everything the UI shows (n, x, p0, z, p, m, alpha) comes straight from here.

export const ALPHA = 0.01;
export const MIN_X = 4;            // term must appear in at least this many current posts
export const MIN_AUTHORS = 3;      // ...from at least this many distinct authors
export const MIN_BASELINE_N = 30;  // baseline posts required before a topic is testable
export const MIN_BASELINE_SPAN = 3 * 3600e3; // ...spanning at least 3h
export const CURRENT_WINDOW = 6 * 3600e3;    // "now" = last 6h (min 12 posts, see engine)

// ---------- math ----------

const LG_CACHE = new Map();
function lnGamma(z) {
  // Lanczos approximation
  if (LG_CACHE.has(z)) return LG_CACHE.get(z);
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  const v = 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x) - Math.log(z);
  if (LG_CACHE.size < 50000) LG_CACHE.set(z, v);
  return v;
}
function lnChoose(n, k) { return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1); }

// Exact upper binomial tail P(X >= x | n, p). Exact for n <= 2000, else normal approx.
export function binomTail(x, n, p) {
  if (x <= 0) return 1;
  if (p <= 0) return x > 0 ? 0 : 1;
  if (p >= 1) return 1;
  if (n <= 2000) {
    let s = 0;
    const lp = Math.log(p), lq = Math.log(1 - p);
    for (let k = x; k <= n; k++) {
      s += Math.exp(lnChoose(n, k) + k * lp + (n - k) * lq);
      if (s > 1) return 1;
    }
    return Math.min(1, s);
  }
  return 1 - normCdf(zScore(x, n, p));
}

// Upper Poisson tail P(X >= x | lambda) — exact via series for the velocity gate.
export function poissonTail(x, lambda) {
  if (x <= 0) return 1;
  if (lambda <= 0) return 0;
  let term = Math.exp(-lambda), cdf = term;
  for (let k = 1; k < x; k++) {
    term *= lambda / k;
    cdf += term;
    if (1 - cdf < 1e-300) return 1e-300;
  }
  return Math.max(1e-300, 1 - cdf);
}

export function zScore(x, n, p) {
  const sd = Math.sqrt(n * p * (1 - p));
  if (!sd) return 0;
  return (x - n * p - 0.5) / sd; // continuity-corrected
}

function normCdf(z) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// ---------- term extraction ----------

const STOP = new Set(("a,about,above,after,again,against,all,also,am,an,and,any,are,aren,as,at,be,because,been,before," +
  "being,below,between,both,but,by,can,cannot,could,couldn,did,didn,do,does,doesn,doing,don,down,during,each,few," +
  "for,from,further,get,got,had,hadn,has,hasn,have,haven,having,he,her,here,hers,herself,him,himself,his,how,i,if," +
  "in,into,is,isn,it,its,itself,just,like,me,more,most,my,myself,new,no,nor,not,now,of,off,on,once,only,or,other," +
  "ought,our,ours,ourselves,out,over,own,per,same,she,should,shouldn,so,some,such,than,that,the,their,theirs,them," +
  "themselves,then,there,these,they,this,those,through,to,too,under,until,up,very,was,wasn,we,were,weren,what,when," +
  "where,which,while,who,whom,why,will,with,won,would,wouldn,you,your,yours,yourself,yourselves," +
  // social-web noise
  "amp,via,rt,thread,post,posts,posted,news,breaking,update,updated,live,today,yesterday,tomorrow,week,day,days," +
  "year,years,time,people,really,think,know,going,want,make,makes,made,said,says,say,see,still,even,much,many,one," +
  "two,three,first,last,next,back,way,well,good,great,big,little,right,left,thing,things,lot,bit,read,article,story," +
  "watch,video,photo,link,click,follow,share,comment,reply,love,us,let,look,take,come,dont,cant,youre,theyre,ive," +
  "im,thats,heres,whats,gonna,ep,podcast,episode,blog,free,live,best,top,check,full,every,around,another,https,http,www")
  .split(","));

const WORD_RE = /[A-Za-z][A-Za-z'’\u00C0-\u024F-]*/g;

// Returns { terms:Set<string>, display:Map<term, originalCase> }
export function extractTerms(text) {
  const clean = String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/[@#](\w)/g, "$1");
  const raw = clean.match(WORD_RE) || [];
  const tokens = raw.slice(0, 120);
  const terms = new Set();
  const display = new Map();
  const isCap = (w) => /^[A-Z][a-z'’\u00E0-\u024F-]+$/.test(w);
  const norm = (w) => w.toLowerCase().replace(/[’']/g, "'");

  // unigrams
  for (const w of tokens) {
    const t = norm(w);
    if (t.length < 3 || t.length > 28 || STOP.has(t.replace(/'/g, ""))) continue;
    terms.add(t);
    if (isCap(w) && !display.has(t)) display.set(t, w);
  }
  // bigrams of consecutive non-stop tokens
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = norm(tokens[i]), b = norm(tokens[i + 1]);
    if (a.length < 3 || b.length < 3) continue;
    if (STOP.has(a.replace(/'/g, "")) || STOP.has(b.replace(/'/g, ""))) continue;
    const t = a + " " + b;
    if (t.length > 40) continue;
    terms.add(t);
    if (isCap(tokens[i]) && isCap(tokens[i + 1]) && !display.has(t)) display.set(t, tokens[i] + " " + tokens[i + 1]);
  }
  // capitalized entity runs (2-4 words), even across stopwords like "of"
  const LEAD_SKIP = new Set(["the", "a", "an", "this", "that", "these", "his", "her", "its", "their", "our", "my", "breaking", "new", "why", "how", "what", "when", "who"]);
  for (let i = 0; i < tokens.length; i++) {
    if (!isCap(tokens[i]) || LEAD_SKIP.has(norm(tokens[i]))) continue;
    let run = [tokens[i]];
    let j = i + 1;
    while (j < tokens.length && run.length < 4 && (isCap(tokens[j]) || (["of", "the", "de", "von", "van"].includes(norm(tokens[j])) && isCap(tokens[j + 1] || "")))) {
      run.push(tokens[j]); j++;
    }
    if (run.length >= 2) {
      const t = run.map(norm).join(" ");
      if (t.length <= 48) { terms.add(t); if (!display.has(t)) display.set(t, run.join(" ")); }
      i = j - 1;
    }
  }
  // cap per-post term count so one spammy post can't flood m
  if (terms.size > 60) {
    const keep = new Set([...terms].slice(0, 60));
    return { terms: keep, display };
  }
  return { terms, display };
}

// ---------- per-topic scan ----------
//
// posts: [{id, at, handle, text, ...}] sorted ascending by at, each with .terms Set precomputed.
// Returns { testable, candidates:[...], m, currentN, baselineN, windowStart, spanMs }

export function scanTopic(posts, now = Date.now()) {
  if (posts.length < 20) return { testable: false, reason: "too few posts", m: 0, candidates: [] };

  // current window: last 6h, but at least the most recent 12 posts
  let start = now - CURRENT_WINDOW;
  const byTime = posts; // already sorted asc
  let idx = byTime.findIndex((p) => p.at >= start);
  if (idx === -1) idx = byTime.length;
  if (byTime.length - idx < 12) idx = Math.max(0, byTime.length - 12);
  const current = byTime.slice(idx);
  const baseline = byTime.slice(0, idx);
  const baseSpan = baseline.length ? baseline[baseline.length - 1].at - baseline[0].at : 0;

  if (baseline.length < MIN_BASELINE_N || baseSpan < MIN_BASELINE_SPAN) {
    return {
      testable: false, reason: "calibrating baseline", m: 0, candidates: [],
      currentN: current.length, baselineN: baseline.length, baselineSpanMs: baseSpan,
    };
  }

  // count term presence
  const curCount = new Map(), curPosts = new Map(), curAuthors = new Map(), disp = new Map();
  for (const p of current) {
    for (const t of p.terms) {
      curCount.set(t, (curCount.get(t) || 0) + 1);
      if (!curPosts.has(t)) curPosts.set(t, []);
      curPosts.get(t).push(p.id);
      if (!curAuthors.has(t)) curAuthors.set(t, new Set());
      curAuthors.get(t).add(p.handle || p.id);
      const d = p.termDisplay && p.termDisplay.get ? p.termDisplay.get(t) : null;
      if (d && !disp.has(t)) disp.set(t, d);
    }
  }
  const baseCount = new Map();
  for (const p of baseline) for (const t of p.terms) baseCount.set(t, (baseCount.get(t) || 0) + 1);

  const n = current.length, N = baseline.length;
  const candidates = [];
  let m = 0;
  for (const [t, x] of curCount) {
    m++; // every term observed in the current window is a test
    if (x < 2) continue; // not even worth reporting as a near-miss
    const xb = baseCount.get(t) || 0;
    const p0 = (xb + 0.5) / (N + 1); // Laplace smoothing
    const p = binomTail(x, n, p0);
    const z = zScore(x, n, p0);
    candidates.push({
      term: t,
      display: disp.get(t) || null,
      x, n, xb, N, p0, p, z,
      authors: curAuthors.get(t).size,
      postIds: curPosts.get(t),
    });
  }
  candidates.sort((a, b) => a.p - b.p);
  return {
    testable: true, m, candidates,
    currentN: n, baselineN: N,
    windowStart: current.length ? current[0].at : now,
    baselineSpanMs: baseSpan,
  };
}

// ---------- gate + clustering ----------

// A term made only of the topic's own name words ("economics" in #economics,
// "artificial intelligence" in #artificial-intelligence) is trivially self-referential.
function isTopicTerm(topic, term) {
  const words = new Set(topic.split("-"));
  return term.split(" ").every((w) => words.has(w));
}

// Given all topics' scans, apply the global Bonferroni gate and cluster
// co-occurring significant terms into events.
export function gate(scans /* Map<topic, scan> */) {
  let m = 0;
  for (const s of scans.values()) m += s.m || 0;
  const alpha = m > 0 ? ALPHA / m : ALPHA;

  const sig = [];
  const noise = [];
  for (const [topic, s] of scans) {
    if (!s.testable) continue;
    for (const c of s.candidates) {
      if (isTopicTerm(topic, c.term)) continue;
      const reasons = [];
      if (c.x < MIN_X) reasons.push(`n=${c.x} too small (need ≥${MIN_X})`);
      if (c.authors < MIN_AUTHORS) reasons.push(`only ${c.authors} author${c.authors === 1 ? "" : "s"} (need ≥${MIN_AUTHORS})`);
      if (c.p >= alpha) reasons.push(`p = ${fmtP(c.p)} ≥ α/m = ${fmtP(alpha)}`);
      if (reasons.length === 0) sig.push({ topic, ...c });
      else if (c.x >= 3 && c.p < 0.05) noise.push({ topic, ...c, failed: reasons, structuralPass: c.x >= MIN_X && c.authors >= MIN_AUTHORS });
    }
  }
  noise.sort((a, b) => a.p - b.p);

  // cluster significant terms within a topic by post-set overlap (Jaccard >= 0.4)
  const byTopic = new Map();
  for (const s of sig) {
    if (!byTopic.has(s.topic)) byTopic.set(s.topic, []);
    byTopic.get(s.topic).push(s);
  }
  const events = [];
  for (const [topic, terms] of byTopic) {
    terms.sort((a, b) => a.p - b.p);
    const used = new Set();
    for (const lead of terms) {
      if (used.has(lead.term)) continue;
      used.add(lead.term);
      const cluster = [lead];
      const leadSet = new Set(lead.postIds);
      for (const other of terms) {
        if (used.has(other.term)) continue;
        // skip sub/superstrings of the lead (redundant)
        const redundant = lead.term.includes(other.term) || other.term.includes(lead.term);
        const inter = other.postIds.filter((id) => leadSet.has(id)).length;
        const uni = new Set([...lead.postIds, ...other.postIds]).size;
        if (redundant || inter / uni >= 0.4) { used.add(other.term); cluster.push(other); }
      }
      const postIds = [...new Set(cluster.flatMap((c) => c.postIds))];
      events.push({ topic, lead, cluster, postIds });
    }
  }
  events.sort((a, b) => a.lead.p - b.lead.p);

  // cross-topic confirmation: the same lead term passing independently in 2+ topics
  // is replication — the strongest evidence there is. Annotate all members.
  const byLead = new Map();
  for (const e of events) {
    const k = e.lead.term;
    if (!byLead.has(k)) byLead.set(k, []);
    byLead.get(k).push(e);
  }
  for (const group of byLead.values()) {
    if (group.length >= 2) for (const e of group) e.crossTopics = group.map((g) => g.topic);
  }

  return { m, alpha, events, noise: noise.slice(0, 60) };
}

export function fmtP(p) {
  if (p === 0) return "<1e-300";
  if (p < 1e-4) return p.toExponential(1).replace("e-", "e−");
  return p.toFixed(4).replace(/^0/, "");
}
