/**
 * page-interceptor.js — MAIN world, document_start (plan 02 §2).
 *
 * Observes the page's OWN GraphQL responses by wrapping fetch and XHR, and
 * forwards matching bodies to the isolated world via CustomEvent (string
 * detail — objects don't cross the world boundary reliably in Firefox).
 *
 * HARD RULES (do not relax):
 *  - never issues, delays, or mutates any request or response
 *  - never throws into the page (everything is wrapped)
 *  - dependency-free, self-contained, boring
 */
(() => {
  'use strict';
  try {
    if (window.__twmdInterceptorInstalled) return;
    window.__twmdInterceptorInstalled = true;
  } catch (e) { /* fall through — worst case we patch twice, handlers are idempotent */ }

  var EVENT_NAME = 'twmd:graphql';
  var UNLISTED_EVENT_NAME = 'twmd:graphql-unlisted';
  var URL_RE = /\/i\/api\/graphql\/[^/]+\/(\w+)/;
  var MAX_BODY_CHARS = 8 * 1024 * 1024; // sanity cap; real payloads are ~100 KB
  // Operations known to contain tweet results. Unknown ops are forwarded
  // name-only (debug mode) so extending this list is easy when X renames things.
  var PASS_LIST = {
    TweetDetail: 1, TweetResultByRestId: 1, TweetResultsByRestIds: 1,
    UserTweets: 1, UserTweetsAndReplies: 1, UserMedia: 1,
    Likes: 1, Bookmarks: 1, SearchTimeline: 1,
    HomeTimeline: 1, HomeLatestTimeline: 1,
    ListLatestTweetsTimeline: 1, CommunityTweetsTimeline: 1,
  };

  function opFromUrl(url) {
    try {
      var m = URL_RE.exec(String(url));
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function debugEnabled() {
    try { return localStorage.getItem('twmd_debug') === '1'; } catch (e) { return false; }
  }

  function dispatch(name, detailObj) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detailObj) }));
    } catch (e) { /* never propagate into the page */ }
  }

  function handleBody(op, url, bodyText) {
    try {
      if (typeof bodyText !== 'string' || bodyText.length === 0) return;
      if (bodyText.length > MAX_BODY_CHARS) return;
      dispatch(EVENT_NAME, { v: 1, op: op, url: String(url), body: bodyText, ts: Date.now() });
    } catch (e) { /* swallow */ }
  }

  function handleResponse(url, bodyText) {
    var op = opFromUrl(url);
    if (!op) return;
    if (!PASS_LIST[op]) {
      if (debugEnabled()) dispatch(UNLISTED_EVENT_NAME, { v: 1, op: op, ts: Date.now() });
      return;
    }
    handleBody(op, url, bodyText);
  }

  // ---- fetch ----
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        var resultPromise = originalFetch.apply(this, arguments);
        try {
          var input = arguments[0];
          var requestUrl = '';
          if (typeof input === 'string') requestUrl = input;
          else if (input && typeof input.url === 'string') requestUrl = input.url;
          if (opFromUrl(requestUrl)) {
            resultPromise.then(function (response) {
              try {
                if (!response || !response.ok) return;
                response.clone().text().then(function (text) {
                  handleResponse(response.url || requestUrl, text);
                }, function () {});
              } catch (e) { /* swallow */ }
            }, function () {});
          }
        } catch (e) { /* swallow */ }
        return resultPromise; // the page always gets the untouched promise
      };
    }
  } catch (e) { /* swallow */ }

  // ---- XHR (the X client has alternated between fetch and XHR over time) ----
  try {
    var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (xhrProto && xhrProto.open && xhrProto.send) {
      var originalOpen = xhrProto.open;
      xhrProto.open = function () {
        try { this.__twmdUrl = String(arguments[1]); } catch (e) { /* swallow */ }
        return originalOpen.apply(this, arguments);
      };
      var originalSend = xhrProto.send;
      xhrProto.send = function () {
        try {
          var xhr = this;
          var url = xhr.__twmdUrl;
          if (url && opFromUrl(url)) {
            xhr.addEventListener('load', function () {
              try {
                if (xhr.status < 200 || xhr.status >= 300) return;
                var text = null;
                if (!xhr.responseType || xhr.responseType === 'text') text = xhr.responseText;
                else if (xhr.responseType === 'json' && xhr.response != null) text = JSON.stringify(xhr.response);
                if (text) handleResponse(url, text);
              } catch (e) { /* swallow */ }
            });
          }
        } catch (e) { /* swallow */ }
        return originalSend.apply(this, arguments);
      };
    }
  } catch (e) { /* swallow */ }
})();
