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
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.store.delete(key);
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'Cache cleanup');
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
