# Task 5 report — export dialog and list integration

## Outcome

- Added an accessible `ExportDialog` with separate Android-compatible and Web-complete export actions.
- Explained that Android JSON supports Android re-import or compatible migration, Web backups support server migration and restore with stable metadata, and both formats contain only the current account's data.
- Added a synchronous ref lock before React state updates. While an export is pending, both download choices, the close action, Escape dismissal, and backdrop dismissal stay locked; an accessible progress status remains visible.
- Added safe browser download handling: the already-sanitized filename is assigned to an in-memory anchor, the anchor is appended/clicked/removed, and the object URL is revoked from `finally`, including anchor click failures.
- Kept the dialog open on errors, exposed public `ClientApiError` messages and request IDs, avoided Blob URL work when the API fails, and released the lock for retry.
- Added `导入数据` and `数据备份` to the product-list heading and account-empty state while keeping `新建产品` primary. Search-no-match still exposes only `清除搜索` inside its empty state.
- Prefixed new import links exactly once under `/fitgrid`. Existing six-column desktop and four-column mobile table behavior, refresh, pagination, and hidden algorithm version remain unchanged.
- Moved the already shared modal document-isolation helper from the grids feature into `src/lib/modal-isolation.ts`; import, detail, and row-inspector modal regression tests continue to pass.

## Design

- Preserved the established seven-color TradingView-style palette.
- Used two compact ruled format rows rather than cards, cobalt only for download actions, neutral explanatory copy, and red only for the error surface.
- Kept request IDs monospace and the modal responsive without gradients, glass treatments, KPI cards, or mobile bottom navigation.

## TDD evidence

RED was observed before production code:

- `src/features/data-transfer/export-dialog.test.tsx` failed because `./export-dialog` did not exist.
- Three `grid-workspace.test.tsx` integration tests failed because the heading/account-empty import and backup actions were absent.

GREEN coverage includes:

- both format explanations and current-account scope;
- synchronous repeat-click lock and disabled/progress state;
- Android and Web download dispatch;
- appended temporary-anchor lifecycle and safe filename assignment;
- object URL revocation and anchor removal after success and click failure;
- no URL/anchor/revoke work before a failed API returns a Blob;
- public API error and request ID rendering with retry unlock;
- full-document inert/`aria-hidden` isolation, focus trap/restore, and body-scroll restore;
- pending close/Escape/backdrop lock;
- heading, account-empty, search-empty, and `/fitgrid` link integration;
- existing import/grid-detail modal behavior after helper relocation.

## Verification

- Focused modal/workspace regressions: `56 passed`.
- Transfer gate: `pnpm exec vitest run src/lib/api-client.test.ts src/features/data-transfer src/features/grids/grid-workspace.test.tsx` — `86 passed`.
- Full suite with local server permission: `376 passed`, `1 PostgreSQL-gated skipped`.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `NEXT_BASE_PATH=/fitgrid pnpm build` — exit 0; route output includes `/grids/import`.
- The full suite included the desktop/mobile database-free browser smoke and it passed.

The initial sandboxed full-suite attempt could not bind `127.0.0.1` (`EPERM`); rerunning with local-server permission passed the complete suite.

## Fix round 1/5

- Removed manual `withBasePath("/grids/import")` calls from both `next/link` import actions. Next now receives the application-relative `/grids/import` route and applies its configured base path exactly once at runtime. The native API download link in `ImportWorkspace` continues to use `apiPath` and was not changed.
- Replaced the previous jsdom base-path assertion, which only observed the prop passed to `Link`, with two complementary checks:
  - a unit contract that both heading and account-empty `Link` instances receive `/grids/import`, even when the public base-path environment value is present;
  - a real Next dev + Playwright smoke under `NEXT_BASE_PATH=/fitgrid` that observes the final browser href in the heading and after deleting all demo products to reach the account-empty state.
- Hardened the repeat-download test so two native `click()` calls occur within one `act` batch. A mutation run with the synchronous ref guard removed failed with two download calls; restoring the guard returned the targeted test to green.

RED evidence:

- Corrected unit test received `/fitgrid/grids/import` instead of the required application-relative `/grids/import` for both `Link` instances.
- Real `/fitgrid` smoke received `/fitgrid/fitgrid/grids/import` instead of `/fitgrid/grids/import`.
- Lock mutation run received two download dispatches instead of one.

Round verification:

- Corrected unit/dialog tests: `25 passed`.
- Synchronous-lock targeted test after restoring the ref guard: `1 passed` (`6 skipped` by name filter).
- Real `NEXT_BASE_PATH=/fitgrid` browser smoke, including heading and account-empty final href checks: `1 passed`.
- Focused transfer, modal, workspace, and base-path regressions: `110 passed`.
- Full suite unchanged rerun: `376 passed`, `1 PostgreSQL-gated skipped`.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `NEXT_BASE_PATH=/fitgrid pnpm build` — exit 0; route output includes `/grids/import`.

The first full-suite run had one browser smoke timeout while waiting for the initial demo login navigation; the other `375` tests passed and the new href assertions had not run yet. The same smoke passed independently under `/fitgrid`, and the complete suite passed unchanged on rerun, so no unrelated timing change was added to this scoped fix.
