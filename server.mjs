// Significant — the news feed with a p-value.
//   node server.mjs                # keyless: live public Surf topic feeds, template headlines
//   ANTHROPIC_API_KEY=...          # + Claude-written neutral headlines (batched, cached)
//   SURF_API_KEY=...               # + higher rate tier + cross-network corroboration
//
//   GET /                  the feed
//   GET /api/stream        SSE: full snapshot on connect + every cycle
//   GET /api/state         snapshot JSON
//   GET /e/:id             shareable event permalink (OG tags for HN/PH unfurls)
//   GET /api/health        { ok, surf, ai }

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { start, snapshot, subscribe, getEvent, getLedger } from "./lib/engine.mjs";
import { LIVE } from "./lib/surf.mjs";
import { AI_LIVE } from "./lib/ai.mjs";
import { fmtP } from "./lib/stats.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8801;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, surf: LIVE ? "live" : "keyless", ai: AI_LIVE ? "claude" : "templates" }));
    }

    if (p === "/api/ledger") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify(getLedger()));
    }

    // RSS: subscribe to a feed that's usually empty. That's the point.
    if (p === "/feed.xml" || p === "/rss") {
      const led = getLedger();
      const base = `${(req.headers["x-forwarded-proto"] || "https")}://${req.headers.host || "significant.freeq.at"}`;
      const items = led.events.slice(0, 50).map((e) => `
  <item>
    <title>${esc(e.headline || e.display || e.term)} — p = ${e.p.toExponential(1)}</title>
    <link>${base}/e/${e.id}</link>
    <guid isPermaLink="false">sig-${e.id}-${e.firstSeen}</guid>
    <pubDate>${new Date(e.firstSeen).toUTCString()}</pubDate>
    <description>${esc(`${e.dek || ""} [#${e.topic}${e.crossTopics ? " · CROSS-DOMAIN: " + e.crossTopics.join(", ") : ""}] Appeared in ${e.x} of ${e.n} recent posts; z = ${e.z}; p = ${e.p.toExponential(1)}, past a Bonferroni-corrected gate.`)}</description>
  </item>`).join("");
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Significant — the news feed with a p-value</title>
  <link>${base}</link>
  <description>Only statistically significant news. Usually empty. That's the point.</description>${items}
</channel></rss>`);
    }

    if (p === "/ledger") {
      const data = await readFile(join(__dir, "public", "ledger.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(data);
    }

    if (p === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify(snapshot()));
    }

    if (p === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      return subscribe(res);
    }

    // shareable permalink with OG tags — the unfurl IS the pitch
    const em = p.match(/^\/e\/([a-f0-9]{12})$/);
    if (em) {
      const ev = getEvent(em[1]);
      if (!ev) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>event expired</h1><p>Significance is fleeting. <a href='/'>Back to the feed.</a></p>"); }
      const title = `${ev.headline || ev.lead.term} — p = ${fmtP(ev.lead.p)}`;
      const desc = `${ev.dek || ""} Appeared in ${ev.lead.x} of ${ev.lead.n} recent posts in #${ev.topic} (baseline ${(ev.lead.p0 * ev.lead.n).toFixed(1)}); z = ${ev.lead.z}. Passed a Bonferroni-corrected significance gate on the live open social web.`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="Significant — the news feed with a p-value">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0;url=/#e-${ev.id}">
</head><body>Redirecting to <a href="/#e-${ev.id}">the feed</a>…</body></html>`);
    }

    let rel = p === "/" ? "/index.html" : p;
    const file = normalize(join(__dir, "public", rel));
    if (!file.startsWith(join(__dir, "public"))) { res.writeHead(403); return res.end("forbidden"); }
    const data = await readFile(file).catch(() => null);
    if (data == null) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "not_found" })); }
    res.writeHead(200, { "Content-Type": (MIME[extname(file)] || "application/octet-stream") + "; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(data);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "server_error", detail: String((err && err.message) || err) }));
  }
});

server.listen(PORT, async () => {
  console.log(`Significant on http://localhost:${PORT}`);
  console.log(`  surf: ${LIVE ? "LIVE (keyed)" : "keyless — public topic feeds"} · headlines: ${AI_LIVE ? "claude" : "templates (set ANTHROPIC_API_KEY)"}`);
  await start();
});
