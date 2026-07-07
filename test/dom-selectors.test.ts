/**
 * Only the PURE parts of dom-selectors.js are tested — URL formats are
 * stable. The CSS selector candidates are UNVERIFIED-AGAINST-LIVE-DOM by
 * design and can only be validated by the owner in a real browser.
 */
import { describe, expect, it } from 'vitest';
import {
  tweetIdFromStatusPath,
  tweetIdFromViewerPath,
} from '../extension/content/dom-selectors.js';

describe('tweetIdFromViewerPath', () => {
  it('matches photo and video viewer URLs', () => {
    expect(tweetIdFromViewerPath('/furyutei/status/1234567890/photo/2')).toBe('1234567890');
    expect(tweetIdFromViewerPath('/furyutei/status/1234567890/video/1')).toBe('1234567890');
    expect(tweetIdFromViewerPath('/i/status/9876543210')).toBe('9876543210');
  });

  it('rejects non-viewer URLs', () => {
    expect(tweetIdFromViewerPath('/furyutei/status/1234567890')).toBeNull();
    expect(tweetIdFromViewerPath('/home')).toBeNull();
    expect(tweetIdFromViewerPath('/furyutei/media')).toBeNull();
    expect(tweetIdFromViewerPath('/search?q=status/123/photo/1')).toBeNull();
  });
});

describe('tweetIdFromStatusPath', () => {
  it('extracts the id from any status path, viewer or not', () => {
    expect(tweetIdFromStatusPath('/furyutei/status/42')).toBe('42');
    expect(tweetIdFromStatusPath('/furyutei/status/42/photo/1')).toBe('42');
    expect(tweetIdFromStatusPath('/i/status/42')).toBe('42');
    expect(tweetIdFromStatusPath('/home')).toBeNull();
  });
});
