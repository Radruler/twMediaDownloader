/**
 * ui-buttons.js — step-3a injection framework SKELETON (plan 03 §3/§4).
 *
 * ⚠️  UNVERIFIED-AGAINST-LIVE-DOM — scaffolding only. ⚠️
 * The observer/scan/dedupe/state machinery here is real and follows the
 * plan (single debounced MutationObserver, batched scans, data-twmd
 * dedupe marker, SPA URL hooks), but it stands on dom-selectors.js whose
 * selectors are UNVERIFIED. Enabled only behind
 * localStorage.twmd_experimental_buttons = '1' until the owner has walked
 * plan 03 §5's checklist on live x.com. The 3a agent owns finishing this:
 * icon/spinner styling to match X's action row, toasts, theme detection,
 * media-viewer surface, quoted-tweet exclusion.
 */

import { queryAll, queryFirst, tweetIdFromArticle, tweetIdFromViewerPath } from './dom-selectors.js';

const MARKER_ATTR = 'data-twmd';
const SCAN_DEBOUNCE_MS = 300;

const ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';

/**
 * Create the injector. `onDownload(tweetId)` must return a promise
 * resolving to { ok, ... } (extension/content/save.js saveTweet fits).
 */
export function createButtonInjector({ onDownload, log = () => {} }) {
  let observer = null;
  let scanTimer = null;
  let unpatchHistory = null;

  function makeButton(tweetId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(MARKER_ATTR, 'button');
    button.title = 'Download media + sidecar (twMediaDownloader)';
    button.style.cssText =
      'background:none;border:none;cursor:pointer;color:inherit;' +
      'display:inline-flex;align-items:center;padding:6px;border-radius:9999px';
    button.innerHTML = ICON_SVG;
    let busy = false; // re-entrancy guard (plan 03 §4)
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      busy = true;
      button.style.opacity = '0.5';
      try {
        // Re-read the URL at click time for viewer buttons (SPA nav).
        const id = tweetId ?? tweetIdFromViewerPath(location.pathname);
        const result = id ? await onDownload(id) : { ok: false, error: 'no tweet id' };
        button.style.opacity = '';
        button.style.color = result.ok ? 'limegreen' : 'crimson';
        setTimeout(() => {
          button.style.color = '';
        }, 1500);
        if (!result.ok) log('download failed:', result.error ?? result);
      } catch (error) {
        button.style.opacity = '';
        button.style.color = 'crimson';
        log('download crashed:', error);
      } finally {
        busy = false;
      }
    });
    return button;
  }

  function injectIntoArticle(article) {
    if (article.hasAttribute(MARKER_ATTR)) return; // dedupe (recycled nodes re-scan cheaply)
    const tweetId = tweetIdFromArticle(article);
    const actionRow = queryFirst('actionRow', article);
    if (!tweetId || !actionRow) return; // leave unmarked — retry on a later pass
    article.setAttribute(MARKER_ATTR, 'seen');
    actionRow.appendChild(makeButton(tweetId));
  }

  function injectIntoViewer() {
    const tweetId = tweetIdFromViewerPath(location.pathname);
    if (!tweetId) return;
    const row = queryFirst('viewerActionRow');
    if (!row || row.hasAttribute(MARKER_ATTR)) return;
    row.setAttribute(MARKER_ATTR, 'seen');
    // null tweetId → button re-reads the URL at click time (Decision 5:
    // always all media of the post; /photo/<n> only identifies the tweet).
    row.appendChild(makeButton(null));
  }

  function scan() {
    try {
      for (const article of queryAll('tweetArticle')) injectIntoArticle(article);
      injectIntoViewer();
    } catch (error) {
      log('scan error:', error);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  return {
    start() {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
      // SPA URL changes don't always mutate where we watch — hook history.
      const wrap = (fn) =>
        function wrapped(...args) {
          const result = fn.apply(this, args);
          scheduleScan();
          return result;
        };
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = wrap(origPush);
      history.replaceState = wrap(origReplace);
      const onPop = () => scheduleScan();
      window.addEventListener('popstate', onPop);
      unpatchHistory = () => {
        history.pushState = origPush;
        history.replaceState = origReplace;
        window.removeEventListener('popstate', onPop);
      };
      scan();
      log('experimental button injector started (UNVERIFIED selectors)');
    },
    stop() {
      observer?.disconnect();
      observer = null;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      unpatchHistory?.();
      unpatchHistory = null;
    },
  };
}
