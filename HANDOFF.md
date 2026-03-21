# Memecoin Sniper — Handoff

## What this is
A Solana memecoin edge-detection and auto-trading bot. It scans new tokens, scores them on momentum/flow/safety, and optionally buys when an edge is detected.

## Architecture
```
Scanner (DexScreener) → Ranker (Birdeye + Helius + Jupiter) → Executor (Jupiter swap) → Risk Manager
```

## Trading Modes
| Mode | Trades | Wallet | Max Position |
|------|--------|--------|-------------|
| scanner | No | No | N/A |
| paper | Simulated | No | Simulated |
| tiny_live | Real | Yes | 0.01 SOL, 1 position |
| live | Real | Yes | 0.05 SOL, 3 positions |

Default: `TRADING_MODE=scanner`, `DRY_RUN=true`

## Phase Progression
1. **Deploy scanner mode** — validate scanning, scoring, and Telegram alerts work
2. **Switch to paper mode** — validate full pipeline with simulated trades, review P&L
3. **Switch to tiny_live** — real trades with minimal exposure (0.01 SOL max)
4. **Switch to live** — full v1 limits after validating tiny_live results

## Safety Defaults
- DRY_RUN=true blocks all real swaps even in live mode
- 5 consecutive losses = 1 hour pause
- Daily loss limit: 0.1 SOL
- SOL reserve: 0.05 SOL (never trades below this)
- Same-day rebuy lock after loss on a token
- Idempotency locks prevent duplicate trades

## Schema Changes from Spec
- Added `holder_count`, `liquidity_usd`, `market_cap_usd`, `price_usd`, `volume_24h` columns to `tokens` for faster queries
- Added `mode` column to `positions` to track which trading mode created each position
- Added index on `positions.entry_timestamp` for time-range queries
- Added index on `trade_locks.date` for cleanup

## Key Decisions
- Birdeye field names are guarded with fallbacks since API may vary
- Helius mint/freeze authority parsing is isolated in `helius.parseMintAuthority()`
- Jupiter swap uses `dynamicComputeUnitLimit` and `autoMultiplier` for priority fees
- Scanner only uses DexScreener (no Birdeye calls in Stage 1)
- Cache TTLs match spec exactly

## External Services
| Service | Purpose | API Key Required |
|---------|---------|-----------------|
| DexScreener | Token discovery, market data | No |
| Jupiter | Quotes, swaps | No |
| Birdeye | Security, holders, overview | Yes |
| Helius | RPC, mint authority, metadata | Yes |
| Telegram | Commands, alerts | Yes |
| Resend | Daily email report | Optional |
