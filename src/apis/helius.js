const config = require('../config');
const logger = require('../logger');
const { retry, fetchWithTimeout } = require('../utils');

function getRpcUrl() {
  return config.solanaRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
}

// Standard JSON-RPC call via Helius
async function rpcCall(method, params = []) {
  return retry(async () => {
    const url = getRpcUrl();
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    }, 15000);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Helius RPC ${method} ${res.status}: ${text.substring(0, 200)}`);
    }
    const data = await res.json();
    if (data.error) {
      throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);
    }
    return data.result;
  }, { maxRetries: 3, baseDelay: 1000, label: `helius:${method}` });
}

async function getBalance(publicKey) {
  const result = await rpcCall('getBalance', [publicKey]);
  return (result?.value || 0) / 1e9; // Convert lamports to SOL
}

// Get token mint info to check freeze/mint authority
async function getAccountInfo(mintAddress) {
  try {
    const result = await rpcCall('getAccountInfo', [
      mintAddress,
      { encoding: 'jsonParsed' },
    ]);
    if (!result || !result.value) return null;
    return result.value;
  } catch (err) {
    logger.error({ err, mintAddress }, 'Helius getAccountInfo failed');
    return null;
  }
}

// Parse mint authority status from account info.
// Returns { parsed: true, ... } on success, { parsed: false } if data is missing/unparseable.
function parseMintAuthority(accountInfo) {
  try {
    if (!accountInfo || !accountInfo.data) return { parsed: false, mintAuthority: null, freezeAuthority: null };
    const p = accountInfo.data.parsed;
    if (!p || !p.info) return { parsed: false, mintAuthority: null, freezeAuthority: null };
    return {
      parsed: true,
      mintAuthority: p.info.mintAuthority || null,
      freezeAuthority: p.info.freezeAuthority || null,
      supply: p.info.supply || null,
      decimals: p.info.decimals || null,
      isInitialized: p.info.isInitialized ?? null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to parse mint authority');
    return { parsed: false, mintAuthority: null, freezeAuthority: null };
  }
}

// Helius DAS API for token metadata
async function getAsset(mintAddress) {
  if (!config.heliusApiKey) return null;
  try {
    return await retry(async () => {
      const url = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: { id: mintAddress },
        }),
      }, 15000);
      if (!res.ok) throw new Error(`Helius getAsset ${res.status}`);
      const data = await res.json();
      return data.result || null;
    }, { maxRetries: 2, baseDelay: 1000, label: 'helius:getAsset' });
  } catch (err) {
    logger.error({ err, mintAddress }, 'Helius getAsset failed');
    return null;
  }
}

// Fetch the 20 largest token accounts for a mint (standard Solana RPC, no DAS).
// Returns array of { address, amount, decimals, uiAmount, uiAmountString }.
async function getTokenLargestAccounts(mintAddress) {
  try {
    const result = await rpcCall('getTokenLargestAccounts', [mintAddress]);
    if (!result || !result.value) return null;
    return result.value;
  } catch (err) {
    logger.error({ err, mintAddress }, 'Helius getTokenLargestAccounts failed');
    return null;
  }
}

async function getTransaction(txSignature) {
  try {
    return await rpcCall('getTransaction', [
      txSignature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
  } catch (err) {
    logger.error({ err, txSignature }, 'Helius getTransaction failed');
    return null;
  }
}

// SAFETY: Never retry transaction broadcast. Send once, then confirm/reconcile.
// Retrying could rebroadcast a tx that was already received by the cluster.
async function sendRawTransaction(serializedTx) {
  const url = getRpcUrl();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendRawTransaction',
      params: [
        serializedTx,
        { skipPreflight: false, preflightCommitment: 'confirmed' },
      ],
    }),
  }, 30000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Helius sendRawTransaction ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Helius sendRawTransaction error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function confirmTransaction(signature, commitment = 'confirmed', timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await rpcCall('getSignatureStatuses', [[signature]]);
      const status = result?.value?.[0];
      if (status) {
        if (status.err) {
          return { confirmed: false, error: status.err };
        }
        if (status.confirmationStatus === commitment || status.confirmationStatus === 'finalized') {
          return { confirmed: true, slot: status.slot };
        }
      }
    } catch (err) {
      logger.warn({ err, signature }, 'Confirm check failed, retrying');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { confirmed: false, error: 'timeout' };
}

module.exports = {
  rpcCall,
  getBalance,
  getAccountInfo,
  parseMintAuthority,
  getAsset,
  getTokenLargestAccounts,
  getTransaction,
  sendRawTransaction,
  confirmTransaction,
  getRpcUrl,
};
