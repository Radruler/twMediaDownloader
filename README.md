twMediaDownloader
=================

- License: The MIT license
- Copyright (c) 2016 風柳(furyu) — original author; this fork is a rebuild
- Target browser: Google Chrome (Firefox best-effort later)

## Status (2026-07)

The original extension targeted APIs and UIs that no longer exist
(twitter.com REST endpoints, TweetDeck, the pre-2019 web UI). This fork is
rebuilding it as a **personal, passive X/Twitter archiving system**:

- **Capture** (done): a MAIN-world interceptor observes the page's *own*
  GraphQL responses — no request is ever sent to x.com by this project —
  and normalizes every tweet you scroll past into an in-memory cache.
- **Save layer** (done, pending live-browser verification): saves any
  cached tweet's media at original quality plus a metadata sidecar, using
  the original filename convention
  (`<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-img1.jpg` + `.txt`), into
  `Downloads/twMediaDownloader/<screen_name>/`.
- **Content manager** (core done; hardening in progress): a local Node
  service that receives everything captured over WebSocket, keeps a
  searchable SQLite library of everything seen, and archives selected
  posts to disk — polite CDN-only downloads, content-hash dedupe,
  edit-history and passive deleted-flagging.

How it works: `ARCHITECTURE.md`. Decisions and remaining work:
`docs/plans/00-overview.md`. How to verify: `docs/VERIFICATION.md`.
Historical plans: `archive/`.

The legacy extension code in `src/` still ships inside the built
extension and stays untouched until the rebuilt paths are verified live
(then: `docs/plans/cleanup-plan.md`). The bulk-ZIP download feature is
removed for now — its legacy API is dead; a library-driven replacement is
future work.

## Development

Current development and verification run in the devcontainer, not with
host `npm`. Dependencies and npm cache live in Docker volumes; build
outputs (`dist/`, `app/dist/`) are written into the checkout so Chrome can
load the extension from `dist/`.

```sh
docker compose -f .devcontainer/docker-compose.yml build app
docker compose -f .devcontainer/docker-compose.yml run --rm app npm ci
docker compose -f .devcontainer/docker-compose.yml run --rm app sh -lc 'npm test && npm run typecheck && npm run build'
```

To run the content-manager service for manual Chrome testing:

```sh
docker compose -f .devcontainer/docker-compose.yml up app
docker compose -f .devcontainer/docker-compose.yml exec app npm run app
```

The service listens on `127.0.0.1:8465`; its config, pairing token, SQLite
library, and archive root live in the `twmd-app-data` Docker volume. On
first run it prints the pairing token — set it in the extension via
`localStorage.twmd_app_token` (options-page UI is planned). No token =
the extension runs fully standalone.

Install: build, then load `dist/` unpacked via `chrome://extensions`
(Developer mode). This fork is self-distributed — the store listings below
belong to the original, now-defunct versions.

---

## Original README (historical — the versions below no longer work)

Everything below documents furyu's original twMediaDownloader for the
pre-2023 Twitter, preserved for attribution and history.

■ インストール方法
---
### Chrome 拡張機能版
Google Chrome で、

