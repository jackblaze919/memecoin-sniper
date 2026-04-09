# Memecoin Sniper — Kiro Handoff

> Living document. Updated every time we make changes. Paste this into a new chat if context resets.

## Last Updated
2026-04-09 — Post-age-filter analysis on 96 trades. Key findings below.

## What This Is
Solana memecoin scanner/ranker/paper-trading bot. Node.js + Railway + Postgres. Discovers tokens from DexScreener, scores them with a 4-component model (D/F/M/S), paper-buys eligible ones, manages exits, reports via Telegram (@noscopebot).

## Current State
- **Mode:** paper (DRY_RUN=true)
- **Railway project:** agile-gratitude, auto-deploys from `origin main`
- **Strategy version:** 2.1
- **Latest commit:** `af3478c` — Enhanced entry_data + feature-importance + /analyze

## Architecture
```
Scanner (60s) → DexScreener profiles + boosted tokens
  ↓ inclusion filter (age, liq, mcap)
Ranker (90s) → Score candidates (D/F/M/S) + safety gate + anti-FOMO
  ↓ buyEligible = score >= 70 && safety && !FOMO
Executor → Paper buy (Jupiter quote for realistic pricing)
  ↓
Exit Monitor (30s) → Stop loss (30%) | Max hold (60m) | Liq drop (25%) | Partials (80%/300%/500%)
```

## Scoring Model (ANTI-PREDICTIVE — needs rework)
| Component | Weight | AUC (v2.1 analysis) | Status |
|-----------|--------|---------------------|--------|
| Discovery (D) | 25% | 0.409 | **Anti-predictive** |
| Flow (F) | 30% | 0.532 | Weak positive (best) |
| Mispricing (M) | 25% | 0.461 | Anti-predictive |
| Safety (S) | 20% | 0.495 | Random |
| **Total** | 100% | **0.398** | **Anti-predictive** |

Total score = D×0.25 + F×0.30 + M×0.25 + S×0.20
Buy threshold: 70

## Key Analysis Results (96 trades, Apr 4–9, post-60m age filter, real snapshots)
- Win rate: 39.6% — Expectancy: -0.0031 SOL/trade (still negative)
- Age filter killed fast deaths (14.5% → 6.3%) but 60-120m bucket is a massacre (15% win rate, 85% SL)
- Discovery flipped to strongest signal: AUC 0.607 (was 0.409 — anti-predictive before)
- Flow is now anti-predictive: AUC 0.445 (was 0.532)
- Mispricing is anti-predictive: AUC 0.422
- Total score: AUC 0.513 = random noise
- Threshold 72 > 70 (46.3% vs 39.6% win rate)
- $50-100k liquidity: 59.1% win rate (best bucket)
- 4h+ pair age: 44% win rate, 12% SL (best age bucket)

