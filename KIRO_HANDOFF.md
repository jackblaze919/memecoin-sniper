# Memecoin Sniper — Kiro Handoff

> Living document. Updated every time we make changes. Paste this into a new chat if context resets.

## Last Updated
2026-05-25 — Deploying v2.4: filter-only model. Composite score removed from buy decisions. buyRatio5m + vol/liq are the new gates.

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

## Scoring Model — PROVEN DEAD WEIGHT
The composite D/F/M/S score adds zero discriminating power once filters are applied.
Offline harness proved: SIMPLE-filters (no score) produces byte-for-byte identical results to v2.3-control.
Every trade that passes liq+age+safety filters also passes the score threshold of 70.

**The filters ARE the strategy. The score is noise.**

| Component | Weight | Status |
|-----------|--------|--------|
| Discovery (D) | 25% | Weak positive in isolation, irrelevant in composite |
| Flow (F) | 30% | Anti-predictive |
| Mispricing (M) | 25% | Strongly anti-predictive |
| Safety (S) | 20% | Used as hard gate, not score |

### What actually predicts outcomes (offline harness, 525 trades)
| Signal | Evidence | Robust? |
|--------|----------|---------|
| buyRatio5m > 55% | Only signal positive in BOTH search and holdout | ✅ YES |
| Liquidity ≥ $125k | 68-70% win rate, 2% SL | ✅ YES |
| Pair age ≥ 240m | Killed fast-death failure mode | ✅ YES |
| Safety gate | Hard filter, not scored | ✅ YES |
| Composite score ≥ 70 | Zero additional filtering power | ❌ DEAD |

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
**v2.4 — Filter-only model (SIMPLE-br55+vlr)** (pending deploy)
- Composite score threshold REMOVED from buy decisions
- Buy eligibility now determined by:
  1. Safety gate passed
  2. Anti-FOMO not triggered
  3. buyRatio5m > 0.55 (configurable: MIN_BUY_RATIO_5M)
  4. vol/liq ratio < 1.0 (configurable: MAX_VOL_LIQ_RATIO)
- Scores still computed and logged in entry_data for analysis — just don't control buys
- Offline harness: +0.0097 holdout expect, 63.3% win, 4.2% SL, robust in both search+holdout
- v2.3 was conclusively negative: -0.376 SOL over 158 trades, 25% SL rate

## Queued Next Moves
1. ~~60m age filter~~ ✅
2. ~~240m age filter~~ ✅
3. ~~$100k liquidity filter~~ ✅
4. ~~120m max-hold~~ ✅ (v2.3 live)
5. **NEXT DEPLOY CANDIDATE: SIMPLE-125k+br55** — filter-only model:
   - Liquidity ≥ $125k, Age ≥ 240m, Safety gate, buyRatio5m > 55%
   - No composite score, no threshold
   - Holdout: 47 trades, 70.2% win, +0.0271 expect, 2.1% SL
   - Only variant robust in BOTH search and holdout
   - **DO NOT DEPLOY YET** — search N too thin (8 trades). Re-run harness in 1-2 weeks.
6. FALLBACK: $125k liq only (no buyRatio5m) if br5m signal fades
7. LONG-TERM: Drop composite score entirely from codebase

## What NOT to Change Yet
- Don't deploy SIMPLE-125k+br55 — search-period evidence too thin
- Don't raise threshold — composite score is dead weight anyway
- Don't rebalance weights — harness proved they don't matter
- Don't go tiny_live — concentration risk too high (top 3 days = 99% of PnL)

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
| 2026-05-25 | Deploy v2.4: filter-only model. buyRatio5m>0.55 + vol/liq<1.0. Composite score removed from buy decisions. | pending |
| 2026-05-24 | Full v2.3 analysis: 158 trades, -0.0024 expect, -0.376 SOL. 25% SL rate. Honeymoon over. | — |
| 2026-05-24 | Harness refresh: SIMPLE-br55+vlr is new robust leader (+0.0014 search, +0.0097 holdout, 4.2% SL) | — |
| 2026-04-29 | Simplified model comparison: buyRatio5m is the only robust signal. Composite score = dead weight. SIMPLE-125k+br55 is candidate next deploy. | — |
| 2026-04-29 | Added 8 simplified model variants to offline harness: filter-only, buyRatio5m thresholds, vol/liq filter, $125k combos | pending |
| 2026-04-29 | Offline experiment harness: 525 trades, 16 variants. Filters dominate; weights are noise. $125k liq is candidate next move. Concentration risk extreme. | de41db7 |
| 2026-04-25 | Built offline experiment harness (scripts/offline-experiment.js) — tests 16 variants with train/holdout split | pending |
| 2026-04-25 | Extend max-hold from 60m to 120m (v2.3). Made configurable via MAX_HOLD_MINUTES env var. | dc7cbc4 |
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
