/**
 * Fixture-driven tests for the normalizer (plan 02 §3: "testing is the point
 * of this module").
 *
 * Two layers:
 *  1. Full-output lock: every fixture in test/fixtures/graphql/ is normalized
 *     and deep-compared against expected/<fixture>.json. Regenerate expected
 *     files deliberately with `npm run update-expected` and review the diff.
 *  2. Hand-written assertions for the behaviors that matter most (so a bug in
 *     the generation step can't self-certify).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePayload, tweetIdFromEntryId } from '@twmd/core';
import type { NormalizeResult, TweetRecord } from '@twmd/core';

/** Must match scripts/update-expected.mjs. */
const FIXED_CAPTURED_AT = 1751900000000;

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/graphql');
const fixtureFiles = readdirSync(fixturesDir).filter((f: string) => f.endsWith('.json'));

function loadFixture(name: string): { payload: any; op: string } {
  const payload = JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
  return { payload, op: payload.__fixture.op };
}

function normalizeFixture(name: string): NormalizeResult {
  const { payload, op } = loadFixture(name);
  return normalizePayload(payload, op, FIXED_CAPTURED_AT);
}

function tweetById(result: NormalizeResult, id: string): TweetRecord {
  const tweet = result.tweets.find((t) => t.id_str === id);
  expect(tweet, `tweet ${id} should be in the normalized output`).toBeDefined();
  return tweet!;
}

describe('full-output lock against expected/', () => {
  it('has at least the operation coverage the plan demands', () => {
    const ops = new Set(fixtureFiles.map((f: string) => loadFixture(f).op));
    for (const op of [
      'TweetDetail',
      'UserTweets',
      'UserMedia',
      'Likes',
      'Bookmarks',
      'SearchTimeline',
      'HomeTimeline',
      'TweetResultByRestId',
    ]) {
      expect(ops, `missing a fixture for ${op}`).toContain(op);
    }
  });

  for (const file of fixtureFiles) {
    it(file, () => {
      const expected = JSON.parse(
        readFileSync(path.join(fixturesDir, 'expected', file), 'utf8'),
      );
      expect(normalizeFixture(file)).toEqual(expected);
    });
  }
});

describe('TweetDetail conversation', () => {
  const result = normalizeFixture('TweetDetail.synthetic.json');

  it('caches the main tweet and the reply as full records', () => {
    expect(result.tweets.map((t) => t.id_str).sort()).toEqual([
      '1800000000000000001',
      '1800000000000000002',
    ]);
  });

  it('expands urls and strips the trailing media t.co link', () => {
    const main = tweetById(result, '1800000000000000001');
    expect(main.full_text).toBe(
      'Testing #fixtures with @synth_two and https://example.com/article plus two photos',
    );
    expect(main.urls).toEqual([
      { short: 'https://t.co/LINKAAA1', expanded: 'https://example.com/article' },
    ]);
    expect(main.hashtags).toEqual(['fixtures']);
    expect(main.mentions).toEqual(['synth_two']);
  });

  it('normalizes multi-photo media with 1-based index', () => {
    const main = tweetById(result, '1800000000000000001');
    expect(main.media).toEqual([
      {
        type: 'photo',
        media_key: '3_1800000000000000101',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/SYN-AAA111.jpg',
        alt_text: 'First synthetic photo',
        video_variants: [],
        width: 2048,
        height: 1536,
        duration_ms: null,
      },
      {
        type: 'photo',
        media_key: '3_1800000000000000102',
        index: 2,
        image_url: 'https://pbs.twimg.com/media/SYN-AAA222.jpg',
        alt_text: null,
        video_variants: [],
        width: 600,
        height: 800,
        duration_ms: null,
      },
    ]);
  });

  it('reads user fields from core (main) and legacy (reply) locations', () => {
    expect(tweetById(result, '1800000000000000001').user).toEqual({
      id_str: '9000000001',
      screen_name: 'synthfan',
      name: 'Synth Fan',
    });
    expect(tweetById(result, '1800000000000000002').user).toEqual({
      id_str: '9000000002',
      screen_name: 'synth_two',
      name: 'Synth Two',
    });
  });

  it('keeps all video variants including HLS (bitrate null), selection happens at save time', () => {
    const reply = tweetById(result, '1800000000000000002');
    expect(reply.media).toHaveLength(1);
    const video = reply.media[0];
    expect(video.type).toBe('video');
    expect(video.duration_ms).toBe(30124);
    expect(video.video_variants).toHaveLength(3);
    expect(video.video_variants[0]).toEqual({
      bitrate: null,
      content_type: 'application/x-mpegURL',
      url: 'https://video.twimg.com/ext_tw_video/1800000000000000201/pu/pl/SYN-VID001.m3u8?tag=12',
    });
    expect(Math.max(...video.video_variants.map((v) => v.bitrate ?? -1))).toBe(2176000);
  });

  it('records reply threading and counts', () => {
    const reply = tweetById(result, '1800000000000000002');
    expect(reply.in_reply_to_status_id_str).toBe('1800000000000000001');
    expect(reply.conversation_id_str).toBe('1800000000000000001');
    const main = tweetById(result, '1800000000000000001');
    expect(main.counts).toEqual({
      replies: 2,
      retweets: 5,
      likes: 42,
      quotes: 1,
      bookmarks: 4,
      views: 12345,
    });
  });

  it('parses created_at to epoch ms', () => {
    expect(tweetById(result, '1800000000000000001').created_at_ms).toBe(
      Date.parse('2024-07-01T12:34:56Z'),
    );
  });

  it('emits a tombstone event with the tweet id derived from the thread entryId', () => {
    expect(result.tombstones).toEqual([
      {
        tweet_id: '1800000000000000003',
        entry_id: 'conversationthread-1800000000000000001-tweet-1800000000000000003',
        typename: 'TweetTombstone',
        text: 'This Post was deleted by the Post author. Learn more',
        source_op: 'TweetDetail',
        captured_at_ms: FIXED_CAPTURED_AT,
      },
    ]);
  });
});

