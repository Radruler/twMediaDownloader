/**
 * dom-selectors.js — EVERY live-DOM selector in one file (plan 03 §3).
 *
 * ⚠️  UNVERIFIED-AGAINST-LIVE-DOM ⚠️
 * These candidate lists were written 2026-07 from plan 03's table and
 * legacy-code inspection, in an environment with NO browser and NO x.com
 * session. NO selector below is trusted until the owner verifies it
 * against the live site (plan 03 §5 checklist). Treat every entry as a
 * starting hypothesis; record a "verified YYYY-MM-DD" note beside each
 * one as it's confirmed, and prune candidates that turn out dead.
 *
 * Shape: { candidates: [sel1, sel2, …], validate(el) } — X renames
 * data-testids rarely but reshuffles wrappers often, so ordered candidate
 * lists + a validation predicate beat single brittle chains.
 */

export const SELECTORS = {
  /** A rendered tweet (timeline, detail page, conversation). */
  tweetArticle: {
    candidates: [
      'article[data-testid="tweet"]', // UNVERIFIED (legacy-era testid)
      'article[role="article"]', // UNVERIFIED (broader fallback)
    ],
    validate: (el) => el.querySelector('div[role="group"]') !== null,
  },

  /** The reply/RT/like/… action row inside a tweet article. */
  actionRow: {
    candidates: [
      'div[role="group"][id]', // UNVERIFIED — detail-view action row has an id
      'div[role="group"]', // UNVERIFIED
    ],
    validate: (el) => el.querySelectorAll('button, a').length >= 3,
  },

  /** Permalink anchor inside an article — the tweet-id source in timelines. */
  permalinkTime: {
    candidates: [
      'a[href*="/status/"] time', // UNVERIFIED (existing legacy approach)
    ],
    validate: () => true,
  },

  /** The overlay root that hosts the photo/video viewer (plan 03 §1). */
  layersRoot: {
    candidates: ['div#layers'], // UNVERIFIED
    validate: () => true,
  },

  /** Action bar inside the media viewer overlay. */
  viewerActionRow: {
    candidates: [
      '#layers div[role="group"]', // UNVERIFIED
    ],
    validate: (el) => el.querySelectorAll('button, a').length >= 2,
  },

  /** Media elements inside one article (DOM-fallback media discovery). */
  tweetPhoto: {
    candidates: [
      'div[data-testid="tweetPhoto"] img', // UNVERIFIED
      'img[src*="pbs.twimg.com/media/"]', // UNVERIFIED (fallback)
    ],
    validate: () => true,
  },
};

/**
 * Query one configured surface: first candidate that yields validated
 * elements wins. Returns an array (possibly empty).
 */
export function queryAll(name, root = document) {
  const config = SELECTORS[name];
  if (!config) throw new Error(`unknown selector surface: ${name}`);
  for (const candidate of config.candidates) {
    let found;
    try {
      found = [...root.querySelectorAll(candidate)];
    } catch (e) {
      continue; // a candidate may be invalid on older engines — skip
    }
    const valid = found.filter((el) => {
      try {
        return config.validate(el);
      } catch (e) {
        return false;
      }
    });
    if (valid.length > 0) return valid;
  }
  return [];
}

export function queryFirst(name, root = document) {
  return queryAll(name, root)[0] ?? null;
}

// ---- URL-based tweet identification (pure; the ONLY trusted part of
// this file — URL formats are stable and covered by unit tests) ----

const VIEWER_PATTERNS = [
  /^\/[^/]+\/status\/(\d+)\/(?:photo|video)\/\d+/, // /<user>/status/<id>/photo/<n>
  /^\/i\/status\/(\d+)/, // immersive /i/status/<id>
];

/** Tweet id when the current URL is a media-viewer URL, else null. */
export function tweetIdFromViewerPath(pathname) {
  for (const pattern of VIEWER_PATTERNS) {
    const match = pattern.exec(pathname);
    if (match) return match[1];
  }
  return null;
}

/** Tweet id for any /status/ URL (viewer or plain detail page), else null. */
export function tweetIdFromStatusPath(pathname) {
  const match = /\/status\/(\d+)/.exec(pathname);
  return match ? match[1] : null;
}

/** Tweet id from an article's permalink anchor (timeline case), else null. */
export function tweetIdFromArticle(article) {
  const time = queryFirst('permalinkTime', article);
  const anchor = time ? time.closest('a[href*="/status/"]') : null;
  return anchor ? tweetIdFromStatusPath(anchor.getAttribute('href') ?? '') : null;
}
