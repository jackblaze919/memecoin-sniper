const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('./config');
const helius = require('./apis/helius');
const logger = require('./logger');

let keypair = null;

function getKeypair() {
  if (keypair) return keypair;
  if (!config.solanaPrivateKey) {
    throw new Error('SOLANA_PRIVATE_KEY not configured');
  }
  try {
    const secretKey = bs58.decode(config.solanaPrivateKey);
    keypair = Keypair.fromSecretKey(secretKey);
    return keypair;
  } catch (err) {
    throw new Error(`Invalid SOLANA_PRIVATE_KEY: ${err.message}`);
  }
}

function getPublicKey() {
  return getKeypair().publicKey.toBase58();
}

async function getBalance() {
  const pubkey = getPublicKey();
  return helius.getBalance(pubkey);
}

async function hasMinimumBalance() {
  const balance = await getBalance();
  return balance > config.solReserve;
}

// Sign and send a Jupiter swap transaction
async function signAndSendTransaction(swapTransactionBase64) {
  const kp = getKeypair();
  const txBuf = Buffer.from(swapTransactionBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([kp]);
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  logger.info('Sending signed transaction');
  const signature = await helius.sendRawTransaction(serialized);
  logger.info({ signature }, 'Transaction sent');

  const confirmation = await helius.confirmTransaction(signature);
  if (!confirmation.confirmed) {
    logger.error({ signature, error: confirmation.error }, 'Transaction confirmation failed');
    return { success: false, signature, error: confirmation.error };
  }
  logger.info({ signature, slot: confirmation.slot }, 'Transaction confirmed');
  return { success: true, signature, slot: confirmation.slot };
}

module.exports = { getKeypair, getPublicKey, getBalance, hasMinimumBalance, signAndSendTransaction };
