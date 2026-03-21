# Memecoin Sniper

Solana memecoin edge-detection and auto-trading bot.

## Setup

```bash
npm install
cp .env.example .env
# Fill in your API keys in .env
```

## Database

Requires PostgreSQL. Set `DATABASE_URL` in `.env`, then:

```bash
npm run migrate
```

## Run

```bash
npm start
```

## Test Scripts

```bash
npm run test:health    # Full health check
npm run test:quote     # Jupiter quote test
npm run test:dex       # DexScreener API test
```

## Deploy to Railway

1. Push to GitHub
2. Connect repo in Railway
3. Add PostgreSQL plugin
4. Set environment variables
5. Deploy — `railway.json` handles migrate + start

## Trading Modes

Start in `scanner` mode (default). Progress through modes as you validate:

```
scanner → paper → tiny_live → live
```

Set `TRADING_MODE` and `DRY_RUN` in environment variables.

## Telegram Commands

`/status` `/stop` `/start` `/mode [mode]` `/positions` `/history` `/balance` `/stats` `/config` `/health` `/candidates`

## Schema Changes

Added to the base migration:
- `tokens`: `holder_count`, `liquidity_usd`, `market_cap_usd`, `price_usd`, `volume_24h` columns
- `positions`: `mode` column to track trading mode per position
- Additional indexes on `positions.entry_timestamp` and `trade_locks.date`
