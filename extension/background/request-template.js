/**
 * request-template.js — OBSERVATION-ONLY capture of the browser's own
 * media-request headers (plan 06 §2 request_template). Never modifies,
 * blocks, or initiates a request; just records what the page's own
 * pbs.twimg.com / video.twimg.com GETs look like so the companion app can
 * shape its CDN fetches identically.
 *
 * Cookies are excluded twice over: (1) Chrome's webRequest omits
 * Cookie/Authorization from requestHeaders unless the 'extraHeaders'
 * option is passed — we deliberately do NOT pass it; (2) credential-like
 * header names are filtered here anyway, and again in the app server.
 * Header VALUES are never logged.
 *
 * Content scripts read the latest template over the 'twmd-template' port.
 */

const TEMPLATE_PORT_NAME = 'twmd-template';
const STORAGE_KEY = 'twmd_request_template';

let latestTemplate = null; // { headers, observed_at }

function sanitize(requestHeaders) {
  const headers = {};
  for (const header of requestHeaders ?? []) {
    if (/cookie|authorization|auth[-_]?token|x-csrf/i.test(header.name)) continue;
    if (typeof header.value !== 'string') continue;
    headers[header.name] = header.value;
  }
  return headers;
}

try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.method !== 'GET') return;
      const headers = sanitize(details.requestHeaders);
      if (Object.keys(headers).length === 0) return;
      latestTemplate = { headers, observed_at: Date.now() };
      try {
        chrome.storage.session?.set({ [STORAGE_KEY]: latestTemplate });
      } catch (e) {
        /* storage.session may be unavailable — memory copy still works */
      }
    },
    { urls: ['*://pbs.twimg.com/*', '*://video.twimg.com/*'] },
    ['requestHeaders'],
  );
} catch (error) {
  console.log('[twmd] request-template observation unavailable:', error);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TEMPLATE_PORT_NAME) return;
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'get_template') return;
    let template = latestTemplate;
    if (!template) {
      try {
        const stored = await chrome.storage.session?.get(STORAGE_KEY);
        template = stored?.[STORAGE_KEY] ?? null;
      } catch (e) {
        template = null;
      }
    }
    try {
      port.postMessage({ type: 'template', template });
    } catch (e) {
      /* port closed */
    }
  });
});
