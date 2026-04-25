# Memecoin Sniper — Kiro Handoff

> Living document. Updated every time we make changes. Paste this into a new chat if context resets.

## Last Updated
2026-04-25 — Max-hold extended from 60m to 120m (v2.3). ChatGPT approved: exit is the binding constraint, not entry selection.

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

## Key Analysis Results

### Post-240m regime (290 trades, Apr 9–22) — CURRENT
- Win rate: 49.0% | Expectancy: **+0.0028 SOL/trade** | Total PnL: **+0.824 SOL**
- Avg winner: +34.1% | Avg loser: -21.6% | Stop-loss rate: 20.0%
- Buys/day: 20.7 | No pipeline starvation
- **CONCENTRATION RISK:** Apr 21 = +1.188 SOL (144% of total PnL). Without it, ~breakeven.
- $100k+ liquidity: 69.6% win rate, +54.9% avg PnL, 6.5% SL (46 trades)
- $25-100k liquidity: ~44% win rate, negative avg PnL, ~23% SL (240 trades)
- Vol/Liq 1.0+: 38.4% win rate, -7.5% avg PnL, 37.7% SL (high volume = bad)
- Threshold 72: +0.0052 SOL expectancy but halves volume
- Strongest raw signals: pair age (0.586), buy ratio 5m (0.573), liquidity (0.568)
- Strongest anti-signals: price impact (0.363), vol/liq ratio (0.386), all volume metrics

### Post-60m regime (96 trades, Apr 4–9) — HISTORICAL
- Win rate: 39.6% | Expectancy: -0.0031 SOL/trade
- Discovery AUC 0.607 (best), Flow 0.445 (anti), Mispricing 0.422 (anti)

### Pre-filter (117 trades, Mar 28–Apr 4) — HISTORICAL
- Win rate: 41.9% | Expectancy: +0.0002 SOL/trade (breakeven)
- Total score AUC 0.398 (anti-predictive)

## Current Experiment
**120-minute max-hold** (pending deploy, v2.3)
- Previous: 60m max-hold caused 95% of v2.2 exits, compressing avg winner to +5.1%
- Hypothesis: $100k+ tokens move slower, need more time for winners to develop
- Max-hold now configurable via MAX_HOLD_MINUTES env var (default 120)
- Strategy version bumped to 2.3
- No other changes: same $100k liq, same 240m age, same threshold 70, same weights, same stop-loss/partials
- Decision rule: if 120m expands winners without reopening major downside → keep. If ugly losses return → revert focus to Mispricing weight.

## Queued Next Moves (awaiting ChatGPT judgment)
1. ~~60m age filter~~ ✅ Done
2. ~~240m age filter~~ ✅ Done — strategy flipped to fragile-positive
3. **$100k liquidity filter** ← CURRENT (deploying now)
4. Collect clean post-$100k sample, analyze: expectancy, SL rate, trades/day, starvation check
5. CANDIDATE: Raise threshold to 72 (showed +0.0052 vs +0.0028 in 240m data)
6. CANDIDATE: Weight rebalance (component AUCs still unstable)
7. LONG-TERM: Simplify to age + liquidity + Discovery + Safety gate

## What NOT to Change Yet
- Don't rebalance weights — collect post-$100k data first
- Don't raise threshold to 72 — need post-$100k expectancy data
- Don't go tiny_live yet — need clean post-$100k sample to validate
- Don't go tiny_live
- One variable at a time — collect clean post-240m sample first
- Decision rule: if 240m improves expectancy and D still leads while F/M still hurt → rebalance weights. If expectancy stays flat/negative → consider simpler baseline model (age + liq + Discovery + Safety hard filter)

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
| 2026-04-25 | Extend max-hold from 60m to 120m (v2.3). Made configurable via MAX_HOLD_MINUTES env var. | pending |
| 2026-04-25 | Full v2.2 analysis: 21 trades, -0.0011 expect, 95% max-hold exits, avg winner +5.1% (collapsed from +34.1%). Filter works but max-hold is bottleneck. | — |
| 2026-04-24 | v2.2 sanity check: 11 trades, 0% SL, 0% fast deaths, but avg winner compressed to +3.2%. All max-hold exits. Too early to conclude. | — |
| 2026-04-22 | Liquidity sweep: $50k/$75k/$100k/$125k all tested. $100k chosen — 70% win, +0.0251 expect, 6% SL | — |
| 2026-04-22 | Raise MIN_LIQUIDITY_USD from $25k to $100k. Strategy version bumped to 2.2 | pending |
| 2026-04-22 | Full post-240m analysis: 290 trades, +0.0028 SOL expectancy, fragile-positive. $100k+ liq = 69.6% win rate. Awaiting ChatGPT judgment | — |
| 2026-04-10 | Fixed funnel logging bug — nested jsonb_set was silently failing, replaced with read-modify-write | — |
| 2026-04-10 | Post-240m analysis: 31 trades, win rate 48.4%, expectancy -0.0022 SOL (improved but still negative). PREMATURE — need 50+ trades | — |
| 2026-04-09 | Added pipeline funnel tracking + /funnel Telegram command (opportunity starvation detection) | — |
| 2026-04-09 | Raise min pair age from 60m to 240m (4h) — 60-120m bucket was 15% win rate | 3121627 |
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
