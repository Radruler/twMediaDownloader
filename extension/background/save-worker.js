/**
 * save-worker.js — minimal service-worker addition for the save layer
 * (plan 04 §1). Bundled by build.mjs to dist/js/save-worker.js and
 * imported by the (dist-generated) background wrapper AFTER the legacy
 * js/background.js, which is untouched.
 *
 * Listens on a chrome.runtime.connect port named 'twmd-save' (ports don't
 * collide with the legacy onMessage listener, which answers every unknown
 * sendMessage synchronously). One frame in:
 *   { v: 1, type: 'save', items: [{ url, filename }] }
 * where url is a data: URL (media bytes were fetched by the content script
 * — this worker performs NO network requests) and filename is a
 * Downloads-relative path (twMediaDownloader/<screen_name>/<basename>).
 * One frame out:
 *   { v: 1, type: 'save_result', results: [{ filename, ok, downloadId | error }] }
 */

const SAVE_PORT_NAME = 'twmd-save';

function download(item) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(
        {
          url: item.url,
          filename: item.filename,
          saveAs: false,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            resolve({
              filename: item.filename,
              ok: false,
              error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'download failed',
            });
          } else {
            resolve({ filename: item.filename, ok: true, downloadId });
          }
        },
      );
    } catch (error) {
      resolve({ filename: item.filename, ok: false, error: String(error) });
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SAVE_PORT_NAME) return;
  port.onMessage.addListener(async (message) => {
    if (!message || message.v !== 1 || message.type !== 'save' || !Array.isArray(message.items)) {
      return;
    }
    const results = [];
    for (const item of message.items) {
      if (!item || typeof item.url !== 'string' || typeof item.filename !== 'string') {
        results.push({ filename: item && item.filename, ok: false, error: 'malformed item' });
        continue;
      }
      results.push(await download(item));
    }
    try {
      port.postMessage({ v: 1, type: 'save_result', results });
    } catch (error) {
      // port closed while downloading — downloads still happened; nothing to report to
    }
  });
});
