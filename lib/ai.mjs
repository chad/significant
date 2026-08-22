// Claude headline writer. Thrift rules:
//   - only called for events that PASSED the gate (a handful per day, not per post)
//   - all new events in a cycle share ONE batched call (JSON in, JSON out)
//   - results cached by event id and persisted to disk — an event is never paid for twice
//   - small model, tiny max_tokens
// Falls back to deterministic templates when no ANTHROPIC_API_KEY is set.

import Anthropic from "@anthropic-ai/sdk";

const HAS_LLM = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const MODEL = process.env.AI_MODEL || "claude-haiku-4-5";
const FALLBACK_MODEL = "claude-3-5-haiku-latest";
export const AI_LIVE = HAS_LLM;

const client = HAS_LLM ? new Anthropic() : null;

export function templateHeadline(ev) {
  const t = ev.lead.display || ev.lead.term;
  const name = t.length <= 4 ? `“${t}”` : t.replace(/\b\w/g, (c, i) => (i === 0 ? c.toUpperCase() : c));
  return {
    headline: `${name} is surging in ${ev.topic.replace(/-/g, " ")}`,
    dek: `Appeared in ${ev.lead.x} of the last ${ev.lead.n} posts — baseline says expect ~${(ev.lead.p0 * ev.lead.n).toFixed(1)}.`,
  };
}

// events: [{id, topic, lead:{term,display,x,n,p0}, snippets:[..]}]
// returns Map<id, {headline, dek}>
export async function writeHeadlines(events) {
  const out = new Map();
  if (!events.length) return out;
  if (!HAS_LLM) {
    for (const ev of events) out.set(ev.id, templateHeadline(ev));
    return out;
  }
  const payload = events.map((ev) => ({
    id: ev.id,
    topic: ev.topic,
    term: ev.lead.display || ev.lead.term,
    related_terms: ev.cluster.slice(1, 4).map((c) => c.display || c.term),
    stat: `appeared in ${ev.lead.x}/${ev.lead.n} recent posts vs baseline expectation ${(ev.lead.p0 * ev.lead.n).toFixed(1)}`,
    posts: ev.snippets.slice(0, 8),
  }));
  const prompt = `You write neutral, factual one-line headlines for statistically significant bursts of discussion on the open social web (Mastodon + Bluesky + RSS). You are NOT summarizing opinion — you are naming what event or story the burst is about, based only on the post excerpts given.

For each item, return:
- "headline": 6–12 words, neutral newsroom register, no clickbait, no hashtags, no emoji. Name the actual event if the posts make it clear; if they don't, describe the discussion honestly (e.g. "X draws a burst of cross-network discussion").
- "dek": ONE sentence (max 25 words) of what the posts are actually saying.

Return ONLY a JSON array: [{"id": "...", "headline": "...", "dek": "..."}]

Items:
${JSON.stringify(payload, null, 1)}`;

  let text;
  try {
    text = await callClaude(prompt);
  } catch (e) {
    console.error("[ai] headline call failed:", e.message);
    for (const ev of events) out.set(ev.id, templateHeadline(ev));
    return out;
  }
  try {
    const jsonStr = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const arr = JSON.parse(jsonStr);
    for (const item of arr) {
      if (item && item.id && item.headline) out.set(item.id, { headline: String(item.headline).slice(0, 140), dek: String(item.dek || "").slice(0, 240) });
    }
  } catch (e) {
    console.error("[ai] headline parse failed:", e.message);
  }
  for (const ev of events) if (!out.has(ev.id)) out.set(ev.id, templateHeadline(ev));
  return out;
}

// One line of statistician's commentary for a finished day. ONE call per day, ever.
// dayStats: {day, posts, terms, passed, topTerms:[..]}
export async function writeDailyNote(dayStats) {
  const fallback = dayStats.passed === 0
    ? `The internet was very excited about ${dayStats.terms.toLocaleString()} things on ${dayStats.day}. None survived arithmetic.`
    : `${dayStats.day}: ${dayStats.posts.toLocaleString()} posts, ${dayStats.terms.toLocaleString()} hypotheses, ${dayStats.passed} survived. The world briefly happened.`;
  if (!HAS_LLM) return fallback;
  try {
    const text = await callClaude(
      `You are the resident statistician of "Significant", a news feed where stories must reject the null hypothesis (Bonferroni-corrected) to appear. Write ONE dry, witty sentence (max 28 words) summarizing this finished day. Tone: deadpan, kind, a little smug about arithmetic. No hashtags, no emoji, no quotes around it.\n\nDay: ${dayStats.day}\nPosts analyzed: ${dayStats.posts}\nHypotheses tested: ${dayStats.terms}\nEvents that passed the gate: ${dayStats.passed}\nBusiest failed terms (the noise): ${(dayStats.topTerms || []).join(", ") || "n/a"}\n\nReturn only the sentence.`
    );
    const line = text.trim().split("\n")[0].slice(0, 240);
    return line || fallback;
  } catch (e) {
    console.error("[ai] daily note failed:", e.message);
    return fallback;
  }
}

async function callClaude(prompt) {
  const req = (model) => client.messages.create({
    model,
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  let resp;
  try {
    resp = await req(MODEL);
  } catch (e) {
    if (e.status === 404 || /model/i.test(e.message || "")) resp = await req(FALLBACK_MODEL);
    else throw e;
  }
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
