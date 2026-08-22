# Significant — the news feed with a p-value

A news feed where every story must **reject the null hypothesis**. Significant watches 15 live
topic feeds on the open social web (Mastodon + Bluesky + RSS via the
[Surf API](https://developers.surf.social)), tests every burst of discussion against that feed's
own baseline with an exact binomial test, and **Bonferroni-corrects** across every hypothesis it
looked at. Almost nothing passes. The empty state is the product.

```
survival rate so far: ~0.03% of hypotheses tested
```

## Run it

```bash
cd significant
npm install          # one dependency (@anthropic-ai/sdk), only used if you set a key
npm start            # → http://localhost:8801
```

Works **keyless** out of the box: Surf topic feeds are public reads — real, live, current posts,
no signup. State persists to `data/state.json`, so baselines deepen the longer it runs
(a fresh boot marks under-calibrated topics honestly and arms them as history accrues).

### Optional upgrades (never gates)

| Env var | What it adds |
|---|---|
| `ANTHROPIC_API_KEY` | Claude writes the neutral one-line headline + dek for each event **after** it passes the gate. One batched call per cycle, cached forever per event. Without it: deterministic template headlines, identical statistics. |
| `SURF_API_KEY` | Higher rate-limit tier + cross-network **corroboration** for significant events via `GET /search?type=posts` (read:search). Searched only for events that already passed — a handful of calls a day. |
| `SIG_BOT=1` | **The silent bot**: posts each passing event (headline + p-value + permalink) to Bluesky/Mastodon via the Surf write API, and posts *nothing* otherwise. Requires a token with `write:statuses`. |
| `PUBLIC_URL` | Base URL used in bot posts and permalinks (default `https://significant.freeq.at`). |

## The method (short version)

1. **Exposure is posts, not time.** Feeds run from ~4 to ~3,400 posts/day, so bursts are measured
   as proportions: term appeared in `x` of the last `n` posts vs. Laplace-smoothed baseline
   proportion `p₀` from everything older.
2. **Exact binomial tail** `p = P(X ≥ x | n, p₀)` — computed exactly via log-gamma, plus a
   continuity-corrected z for display.
3. **Bonferroni.** Every term observed in every current window counts toward `m`; the gate is
   `p < 0.01 / m`. Testing thousands of hypotheses and reporting the best one is how every
   trending-topics algorithm works. We correct for it and print `m` in the UI.
4. **Structural gates.** ≥4 posts from ≥3 distinct authors (one loud account is not news);
   topics need ≥30 baseline posts spanning ≥3 h before they're testable at all.
5. **Velocity anomalies.** Each topic's posting *rate* is Poisson-tested against its own
   same-UTC-hour history (diurnal-corrected, ≥48 h required) — "something is happening in #space
   before we know what." Same corrected gate; the tests count toward `m`.
6. **Cross-domain confirmation.** The same term passing independently in 2+ topics gets a
   replication badge — the strongest evidence there is.
7. **The noise floor.** The closest calls that still failed are displayed with the reason they
   failed. These would all be "trending" somewhere else. The **α-slider** lets you lower the bar
   and watch what an uncorrected trending algorithm would have shown you instead.

Also in the box: a **null-streak clock** (how long the null hypothesis has held), a **seismograph**
(24 h max-z strip chart per topic), an optional **geiger-counter sound mode** (off by default —
clicks for rejected hypotheses, a chime when something passes), a **permanent ledger** at `/ledger`
(calendar of events per day + one dry statistician's note per finished day), and **RSS** at
`/feed.xml` — subscribe to a feed that's usually empty.

Full write-up in the in-app **methodology** modal, including honest limitations.

## Endpoints

| Route | What |
|---|---|
| `GET /` | the feed |
| `GET /api/stream` | SSE — snapshot on connect + every 60 s cycle |
| `GET /api/state` | snapshot JSON |
| `GET /ledger` | the permanent record — calendar, notes, every event ever |
| `GET /feed.xml` | RSS of passing events (usually silent) |
| `GET /api/ledger` | ledger JSON |
| `GET /e/:id` | shareable event permalink (OG tags carry the headline + p-value) |
| `GET /api/health` | `{ ok, surf, ai }` |

## Thrift

- ~2,600 keyless feed reads/day total (staggered per-topic schedules matched to measured feed velocity)
- Claude: one **batched** call per cycle *only if* new events passed the gate; cached to disk; small model, 1k max tokens
- Corroboration: once per event, live mode only

## Launch copy

- **HN:** *Show HN: A news feed where every story must reject the null hypothesis*
- **PH tagline:** *The anti-doomscroll feed — Bonferroni-corrected news. Usually empty. That's the point.*