> [Twitter メディアダウンローダ― - Chrome ウェブストア](https://chrome.google.com/webstore/detail/twitter-media-downloader/cblpjenafgeohmnjknfhpdbdljfkndig?hl=ja)

より拡張機能を追加する。


### Firefox Quantum (WebExtentions)版
Firefox Quantum で、

> [Twitter メディアダウンローダ – Firefox 向けアドオン](https://addons.mozilla.org/ja/firefox/addon/tw-media-downloader/)

よりアドオンを追加する。


### ユーザースクリプト版
Firefox＋<s>[Greasemonkey](https://addons.mozilla.org/ja/firefox/addon/greasemonkey/)</s>[Tampermonkey](https://addons.mozilla.org/ja/firefox/addon/tampermonkey/)、Google Chrome＋[Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=ja) の環境で、

> [Twitter Media Downloader for new Twitter.com 2019](http://furyutei.github.io/twMediaDownloader/src/js/main_react.user.js)

> [Twitter Media Downloader for TweetDeck](http://furyutei.github.io/twMediaDownloader/src/js/main_tweetdeck.user.js)

> [Twitter Media Downloader for old Twitter.com (twMediaDownloader.user.js)](https://furyutei.work/userjs/furyutei/twMediaDownloader.user.js)

をクリックし、指示に従ってインストール。
※ Firefox では Quantum(57) + Greasemonkey 4 より動作しなくなった（代わりに Tampermonkey を使用すること）。


■ 使い方
---
[Web 版公式 Twitter](https://twitter.com/) 上で、ユーザータイムラインや検索タイムラインを開くと、「メディア↓」のようなリンクが挿入される。
![下向き矢印のリンク](https://cdn-ak.f.st-hatena.com/images/fotolife/f/furyu-tei/20160723/20160723224518.jpg)

これをクリックするとダイアログが表示されるので、[開始]ボタンをクリックすると、原寸画像/動画の ZIP 化が開始される。
※ ZIP 化の進捗は、下部にログ出力される。
![ダイアログ](https://cdn-ak2.f.st-hatena.com/images/fotolife/f/furyu-tei/20171029/20171029090641.png)

ZIP 化が完了するか、もしくは[停止]を押すと、対象となる画像/動画ファイルをまとめた ZIP ファイルがダウンロードされる。
※ ログの内容も ZIP の中に保存される。

必要に応じて、保存対象となるツイートの Tweet ID 範囲、および、ツイートの制限数を指定可能。
※デフォルト(範囲空白)の状態では、Tweet ID 範囲は全てで、ツイートの制限数にのみ制限される。

また、各メディア付ツイートにもダウンロード用のリンクが追加され、個別にダウンロードすることも可能。
※ Chrome 拡張機能の場合、この機能は ON/OFF できる。


■ 外部ライブラリなど
---
- [jQuery](https://jquery.com/), [jquery/jquery: jQuery JavaScript Library](https://github.com/jquery/jquery)
    [License | jQuery Foundation](https://jquery.org/license/)
    [The MIT License](https://tldrlegal.com/license/mit-license)

- [JSZip](https://stuk.github.io/jszip/)
    Copyright (c) 2009-2014 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso
    [The MIT License](https://github.com/Stuk/jszip/blob/master/LICENSE.markdown)

- [MikeMcl/decimal.js: An arbitrary-precision Decimal type for JavaScript](https://github.com/MikeMcl/decimal.js)
    Copyright (c) 2016, 2017 Michael Mclaughlin
    [The MIT Licence](https://github.com/MikeMcl/decimal.js/blob/master/LICENCE.md)

- [lambtron/chrome-extension-twitter-oauth-example: Chrome Extension Twitter Oauth Example](https://github.com/lambtron/chrome-extension-twitter-oauth-example)
    Copyright (c) 2017 Andy Jiang
    [The MIT Licence](https://github.com/lambtron/chrome-extension-twitter-oauth-example/blob/master/LICENSE)

- [sha1.js](http://pajhome.org.uk/crypt/md5/sha1.html)
    Copyright Paul Johnston 2000 - 2009
    The BSD License

- [oauth.js](http://code.google.com/p/oauth/source/browse/code/javascript/oauth.js)(^1)
    Copyright 2008 Netflix, Inc.
    [The Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)
    (^1) archived: [oauth.js](https://web.archive.org/web/20130921042751/http://code.google.com/p/oauth/source/browse/code/javascript/oauth.js)

- [jsTwitterOAuth/twitter-api.js](https://github.com/furyutei/jsTwitterOAuth/blob/master/src/js/twitter-oauth/twitter-api.js)
    Copyright (c) 2018 風柳 (furyu)
    [MIT License](https://github.com/furyutei/jsTwitterOAuth/blob/master/LICENSE)


■ 関連記事
---
- [Twitter メディアダウンローダ：ユーザータイムラインの原寸画像をまとめてダウンロードするユーザースクリプト(PC用Google Chrome・Firefox等対応) - 風柳メモ](http://furyu.hatenablog.com/entry/20160723/1469282864)
- [Twitter 原寸びゅー：Twitterの原寸画像を開くGoogle Chrome拡張機能＆ユーザースクリプト公開 - 風柳メモ](http://furyu.hatenablog.com/entry/20160116/1452871567)
