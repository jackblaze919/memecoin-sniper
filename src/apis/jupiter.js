const config = require('../config');
const logger = require('../logger');
const { retry, fetchWithTimeout } = require('../utils');

// lite-api.jup.ag is Jupiter's free-tier endpoint (no key required).
// api.jup.ag requires a paid API key from portal.jup.ag.
function getBaseUrl() {
  return config.jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
}

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// USDC mint address
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function getQuote({ inputMint, outputMint, amount, slippageBps = 300 }) {
  return retry(async () => {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
    });
    const url = `${getBaseUrl()}/swap/v1/quote?${params}`;
    const headers = { 'Accept': 'application/json' };
    if (config.jupiterApiKey) headers['X-API-KEY'] = config.jupiterApiKey;
    const res = await fetchWithTimeout(url, { headers }, 15000);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jupiter quote ${res.status}: ${text.substring(0, 200)}`);
    }
    const data = await res.json();
    return normalizeQuote(data);
  }, { maxRetries: 3, baseDelay: 1000, label: 'jupiter:quote' });
}

// SAFETY: No retry on swap POST. If it fails, caller must re-quote and retry explicitly.
// Blind retry could produce duplicate swap intents with different blockhashes.
async function getSwapTransaction({ quoteResponse, userPublicKey }) {
  const url = `${getBaseUrl()}/swap/v1/swap`;
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (config.jupiterApiKey) headers['X-API-KEY'] = config.jupiterApiKey;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { autoMultiplier: 2 },
      wrapAndUnwrapSol: true,
    }),
  }, 20000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jupiter swap ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  if (!data.swapTransaction) {
    throw new Error('Jupiter swap response missing swapTransaction');
  }
  return data;
}

// Test that Jupiter quote works (SOL -> USDC for 0.001 SOL)
async function testQuote() {
  const lamports = 1_000_000; // 0.001 SOL
  const quote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: lamports,
  });
  return quote;
}

function normalizeQuote(data) {
  if (!data) return null;
  return {
    inputMint: data.inputMint || null,
    outputMint: data.outputMint || null,
    inAmount: data.inAmount || '0',
    outAmount: data.outAmount || '0',
    priceImpactPct: parseFloat(data.priceImpactPct) || 0,
    slippageBps: data.slippageBps || 0,
    routePlan: data.routePlan || [],
    raw: data,
  };
}

module.exports = {
  getQuote,
  getSwapTransaction,
  testQuote,
  SOL_MINT,
  USDC_MINT,
};