### Raw Feature Importance (strongest signals)
| Feature | AUC | Direction |
|---------|-----|-----------|
| Discovery score | 0.607 | higher = better |
| Market cap ($) | 0.604 | higher = better |
| Liquidity ($) | 0.598 | higher = better |
| Mispricing score | 0.422 | **ANTI** — higher = worse |
| Buys 1h (#) | 0.429 | **ANTI** — more buys = worse |
| Volume 1h ($) | 0.437 | **ANTI** — more volume = worse |
| Flow score | 0.445 | **ANTI** — higher = worse |

### Interpretation
Flow (30% weight) and Mispricing (25% weight) = 55% of the score, both anti-predictive.
High 1h volume/buys = you're late to the party. DexScreener data is lagging.
Discovery works because it captures acceleration (5m vs 1h), not absolute levels.

## Current Experiment
**240-minute (4h) minimum pair age filter** (pending deploy)
- Previous: 60m filter killed sub-15m fast deaths but 60-120m still terrible
- 4h+ bucket showed 44% win rate, 12% SL in the data
- Next experiment after this: rebalance weights (kill Flow/Mispricing, boost Discovery)

## Queued Next Moves (in order, one at a time)
1. ~~60m age filter~~ ✅ Done, analyzed
2. **240m age filter** ← CURRENT
3. Rebalance weights: D:40 / F:15 / M:15 / S:30 (or similar)
4. Raise threshold to 72 if weight rebalance helps
5. Consider $50k min liquidity filter

## What NOT to Change Yet
- Don't raise threshold above 70
- Don't change exits
- Don't add features
- Don't rewrite weights
- Don't go tiny_live
- Don't stack changes — one variable at a time

## Safety Controls
- Helius authority check (required)
- Helius holder concentration backstop (on-chain top10 < 40%)
- Birdeye security/holders (optional, often degraded)
- Anti-FOMO gate (>500% 1h price spike, sell pressure spike)
- Daily loss cap: 0.1 SOL
- Max trades/hour: 5
- Max concurrent: 3
- Post-loss cooldown: 5min (1hr after 5 consecutive)
- Same-day rebuy lock
- Idempotency locks (DB-backed)
- DRY_RUN=true blocks all real swaps

## File Map
```
src/
  index.js          — Express server, startup, shutdown
  config.js         — All env vars, validation, mode helpers
  scheduler.js      — Tick orchestration (scan/rank/monitor/reconcile)
  scanner.js        — DexScreener discovery + inclusion filter
  ranker.js         — 4-component scoring + safety gate + anti-FOMO
  executor.js       — Paper/live buy + exit management + partials
  risk.js           — Trade gates, loss tracking, locks
  cache.js          — In-memory TTL cache with stale fallback
  telegram.js       — Bot commands (/status /positions /history /config /health /risk /report /skips /candidates)
  report.js         — Daily report generation
  health.js         — Startup + periodic health checks
  reconciler.js     — Resolve pending_review positions (live mode)
  db.js             — Postgres pool
  utils.js          — Helpers (retry, pctChange, clamp, etc.)
  wallet.js         — Solana keypair + sign/send
  logger.js         — Pino logger
  apis/
    dexscreener.js  — Token profiles, boosted, pairs, search
    helius.js       — RPC, authority check, largest accounts, DAS
    birdeye.js      — Overview, security, holders (often degraded)
    jupiter.js      — Quotes, swaps
  models/
    position.js     — CRUD for positions table
    token.js        — CRUD for tokens table
    stats.js        — Daily stats + bot_state KV
scripts/
  analyze-scores.js — Score validation analysis (AUC, buckets, components)
  verify-entry-data.js
  migrate.js
migrations/
  001_init.sql
  002_exit_locks.sql
  003_entry_data.sql
```

## If Age Filter Helps (next move)
Rebalance scoring weights. Data says:
- Discovery (D) is the only useful component — boost to 35-40%
- Flow (F) is anti-predictive — cut to 10-15%
- Mispricing (M) is anti-predictive — cut to 10-15%
- Safety (S) is neutral — keep or boost to 30%

## If Age Filter Doesn't Help
The DexScreener-primary model may be too low-resolution. Consider:
1. Simple baseline benchmark
2. Component-weight rebuild from scratch
3. Different signal family
4. Abandon current score architecture

## Change Log
| Date | Change | Commit |
|------|--------|--------|
| 2026-04-09 | Raise min pair age from 60m to 240m (4h) — 60-120m bucket was 15% win rate | — |
| 2026-04-09 | Analysis: 96 trades post-60m filter. D flipped to best signal, F+M anti-predictive | — |
| 2026-04-09 | Enhanced entry_data: added totalScore, liquidityUsd, volume24h, priceChangeM5, derived signals (flowDetValue, buyRatio1h/5m, volLiqRatio, mcapLiqRatio), minTokenAgeMinutes config | af3478c |
| 2026-04-09 | New `scripts/feature-importance.js` — raw feature AUC analysis bypassing the scoring model | af3478c |
| 2026-04-09 | New `/analyze` Telegram command — quick trade stats from phone, includes post-age-filter breakdown | af3478c |
| 2026-04-09 | Kiro handoff created, full codebase reviewed | — |
| 2026-04-04 | Min pair age raised to 60m | 4acc01f |
| 2026-04-02 | Entry-data snapshots + version metadata | b751d20 |
| 2026-04-01 | Score-validation analysis tool | 3b951c4 |
| 2026-03-27 | Flow-deterioration penalty | cc8bf9f |
| 2026-03-25 | Helius holder concentration backstop | 764776f |
| 2026-03-24 | DexScreener-primary scoring rewrite | 27b35f8 |
