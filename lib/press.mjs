// Press subtraction — the differentiator.
//
// The gate proves a burst is statistically anomalous. But an anomaly the
// Associated Press already published is just the wire, amplified by mirror
// bots — detecting it proves the machinery works and nothing more. The
// interesting class is the PRECURSOR: a burst the mainstream press has not
// covered yet. So every event that passes the gate is checked against two
// keyless public indexes of "what the press/HN bloodstream already knows":
//
//   Google News RSS search — has the press written about this in the last 48h?
//   HN Algolia search      — has Hacker News seen it in the last 48h?
//
// covered  ⇔  ≥3 recent Google News items  OR  ≥1 recent HN story (≥10 pts)
//
// Fail-closed-honest: if the indexes can't be reached, status is "unknown"
// and no EARLY badge is shown. Precursors are re-checked every 4h for 72h;
// when coverage appears we record exactly how early we were (pressLag).

const GN = "https://news.google.com/rss/search?q=%s&hl=en-US&gl=US&ceid=US:en";
const HN = "https://hn.algolia.com/api/v1/search?query=%s&tags=story&numericFilters=created_at_i>%d";
const RECENT = 48 * 3600e3;
const CACHE_TTL = 6 * 3600e3;
const cache = new Map(); // query -> { at, res }

async function fetchText(url, json = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Significant/1.0 (statistically-honest news; https://significant.freeq.at)", Accept: json ? "application/json" : "application/rss+xml, text/xml, */*" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(timer); }
}

async function gnRecent(query) {
  const xml = await fetchText(GN.replace("%s", encodeURIComponent(query)));
  let n = 0;
  for (const m of xml.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const d = m[0].match(/<pubDate>([^<]+)<\/pubDate>/);
    if (d && Date.now() - new Date(d[1]).getTime() < RECENT) n++;
  }
  return n;
}

async function hnRecent(query) {
  const since = Math.floor((Date.now() - RECENT) / 1000);
  const data = await fetchText(HN.replace("%s", encodeURIComponent(query)).replace("%d", since), true);
  return (data.hits || []).filter((h) => (h.points || 0) >= 10).length;
}

// -> { ok, gn, hn, covered } — ok=false means the indexes failed us; say nothing
export async function checkCoverage(query) {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.res;
  let gn = 0, hn = 0, ok = true;
  try { gn = await gnRecent(query); } catch (e) { ok = false; }
  try { hn = await hnRecent(query); } catch (e) { ok = false; }
  const res = { ok, gn, hn, covered: ok && (gn >= 3 || hn >= 1) };
  if (ok) cache.set(query, { at: Date.now(), res });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return res;
}

// The search phrase for an event: the lead term plus its coherence companion.
// "chang'e- lunar" + "China" is a much better query than either alone.
export function eventQuery(ev) {
  const parts = [ev.lead.display || ev.lead.term];
  if (ev.cohTerm && !parts[0].toLowerCase().includes(ev.cohTerm.toLowerCase())) parts.push(ev.cohTerm);
  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  return q.length >= 4 ? q : null;
}
