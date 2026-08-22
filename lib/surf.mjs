// Surf provider for Significant.
//
// KEYLESS BY DESIGN: topic feeds (`GET /feed/posts?surfId=surf/topic/…`) are public
// reads on the Surf API — real, live Mastodon + Bluesky + RSS posts with no token.
// Setting SURF_API_KEY upgrades, never gates:
//   - requests carry X-API-Key (higher rate-limit tier)
//   - significant events get cross-network corroboration via GET /search?type=posts
//     (read:search scope) — searched only for events that already passed the gate,
//     so the call count stays tiny.

const BASE = "https://api.surf.social/v1";
const KEY = process.env.SURF_API_KEY || null;
export const LIVE = !!KEY;

function headers() {
  return KEY ? { "X-API-Key": KEY } : {};
}

export function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    // drop lone/unpaired UTF-16 surrogates — real posts carry them and they break JSON encoding
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\s+/g, " ").trim();
}

function serviceOf(acct) {
  const a = (acct || "").toLowerCase();
  if (a.includes("bsky") || a.includes("bluesky")) return "bluesky";
  if (a.includes("buzzsprout") || a.includes("podbean") || a.includes("anchor.fm") || a.includes("libsyn")) return "podcast";
  return a.includes("@") ? "mastodon" : "rss";
}

function cleanPost(p) {
  const src = p.reblog || p;
  const a = src.account || {};
  const at = Date.parse(src.created_at || a.last_status_at || "") || null;
  return {
    id: String(src.id || src.uri || src.url || ""),
    handle: a.acct || a.username || "",
    name: stripHtml(a.display_name || a.username || ""),
    text: stripHtml(src.content).slice(0, 500),
    service: serviceOf(a.acct),
    url: src.url || src.uri || "",
    at,
  };
}

// REAL, live posts from a Surf topic feed. Works with NO token.
// NOTE: the live API wants camelCase `surfId`, not the docs' `surf_id`.
export async function fetchTopicPosts(topic, limit = 60) {
  const url = new URL(BASE + "/feed/posts");
  url.searchParams.set("surfId", "surf/topic/" + topic);
  url.searchParams.set("limit", String(limit));
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`surf feed/posts(${topic}) -> ${r.status}`);
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : [])
    .map(cleanPost)
    .filter((p) => p.id && p.text && p.text.length > 3 && p.at);
}

// The silent bot: publish a passing event to the open social web (write:statuses).
// Only called when SIG_BOT=1 AND an event passes the gate — silence otherwise is the point.
export async function postStatus(text) {
  if (!LIVE) return { ok: false, reason: "no key" };
  try {
    const r = await fetch(BASE + "/statuses", {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: text, visibility: "public" }),
    });
    if (!r.ok) return { ok: false, reason: `${r.status}` };
    const data = await r.json().catch(() => ({}));
    return { ok: true, url: data.url || data.uri || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Cross-network corroboration for an already-significant event. LIVE mode only.
// GET /search?q=<term>&type=posts (read:search). Called once per event, cached upstream.
export async function corroborate(term, limit = 20) {
  if (!LIVE) return null;
  try {
    const url = new URL(BASE + "/search");
    url.searchParams.set("q", term);
    url.searchParams.set("type", "posts");
    url.searchParams.set("limit", String(limit));
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) return null;
    const data = await r.json();
    const arr = Array.isArray(data) ? data : data.posts || data.statuses || data.results || [];
    const posts = arr.map(cleanPost).filter((p) => p.text);
    return { found: posts.length, sample: posts.slice(0, 3) };
  } catch {
    return null;
  }
}