describe('UserTweets: pin entry and retweet recursion', () => {
  const result = normalizeFixture('UserTweets.synthetic.json');

  it('caches pinned tweet, outer RT, inner original, and the plain tweet', () => {
    expect(result.tweets.map((t) => t.id_str).sort()).toEqual([
      '1800000000000000010',
      '1800000000000000011',
      '1800000000000000012',
      '1800000000000000013',
    ]);
  });

  it('links the outer RT to the inner tweet, cached under its own id', () => {
    const outer = tweetById(result, '1800000000000000011');
    expect(outer.retweeted_status_id_str).toBe('1800000000000000012');
    const inner = tweetById(result, '1800000000000000012');
    expect(inner.retweeted_status_id_str).toBeNull();
    expect(inner.user.screen_name).toBe('synth_orig');
    expect(inner.full_text).toBe('Original content worth resharing today');
    expect(inner.counts.likes).toBe(55);
  });

  it('handles a Japanese text-only tweet (no media, no views loss)', () => {
    const plain = tweetById(result, '1800000000000000013');
    expect(plain.lang).toBe('ja');
    expect(plain.media).toEqual([]);
    expect(plain.hashtags).toEqual(['朝活', 'テスト']);
    expect(plain.counts.views).toBe(42);
  });
});

describe('UserMedia: grid modules and animated_gif', () => {
  const result = normalizeFixture('UserMedia.synthetic.json');

  it('finds tweets both in module entries and TimelineAddToModule moduleItems', () => {
    expect(result.tweets.map((t) => t.id_str).sort()).toEqual([
      '1800000000000000020',
      '1800000000000000021',
    ]);
  });

  it('normalizes animated_gif with its bitrate-0 mp4 variant', () => {
    const gifTweet = tweetById(result, '1800000000000000020');
    expect(gifTweet.media).toEqual([
      {
        type: 'animated_gif',
        media_key: '16_1800000000000000220',
        index: 1,
        image_url: 'https://pbs.twimg.com/tweet_video_thumb/SYN-GIF001.jpg',
        alt_text: 'Looping synthetic animation',
        video_variants: [
          {
            bitrate: 0,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/tweet_video/SYN-GIF001.mp4',
          },
        ],
        width: 480,
        height: 270,
        duration_ms: null,
      },
    ]);
  });
});

describe('Likes: visibility wrapper and sensitivity', () => {
  const result = normalizeFixture('Likes.synthetic.json');

  it('unwraps TweetWithVisibilityResults', () => {
    const wrapped = tweetById(result, '1800000000000000030');
    expect(wrapped.user.screen_name).toBe('synth_nsfw');
    expect(wrapped.is_sensitive).toBe(true);
    expect(wrapped.media[0].type).toBe('video');
    expect(wrapped.counts.views).toBe(555000);
  });

  it('records null views when X does not expose a count', () => {
    expect(tweetById(result, '1800000000000000031').counts.views).toBeNull();
  });
});

