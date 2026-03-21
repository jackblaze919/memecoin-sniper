const db = require('../db');
const logger = require('../logger');

async function upsert(token) {
  const { address, symbol, name, pairAddress, totalScore, discoveryScore, flowScore,
    mispricingScore, safetyScore, antiFomoRejected, antiFomoReason,
    safetyGatePassed, holderCount, liquidityUsd, marketCapUsd, priceUsd, volume24h, data } = token;

  await db.query(`
    INSERT INTO tokens (address, symbol, name, pair_address, total_score, discovery_score,
      flow_score, mispricing_score, safety_score, anti_fomo_rejected, anti_fomo_reason,
      safety_gate_passed, holder_count, liquidity_usd, market_cap_usd, price_usd, volume_24h,
      last_scored_at, data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18)
    ON CONFLICT (address) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
      name = COALESCE(EXCLUDED.name, tokens.name),
      pair_address = COALESCE(EXCLUDED.pair_address, tokens.pair_address),
      total_score = COALESCE(EXCLUDED.total_score, tokens.total_score),
      discovery_score = COALESCE(EXCLUDED.discovery_score, tokens.discovery_score),
      flow_score = COALESCE(EXCLUDED.flow_score, tokens.flow_score),
      mispricing_score = COALESCE(EXCLUDED.mispricing_score, tokens.mispricing_score),
      safety_score = COALESCE(EXCLUDED.safety_score, tokens.safety_score),
      anti_fomo_rejected = COALESCE(EXCLUDED.anti_fomo_rejected, tokens.anti_fomo_rejected),
      anti_fomo_reason = EXCLUDED.anti_fomo_reason,
      safety_gate_passed = COALESCE(EXCLUDED.safety_gate_passed, tokens.safety_gate_passed),
      holder_count = COALESCE(EXCLUDED.holder_count, tokens.holder_count),
      liquidity_usd = COALESCE(EXCLUDED.liquidity_usd, tokens.liquidity_usd),
      market_cap_usd = COALESCE(EXCLUDED.market_cap_usd, tokens.market_cap_usd),
      price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
      volume_24h = COALESCE(EXCLUDED.volume_24h, tokens.volume_24h),
      last_scored_at = NOW(),
      data = COALESCE(tokens.data, '{}'::jsonb) || COALESCE(EXCLUDED.data, '{}'::jsonb)
  `, [address, symbol, name, pairAddress, totalScore, discoveryScore, flowScore,
    mispricingScore, safetyScore, antiFomoRejected != null ? antiFomoRejected : null, antiFomoReason || null,
    safetyGatePassed != null ? safetyGatePassed : null, holderCount, liquidityUsd, marketCapUsd, priceUsd, volume24h,
    JSON.stringify(data || {})]);
}

async function getByAddress(address) {
  const result = await db.query('SELECT * FROM tokens WHERE address = $1', [address]);
  return result.rows[0] || null;
}

async function getCandidates(limit = 50) {
  const result = await db.query(`
    SELECT * FROM tokens
    ORDER BY total_score DESC NULLS LAST, last_scored_at DESC NULLS LAST
    LIMIT $1
  `, [limit]);
  return result.rows;
}

async function getBuyEligible(scoreThreshold = 70) {
  const result = await db.query(`
    SELECT * FROM tokens
    WHERE total_score >= $1
      AND safety_gate_passed = true
      AND anti_fomo_rejected = false
    ORDER BY total_score DESC
  `, [scoreThreshold]);
  return result.rows;
}

async function deleteOldest(keepCount = 50) {
  await db.query(`
    DELETE FROM tokens WHERE address IN (
      SELECT address FROM tokens
      ORDER BY COALESCE(total_score, 0) ASC, first_seen_at ASC
      OFFSET $1
    )
  `, [keepCount]);
}

async function count() {
  const result = await db.query('SELECT COUNT(*) as cnt FROM tokens');
  return parseInt(result.rows[0].cnt);
}

module.exports = { upsert, getByAddress, getCandidates, getBuyEligible, deleteOldest, count };
