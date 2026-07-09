# archive/

Historical documents, preserved for reference. **Nothing in here is
current** — the plans were either completed, superseded, or deliberately
descoped during the 2026-07 consolidation.

Current documentation lives at:

- `README.md` — project state and how to build/run
- `ARCHITECTURE.md` — how the rebuilt system works today
- `docs/plans/00-overview.md` — binding decisions + remaining work sequence
- `docs/plans/*.md` — one plan per remaining piece of work

Contents:

| File | What it was | Why archived |
|---|---|---|
| `plans/00-overview.md` | Original modernization overview + Decisions Log | Superseded by the new `docs/plans/00-overview.md` (decisions rewritten, several overturned) |
| `plans/01-refactor.md` | Dead-code deletion + repo scaffold plan | Scaffold/tooling parts done; deletions deferred to `docs/plans/cleanup-plan.md` |
| `plans/02-network-capture.md` | GraphQL interception plan | **Done** (capture layer shipped) |
| `plans/03-ui.md` | Download-buttons-everywhere plan | Superseded by `docs/plans/extension-buttons-plan.md` (scope corrected: most buttons already exist) |
| `plans/04-metadata-sidecar.md` | Save layer / filenames / sidecars plan | **Done** (save layer shipped); bulk-ZIP section descoped with the bulk feature |
| `plans/05-alternative-architectures.md` | Architecture research (FSA, CDP, native messaging) | Research concluded; decisions absorbed |
| `plans/06-local-companion-app.md` | Companion app plan (protocol, DB, downloader, Electron UI) | M1/M2 **done**; UI milestones descoped — superseded by `docs/plans/content-manager-plan.md` |
| `plans/discussion-02-vs-05.md` | Architecture discussion record | Historical |
| `plans/step-2-handoff.md` | Capture-layer handoff notes | Content absorbed into `ARCHITECTURE.md` |
| `plans/step-3b5-handoff.md` | Save-layer + app M1/M2 handoff notes | Content absorbed into `ARCHITECTURE.md` and `docs/VERIFICATION.md` |
| `plans/PROGRESS.md` | Session-handoff checklist for the save-layer/app dispatch | All items completed; live status now lives in `docs/plans/00-overview.md` |
