const logger = require('./logger');

// Simple in-memory cache with TTL
class Cache {
  constructor() {
    this.store = new Map();
    // Cleanup expired entries every 60s
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      // Do NOT delete here — leave the expired entry in the store so that
      // getStale() can still retrieve it as a fallback when a fresh fetch
      // fails. Cleanup of truly old entries is handled by cleanup() which
      // respects the STALE_GRACE_MS window.
      return null;
    }
    return entry.value;
  }

  /**
   * Return the cached value even if expired (stale). Returns null only if the
   * key was never set. Used as a fallback when a fresh fetch fails — stale
   * data from a few minutes ago is better than no data.
   * Returns { value, ageMs, stale: boolean } or null.
   */
  getStale(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const now = Date.now();
    return {
      value: entry.value,
      ageMs: now - entry.createdAt,
      stale: now > entry.expiresAt,
    };
  }

  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    });
  }

  // Return value + age metadata. Returns { value, ageMs } or null.
  getWithMeta(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      // Don't delete — let cleanup() handle it (same as get())
      return null;
    }
    return { value: entry.value, ageMs: Date.now() - entry.createdAt };
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.store.delete(key);
  }

  cleanup() {
    const now = Date.now();
    const STALE_GRACE_MS = 10 * 60 * 1000; // keep stale entries for 10 min as fallback
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt + STALE_GRACE_MS) {
        this.store.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'Cache cleanup (stale grace: 10m)');
    }
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }

  shutdown() {
    clearInterval(this.cleanupInterval);
    this.clear();
  }
}

// TTL constants in milliseconds
const TTL = {
  AUTHORITY_CHECK: 10 * 60 * 1000,   // 10 min
  TOP_HOLDERS: 3 * 60 * 1000,         // 3 min
  HOLDER_COUNT: 2 * 60 * 1000,        // 2 min
  SLIPPAGE: 30 * 1000,                // 30 sec
  TOKEN_METADATA: 10 * 60 * 1000,     // 10 min
  MARKET_DATA: 60 * 1000,             // 1 min
  QUOTE: 15 * 1000,                   // 15 sec
};

// Global cache instance
const cache = new Cache();

module.exports = { cache, TTL, Cache };