describe('Bookmarks: note_tweet long-form post', () => {
  const result = normalizeFixture('Bookmarks.synthetic.json');
  const note = () => tweetById(result, '1800000000000000040');

  it('prefers note_tweet text over truncated legacy full_text, with note urls expanded', () => {
    expect(note().full_text).toContain('https://example.com/long-form-article');
    expect(note().full_text).not.toContain('https://t.co/NOTEURL01');
    expect(note().full_text).not.toContain('…');
    expect(note().full_text.length).toBeGreaterThan(280);
    expect(note().hashtags).toEqual(['longform']);
  });

  it('still reads media from legacy.extended_entities on a note tweet', () => {
    expect(note().media).toHaveLength(1);
    expect(note().media[0].image_url).toBe('https://pbs.twimg.com/media/SYN-NOTE01.jpg');
  });
});

describe('SearchTimeline: quote-RT recursion', () => {
  const result = normalizeFixture('SearchTimeline.synthetic.json');

  it('caches outer and quoted tweets, linked by quoted_status_id_str', () => {
    const outer = tweetById(result, '1800000000000000050');
    expect(outer.quoted_status_id_str).toBe('1800000000000000051');
    expect(outer.media).toEqual([]);
    const quoted = tweetById(result, '1800000000000000051');
    expect(quoted.media[0].image_url).toBe('https://pbs.twimg.com/media/SYN-QUO001.jpg');
    expect(quoted.user.screen_name).toBe('synth_orig');
  });
});

describe('HomeTimeline: user field locations', () => {
  const result = normalizeFixture('HomeTimeline.synthetic.json');

  it('reads core-only users (2025 shape)', () => {
    expect(tweetById(result, '1800000000000000060').user).toEqual({
      id_str: '9000000006',
      screen_name: 'core_only',
      name: 'Core Only User',
    });
    expect(tweetById(result, '1800000000000000060').counts.views).toBe(2400000);
  });

  it('reads legacy-only users (older shape)', () => {
    expect(tweetById(result, '1800000000000000061').user).toEqual({
      id_str: '9000000007',
      screen_name: 'legacy_only',
      name: 'Legacy Only User',
    });
  });
});

describe('TweetResultByRestId: single-tweet envelope and edits', () => {
  it('normalizes a tweet without timeline instructions', () => {
    const result = normalizeFixture('TweetResultByRestId.synthetic.json');
    const tweet = tweetById(result, '1800000000000000071');
    expect(tweet.in_reply_to_status_id_str).toBe('1800000000000000002');
    expect(tweet.source_op).toBe('TweetResultByRestId');
  });

  it('maps edit_control_initial to the FIRST version id (logical-post key)', () => {
    const result = normalizeFixture('TweetResultByRestId.synthetic.json');
    expect(tweetById(result, '1800000000000000071').edit_initial_id_str).toBe(
      '1800000000000000070',
    );
  });

  it('unedited tweets carry their own id as edit_initial_id_str', () => {
    const result = normalizeFixture('TweetDetail.synthetic.json');
    expect(tweetById(result, '1800000000000000001').edit_initial_id_str).toBe(
      '1800000000000000001',
    );
  });

  it('emits an id-less tombstone for TweetUnavailable outside a timeline', () => {
    const result = normalizeFixture('TweetResultByRestId-tombstone.synthetic.json');
    expect(result.tweets).toEqual([]);
    expect(result.tombstones).toEqual([
      {
        tweet_id: null,
        entry_id: null,
        typename: 'TweetUnavailable',
        text: null,
        source_op: 'TweetResultByRestId',
        captured_at_ms: FIXED_CAPTURED_AT,
      },
    ]);
  });
});

describe('unified_card media fallback', () => {
  it('extracts card media when entities have none (media_extractor port)', () => {
    const result = normalizeFixture('TweetDetail-unified-card.synthetic.json');
    const tweet = tweetById(result, '1800000000000000080');
    expect(tweet.media).toEqual([
      {
        type: 'photo',
        media_key: '3_1800000000000000280',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/SYN-CARD01.jpg',
        alt_text: null,
        video_variants: [],
        width: 800,
        height: 418,
        duration_ms: null,
      },
    ]);
    expect(tweet.full_text).toBe('Check out this product! https://example.com/product');
  });
});

