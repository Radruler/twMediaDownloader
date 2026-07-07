import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_TIMESTAMP,
  formatFilenameTimestamp,
  mediaBasename,
  mediaPrefixForType,
  sanitizeForFilename,
  sidecarBasename,
  standaloneRelativePath,
  tweetFileStem,
} from '../packages/core/src/filename.ts';

/**
 * Build an epoch from LOCAL date components — makes timestamp expectations
 * timezone-independent (the module formats in local time, matching the
 * legacy format_date behavior).
 */
function localEpoch(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

describe('mediaPrefixForType', () => {
  it('maps the legacy prefixes exactly', () => {
    expect(mediaPrefixForType('photo')).toBe('img');
    expect(mediaPrefixForType('animated_gif')).toBe('gif');
    expect(mediaPrefixForType('video')).toBe('vid');
  });
});

describe('formatFilenameTimestamp', () => {
  it('formats YYYYMMDD_hhmmss in local time with zero padding', () => {
    expect(formatFilenameTimestamp(localEpoch(2026, 7, 4, 21, 3, 11))).toBe('20260704_210311');
    expect(formatFilenameTimestamp(localEpoch(2026, 1, 5, 3, 7, 9))).toBe('20260105_030709');
    expect(formatFilenameTimestamp(localEpoch(2026, 12, 31, 23, 59, 59))).toBe('20261231_235959');
    expect(formatFilenameTimestamp(localEpoch(2026, 1, 1, 0, 0, 0))).toBe('20260101_000000');
  });

  it('returns the sentinel for null/undefined/NaN', () => {
    expect(formatFilenameTimestamp(null)).toBe(UNKNOWN_TIMESTAMP);
    expect(formatFilenameTimestamp(undefined)).toBe(UNKNOWN_TIMESTAMP);
    expect(formatFilenameTimestamp(Number.NaN)).toBe(UNKNOWN_TIMESTAMP);
    expect(formatFilenameTimestamp(Infinity)).toBe(UNKNOWN_TIMESTAMP);
    expect(UNKNOWN_TIMESTAMP).toBe('00000000_000000');
  });
});

describe('sanitizeForFilename', () => {
  it('replaces Windows-reserved characters with underscores', () => {
    expect(sanitizeForFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('replaces control characters (newlines, tabs, NUL, DEL)', () => {
    expect(sanitizeForFilename('line1\nline2')).toBe('line1_line2');
    expect(sanitizeForFilename('tab\there')).toBe('tab_here');
    expect(sanitizeForFilename('nul\u0000del\u007f')).toBe('nul_del_');
    expect(sanitizeForFilename('cr\rlf\n')).toBe('cr_lf_');
  });

  it('strips trailing dots and spaces (Windows silently drops them)', () => {
    expect(sanitizeForFilename('name.')).toBe('name');
    expect(sanitizeForFilename('name...')).toBe('name');
    expect(sanitizeForFilename('name ')).toBe('name');
    expect(sanitizeForFilename('name . . ')).toBe('name');
  });

  it('trims leading whitespace', () => {
    expect(sanitizeForFilename('  name')).toBe('name');
  });

  it('collapses to a single underscore when nothing survives', () => {
    expect(sanitizeForFilename('')).toBe('_');
    expect(sanitizeForFilename('...')).toBe('_');
    expect(sanitizeForFilename('   ')).toBe('_');
    expect(sanitizeForFilename('. .')).toBe('_');
  });

  it('defuses Windows reserved device names, case-insensitively', () => {
    expect(sanitizeForFilename('CON')).toBe('CON_');
    expect(sanitizeForFilename('con')).toBe('con_');
    expect(sanitizeForFilename('PRN')).toBe('PRN_');
    expect(sanitizeForFilename('aux')).toBe('aux_');
    expect(sanitizeForFilename('NUL')).toBe('NUL_');
    expect(sanitizeForFilename('COM1')).toBe('COM1_');
    expect(sanitizeForFilename('lpt9')).toBe('lpt9_');
    // Not reserved: COM10, CONSOLE, or names that merely contain them.
    expect(sanitizeForFilename('COM10')).toBe('COM10');
    expect(sanitizeForFilename('CONSOLE')).toBe('CONSOLE');
    expect(sanitizeForFilename('falcon')).toBe('falcon');
  });

  it('passes emoji, CJK, and RTL text through unchanged', () => {
    expect(sanitizeForFilename('🦊fox🎉')).toBe('🦊fox🎉');
    expect(sanitizeForFilename('日本語ユーザー')).toBe('日本語ユーザー');
    expect(sanitizeForFilename('مرحبا')).toBe('مرحبا');
    expect(sanitizeForFilename('עברית')).toBe('עברית');
  });

  it('neutralizes path traversal attempts', () => {
    expect(sanitizeForFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeForFilename('..\\..\\windows')).toBe('.._.._windows');
    expect(sanitizeForFilename('..')).toBe('_');
    expect(sanitizeForFilename('/')).toBe('_');
  });
});

const PARTS = {
  screen_name: 'furyutei',
  tweet_id: '1234567890123456789',
  created_at_ms: localEpoch(2026, 7, 4, 21, 3, 11),
};

describe('tweetFileStem', () => {
  it('joins screen_name, id, and local timestamp with hyphens', () => {
    expect(tweetFileStem(PARTS)).toBe('furyutei-1234567890123456789-20260704_210311');
  });

  it('uses "unknown" for a null screen_name', () => {
    expect(tweetFileStem({ ...PARTS, screen_name: null })).toBe(
      'unknown-1234567890123456789-20260704_210311',
    );
  });

  it('uses the sentinel timestamp when created_at_ms is null', () => {
    expect(tweetFileStem({ ...PARTS, created_at_ms: null })).toBe(
      'furyutei-1234567890123456789-00000000_000000',
    );
  });

  it('sanitizes a hostile DOM-fallback screen_name', () => {
    expect(
      tweetFileStem({ ...PARTS, screen_name: '../evil\nname?' }),
    ).toBe('.._evil_name_-1234567890123456789-20260704_210311');
  });
});

describe('mediaBasename', () => {
  it('builds the exact legacy media convention', () => {
    expect(mediaBasename(PARTS, { type: 'photo', index: 1 }, 'jpg')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img1.jpg',
    );
    expect(mediaBasename(PARTS, { type: 'photo', index: 3 }, 'png')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img3.png',
    );
    expect(mediaBasename(PARTS, { type: 'video', index: 1 }, 'mp4')).toBe(
      'furyutei-1234567890123456789-20260704_210311-vid1.mp4',
    );
    expect(mediaBasename(PARTS, { type: 'animated_gif', index: 2 }, 'mp4')).toBe(
      'furyutei-1234567890123456789-20260704_210311-gif2.mp4',
    );
  });

  it('accepts an extension with a leading dot', () => {
    expect(mediaBasename(PARTS, { type: 'photo', index: 1 }, '.webp')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img1.webp',
    );
  });

  it('falls back to .bin for an empty or hostile extension', () => {
    expect(mediaBasename(PARTS, { type: 'photo', index: 1 }, '')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img1.bin',
    );
    expect(mediaBasename(PARTS, { type: 'photo', index: 1 }, '...')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img1.bin',
    );
    expect(mediaBasename(PARTS, { type: 'photo', index: 1 }, 'j/pg')).toBe(
      'furyutei-1234567890123456789-20260704_210311-img1.j_pg',
    );
  });
});

describe('sidecarBasename', () => {
  it('builds txt and json sidecar names on the shared stem', () => {
    expect(sidecarBasename(PARTS, 'txt')).toBe(
      'furyutei-1234567890123456789-20260704_210311.txt',
    );
    expect(sidecarBasename(PARTS, 'json')).toBe(
      'furyutei-1234567890123456789-20260704_210311.json',
    );
  });
});

describe('standaloneRelativePath', () => {
  it('nests under twMediaDownloader/<screen_name>/ with forward slashes', () => {
    expect(standaloneRelativePath('furyutei', 'a.jpg')).toBe('twMediaDownloader/furyutei/a.jpg');
  });

  it('sanitizes the folder segment and handles null', () => {
    expect(standaloneRelativePath('e/vil', 'a.jpg')).toBe('twMediaDownloader/e_vil/a.jpg');
    expect(standaloneRelativePath(null, 'a.jpg')).toBe('twMediaDownloader/unknown/a.jpg');
    expect(standaloneRelativePath('..', 'a.jpg')).toBe('twMediaDownloader/_/a.jpg');
  });
});
