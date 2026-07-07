/**
 * tweet-cache.js — isolated-world in-memory tweet store (plan 02 §4).
 *
 * Implements the module contract from docs/plans/00-overview.md:
 *   TweetCache.get(tweetId)  -> TweetRecord | null   (synchronous)
 *   TweetCache.onUpdate(cb)  -> unsubscribe fn; cb(tweetId, TweetRecord)
 *   TweetCache.stats()       -> { size, hitRate }
 *
 * LRU-capped (~5000 records ≈ 10 MB worst case). Newer capture wins — later
 * payloads carry fresher counts. Per-tab, per-navigation lifetime; no
 * persistence in v1 (the page re-fetches whatever it renders).
 */

export const DEFAULT_MAX_SIZE = 5000;

export function createTweetCache({ maxSize = DEFAULT_MAX_SIZE } = {}) {
  const records = new Map(); // insertion order doubles as recency order
  const listeners = new Set();
  let hits = 0;
  let misses = 0;

  return {
    get(tweetId) {
      const record = records.get(tweetId);
      if (record === undefined) {
        misses += 1;
        return null;
      }
      hits += 1;
      // refresh recency
      records.delete(tweetId);
      records.set(tweetId, record);
      return record;
    },

    /** Insert/replace a record (bridge-internal; UI code should only read). */
    put(record) {
      if (!record || typeof record.id_str !== 'string') return;
      records.delete(record.id_str);
      records.set(record.id_str, record);
      if (records.size > maxSize) {
        const oldest = records.keys().next().value;
        records.delete(oldest);
      }
      for (const listener of listeners) {
        try {
          listener(record.id_str, record);
        } catch (e) {
          // a broken consumer must not stop the feed for others
        }
      }
    },

    onUpdate(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    stats() {
      const lookups = hits + misses;
      return { size: records.size, hitRate: lookups === 0 ? 0 : hits / lookups };
    },
  };
}

/** The isolated-world singleton the UI/save/bulk layers consume. */
export const TweetCache = createTweetCache();