describe('real captures (owner-provided, 2026-07-07)', () => {
  it('TweetDetail: full thread with note_tweets, quotes, gif, unified_card ad', () => {
    const result = normalizeFixture('TweetDetail.captured.json');
    expect(result.tweets).toHaveLength(40);

    // long-form thread tweet: note text wins, t.co expanded away
    const note = tweetById(result, '2074185351304724498');
    expect(note.full_text.length).toBeGreaterThan(280);
    expect(note.full_text).not.toContain('https://t.co/');
    expect(note.full_text).toContain('https://www.anthropic.com/research/global-workspace');
    expect(note.user).toEqual({
      id_str: '1353836358901501952',
      screen_name: 'AnthropicAI',
      name: 'Anthropic',
    });

    // reply quoting another tweet
    expect(tweetById(result, '2074217766937133545').quoted_status_id_str).toBe(
      '1918892808447902117',
    );

    // animated_gif reply
    expect(tweetById(result, '2074293189087809661').media[0].type).toBe('animated_gif');

    // promoted tweet whose only media lives in the unified_card binding value
    const ad = tweetById(result, '2071641433703162359');
    expect(ad.media).toHaveLength(1);
    expect(ad.media[0]).toMatchObject({
      type: 'photo',
      media_key: '3_2071641069922787328',
      image_url: 'https://pbs.twimg.com/media/HL_yk7rboAAJ7YP.jpg',
    });

    // thread-head video keeps every variant, HLS included
    const head = tweetById(result, '2074185348142280912');
    expect(head.media[0].type).toBe('video');
    expect(head.media[0].video_variants.length).toBeGreaterThanOrEqual(3);
    expect(head.media[0].video_variants.some((v) => v.bitrate === null)).toBe(true);
  });

  it('UserTweets: 2026 "timeline" envelope (not timeline_v2), pin entry, RT-of-a-quote', () => {
    const result = normalizeFixture('UserTweets.captured.json');
    expect(result.tweets).toHaveLength(40);

    // RT of a quote tweet: both relationships on the outer record
    const rtOfQuote = tweetById(result, '2074133008806813915');
    expect(rtOfQuote.retweeted_status_id_str).toBe('2073871778544312635');
    expect(rtOfQuote.quoted_status_id_str).toBe('2072490311163535857');
    // ...and both inner tweets are cached under their own ids
    expect(tweetById(result, '2073871778544312635').user.screen_name).toBe('_Stocko_');
    expect(tweetById(result, '2072490311163535857').media[0].type).toBe('photo');
  });

  it('UserMedia: media-grid modules normalize per tweet', () => {
    const result = normalizeFixture('UserMedia.captured.json');
    expect(result.tweets).toHaveLength(11);
    expect(tweetById(result, '2074082943123751161').media[0].type).toBe('photo');
  });

  it('Likes: single liked tweet in the 2026 envelope', () => {
    const result = normalizeFixture('Likes.captured.json');
    expect(result.tweets.map((t) => t.id_str)).toEqual(['2074285269436809704']);
  });

  it('Bookmarks: an empty timeline (cursors only) yields empty results', () => {
    expect(normalizeFixture('Bookmarks-empty.captured.json')).toEqual({
      tweets: [],
      tombstones: [],
    });
  });
});

describe('robustness', () => {
  it('returns empty results for junk payloads instead of throwing', () => {
    expect(normalizePayload(null, 'TweetDetail')).toEqual({ tweets: [], tombstones: [] });
    expect(normalizePayload('nonsense', 'TweetDetail')).toEqual({ tweets: [], tombstones: [] });
    expect(normalizePayload({ data: { errors: [{ message: 'x' }] } }, 'TweetDetail')).toEqual({
      tweets: [],
      tombstones: [],
    });
    expect(normalizePayload({ data: { user: { result: null } } }, 'UserTweets')).toEqual({
      tweets: [],
      tombstones: [],
    });
  });

  it('falls back to snowflake math when created_at is missing or unparsable', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '1800000000000000001',
            legacy: { full_text: 'no created_at here', id_str: '1800000000000000001' },
          },
        },
      },
    };
    const { tweets } = normalizePayload(payload, 'TweetResultByRestId', FIXED_CAPTURED_AT);
    const expected = Number((1800000000000000001n >> 22n) + 1288834974657n);
    expect(tweets[0].created_at_ms).toBe(expected);
  });

  it('derives tombstone ids from entry ids', () => {
    expect(tweetIdFromEntryId('tweet-123')).toBe('123');
    expect(tweetIdFromEntryId('conversationthread-1-tweet-456')).toBe('456');
    expect(tweetIdFromEntryId('profile-grid-0-tweet-789')).toBe('789');
    expect(tweetIdFromEntryId('cursor-bottom-42')).toBeNull();
    expect(tweetIdFromEntryId(null)).toBeNull();
  });
});
