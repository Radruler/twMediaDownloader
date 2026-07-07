import { describe, expect, it, vi } from 'vitest';
import { createTweetCache, DEFAULT_MAX_SIZE } from '../extension/content/tweet-cache.js';

function record(id: string, extra: Record<string, unknown> = {}) {
  return { id_str: id, full_text: `tweet ${id}`, ...extra };
}

describe('tweet-cache', () => {
  it('implements the 00-overview contract: get / onUpdate / stats', () => {
    const cache = createTweetCache();
    expect(cache.get('nope')).toBeNull();

    const seen: Array<[string, unknown]> = [];
    const unsubscribe = cache.onUpdate((id: string, rec: unknown) => seen.push([id, rec]));

    const r1 = record('1');
    cache.put(r1);
    expect(cache.get('1')).toBe(r1);
    expect(seen).toEqual([['1', r1]]);

    unsubscribe();
    cache.put(record('2'));
    expect(seen).toHaveLength(1);

    const stats = cache.stats();
    expect(stats.size).toBe(2);
    // 1 miss ('nope') + 1 hit ('1')
    expect(stats.hitRate).toBeCloseTo(0.5);
  });

  it('newer capture wins for the same id', () => {
    const cache = createTweetCache();
    cache.put(record('1', { counts: { likes: 1 } }));
    cache.put(record('1', { counts: { likes: 99 } }));
    expect(cache.stats().size).toBe(1);
    expect((cache.get('1') as any).counts.likes).toBe(99);
  });

  it('evicts least-recently-used records past maxSize', () => {
    const cache = createTweetCache({ maxSize: 3 });
    cache.put(record('1'));
    cache.put(record('2'));
    cache.put(record('3'));
    cache.get('1'); // touch 1 so 2 is now the oldest
    cache.put(record('4'));
    expect(cache.get('2')).toBeNull();
    expect(cache.get('1')).not.toBeNull();
    expect(cache.get('3')).not.toBeNull();
    expect(cache.get('4')).not.toBeNull();
    expect(cache.stats().size).toBe(3);
  });

  it('defaults to the ~5000-record cap from plan 02 §4', () => {
    expect(DEFAULT_MAX_SIZE).toBe(5000);
  });

  it('ignores malformed records and survives throwing listeners', () => {
    const cache = createTweetCache();
    cache.put(null);
    cache.put({} as any);
    expect(cache.stats().size).toBe(0);

    cache.onUpdate(() => {
      throw new Error('broken consumer');
    });
    const ok = vi.fn();
    cache.onUpdate(ok);
    cache.put(record('1'));
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
