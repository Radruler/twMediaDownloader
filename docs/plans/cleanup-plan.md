# Cleanup — Plan (gated; run LAST)

**Gate (Decision 10):** nothing here may run until the rebuilt paths have
passed live verification (`docs/VERIFICATION.md`) and the button rewrite
(`extension-buttons-plan.md` phase 2) is verified on the surfaces the
owner uses. The old code is the working fallback until then — leave it
alone.

## Scope

1. **Delete dead legacy code** once its replacement is verified:
   - `src/deprecated/` (TweetDeck, packaging scripts, legacy userscript
     copies) — dead products, already excluded from `dist/`.
   - The dead API machinery in `src/js/`: OAuth stack
     (`twitter-oauth/`), `timeline.js` REST calls, `session.js`, and the
     API-attempt paths inside `main_react.user.js` superseded by the
     capture layer.
   - Legacy button/injection code in `main_react.user.js` after phase 2
     replaces it, plus the then-unused jQuery/decimal/JSZip vendored libs
     if nothing else imports them.
   - Cookie-logging debug code in `src/js/config.js` (`[xcom-xonly-debug]`
     patterns) — remove outright; its logging style must not be copied.
2. **Simplify the build**: once `src/` shrinks, fold what remains into a
   cleaner layout and drop the copy-then-patch manifest dance in
   `build.mjs` if it's no longer needed.
3. **Write `CLAUDE.md`**: build/test/verify commands (devcontainer),
   pointers to `ARCHITECTURE.md` and `docs/plans/00-overview.md`, the
   hard rules (no x.com requests, ports-not-sendMessage, core-only shared
   logic).
4. **README refresh** to whatever is true at that point. Keep the furyu
   attribution and history sections intact (MIT; original author credit
   is non-negotiable).

## Method

Delete in small verified steps: after each removal batch, full
`npm test && npm run typecheck && npm run build`, load `dist/` in Chrome,
and click through the owner's walkthrough for the affected feature before
the next batch. Keep each batch a single commit so any regression bisects
trivially.
