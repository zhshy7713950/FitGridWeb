# Grid Data Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver safe Android/Web JSON import preview, conflict handling, transactional commit reporting, and two-format export downloads.

**Architecture:** Add a typed data-transfer API boundary and model the import page as explicit select, preview, committing, and complete states. Keep file validation and UX in the browser while all record validation, owner scoping, conflict decisions, and calculations remain on the existing server endpoints.

**Tech Stack:** Next.js 16, React 19, TypeScript, native FormData/Blob APIs, CSS Modules, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-02-fitgridweb-remaining-frontend-and-android-import-design.md`

## Global Constraints

- Accept `.json` files no larger than exactly 10 MiB (`10 * 1024 * 1024` bytes).
- Default conflict policy is `skip`; `overwrite` requires explicit second confirmation.
- Import preview tokens expire after 15 minutes and are single-use.
- Never inspect, trust, or render imported ownerId, grid rows, or totals as authoritative data.
- Never commit the user's original Android JSON file.
- All data transfer is scoped to the current Better Auth session.
- Use `frontend-design` before changing production visual styles.

---

### Task 1: Reusable raw response API primitive

**Files:**
- Modify: `src/lib/api-client.ts`
- Modify: `src/lib/api-client.test.ts`

**Interfaces:**
- Consumes: `apiPath`, `browserUnauthorizedRedirect`.
- Produces: `requestResponse(path, init, onUnauthorized): Promise<Response>`; `requestJson` delegates to it without changing behavior.

- [ ] **Step 1: Write failing raw response tests**

```ts
it("returns an authenticated successful response without consuming its body", async () => {
  const response = new Response("download", { status: 200 });
  fetchMock.mockResolvedValue(response);
  expect(await requestResponse("/grid-trades/export?format=android")).toBe(response);
  expect(await response.text()).toBe("download");
});

it("maps a failed raw response to ClientApiError", async () => {
  fetchMock.mockResolvedValue(jsonResponse({ code: "REQUEST_FAILED", message: "失败" }, 500));
  await expect(requestResponse("/grid-trades/export?format=web")).rejects.toMatchObject({ status: 500, code: "REQUEST_FAILED" });
});
```

- [ ] **Step 2: Run the test and confirm the export is missing**

Run: `pnpm exec vitest run src/lib/api-client.test.ts`

Expected: FAIL because `requestResponse` is not exported.

- [ ] **Step 3: Extract response validation once**

```ts
export async function requestResponse(
  path: ApiRoute,
  init: RequestInit = {},
  onUnauthorized: () => void = browserUnauthorizedRedirect,
): Promise<Response> {
  const response = await fetch(apiPath(path), { ...init, credentials: "same-origin", headers: { Accept: "application/json", ...init.headers } });
  if (response.ok) return response;
  if (response.status === 401) onUnauthorized();
  throw await clientApiError(response);
}
```

Keep the existing login exception in the unauthorized condition, and make `requestJson<T>` call `requestResponse` before decoding JSON/204.

- [ ] **Step 4: Run API client tests**

Run: `pnpm exec vitest run src/lib/api-client.test.ts src/features/auth/login-api.test.ts`

Expected: PASS with unchanged JSON behavior.

- [ ] **Step 5: Commit the raw response primitive**

```bash
git add src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "refactor: expose authenticated response client"
```

### Task 2: Typed import and export API

**Files:**
- Create: `src/features/data-transfer/types.ts`
- Create: `src/features/data-transfer/data-transfer-api.ts`
- Create: `src/features/data-transfer/data-transfer-api.test.ts`

**Interfaces:**
- Consumes: `requestJson` and `requestResponse`.
- Produces: `previewImport(file)`, `commitImport(token, policy)`, and `downloadExport(format)`.

- [ ] **Step 1: Write failing request tests**

```ts
it("uploads exactly one file field", async () => {
  fetchMock.mockResolvedValue(jsonResponse(preview));
  await previewImport(new File(["[]"], "android.json", { type: "application/json" }));
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("POST");
  expect((init.body as FormData).getAll("file")).toHaveLength(1);
});

it("uses the content-disposition filename for a web backup", async () => {
  fetchMock.mockResolvedValue(new Response("{}", { headers: { "content-disposition": "attachment; filename=\"fitgridweb-web-2026-09-02.json\"" } }));
  const result = await downloadExport("web");
  expect(result.filename).toBe("fitgridweb-web-2026-09-02.json");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/data-transfer/data-transfer-api.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Define exact transfer DTOs**

```ts
export type ImportConflictPolicy = "skip" | "overwrite";
export type ImportPreviewItem = { index: number; productCode: string; warnings?: string[]; fieldErrors?: Record<string, string[]> };
export type ImportPreview = { previewToken: string; expiresAt: string; creates: ImportPreviewItem[]; conflicts: ImportPreviewItem[]; invalid: ImportPreviewItem[]; warnings: string[] };
export type ImportReport = { created: number; overwritten: number; skipped: number; invalid: number };
export type ExportDownload = { blob: Blob; filename: string };
```

- [ ] **Step 4: Implement API calls and safe filename parsing**

Use `FormData` without manually setting `Content-Type`, JSON for commit, and `/grid-trades/export?format=android|web` for download. Accept only the basename matching `/^fitgridweb-(android|web)-\d{4}-\d{2}-\d{2}\.json$/`; otherwise use `fitgridweb-${format}.json`.

```ts
export async function previewImport(file: File): Promise<ImportPreview> {
  const body = new FormData();
  body.append("file", file);
  return requestJson<ImportPreview>("/grid-trades/import/preview", { method: "POST", body });
}

export function commitImport(previewToken: string, conflictPolicy: ImportConflictPolicy) {
  return requestJson<ImportReport>("/grid-trades/import/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewToken, conflictPolicy }),
  });
}
```

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run src/features/data-transfer/data-transfer-api.test.ts`

Expected: PASS.

```bash
git add src/features/data-transfer/types.ts src/features/data-transfer/data-transfer-api.ts src/features/data-transfer/data-transfer-api.test.ts
git commit -m "feat: add import export browser api"
```

### Task 3: Import state machine and validation

**Files:**
- Create: `src/features/data-transfer/import-model.ts`
- Create: `src/features/data-transfer/import-model.test.ts`
- Create: `src/features/data-transfer/use-grid-import.ts`
- Create: `src/features/data-transfer/use-grid-import.test.tsx`
- Create: `src/server/import-export/fixtures/android-import-sanitized.json`
- Modify: `src/server/import-export/android-normalizer.test.ts`

**Interfaces:**
- Consumes: Task 2 API functions.
- Produces: `validateImportFile(file)`, `isPreviewExpired(preview, now)`, and `useGridImport()`.

- [ ] **Step 1: Write failing file and duplicate-action tests**

```ts
expect(validateImportFile(new File(["{}"], "data.txt"))).toBe("请选择 JSON 文件");
expect(validateImportFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "data.json"))).toBe("导入文件不能超过 10 MiB");
expect(isPreviewExpired({ ...preview, expiresAt: "2026-09-02T00:15:00.000Z" }, new Date("2026-09-02T00:15:00.000Z"))).toBe(true);
```

Hook test: call `commit("skip")` twice before the first promise resolves and assert `commitImport` is called once.

Add a server normalization regression using a one-product, fictionalized Android array that retains all 18 real export keys and a single fictional `gridItems` entry. Assert it is valid and emits “已忽略并重算 Android 派生字段”. Do not copy product names, codes, or values from the user's original file.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/data-transfer/import-model.test.ts src/features/data-transfer/use-grid-import.test.tsx`

Expected: FAIL because validation and hook modules are missing.

- [ ] **Step 3: Implement the explicit state contract**

```ts
type GridImportState =
  | { stage: "select"; error: string | null }
  | { stage: "previewing"; filename: string }
  | { stage: "preview"; filename: string; preview: ImportPreview; policy: ImportConflictPolicy; error: string | null }
  | { stage: "committing"; filename: string; preview: ImportPreview; policy: ImportConflictPolicy }
  | { stage: "complete"; report: ImportReport };
```

Expose `{ state, selectFile, setPolicy, commit, reset }`. Refuse `commit` when the preview is expired, retain preview on API failure, and reset to file selection after `IMPORT_PREVIEW_NOT_FOUND`.

- [ ] **Step 4: Run focused tests and commit**

Run: `pnpm exec vitest run src/features/data-transfer/import-model.test.ts src/features/data-transfer/use-grid-import.test.tsx`

Expected: PASS.

```bash
git add src/features/data-transfer/import-model.ts src/features/data-transfer/import-model.test.ts src/features/data-transfer/use-grid-import.ts src/features/data-transfer/use-grid-import.test.tsx src/server/import-export/fixtures/android-import-sanitized.json src/server/import-export/android-normalizer.test.ts
git commit -m "feat: add safe import state machine"
```

### Task 4: Import page UI

**Files:**
- Create: `src/features/data-transfer/import-workspace.tsx`
- Create: `src/features/data-transfer/data-transfer.module.css`
- Create: `src/features/data-transfer/import-workspace.test.tsx`
- Create: `src/app/(protected)/grids/import/page.tsx`

**Interfaces:**
- Consumes: `useGridImport()` from Task 3.
- Produces: the `/grids/import` workflow.

- [ ] **Step 1: Write failing workflow tests**

```tsx
it("defaults to skip and requires confirmation before overwrite", async () => {
  render(<ImportWorkspace controller={previewController} />);
  expect(screen.getByRole("radio", { name: /跳过冲突/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /覆盖冲突/ }));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  expect(screen.getByRole("dialog", { name: "确认覆盖现有产品" })).toBeInTheDocument();
  expect(previewController.commit).not.toHaveBeenCalled();
});
```

Also assert the preview renders counts for creates/conflicts/invalid/warnings and the completion view renders all four report counts.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/data-transfer/import-workspace.test.tsx`

Expected: FAIL because `ImportWorkspace` is missing.

- [ ] **Step 3: Implement all stages**

Use a labelled file input, four summary panels, expandable record lists using one-based display index (`item.index + 1`), a `skip/overwrite` radio group, and a centered busy overlay. The overwrite dialog must link to the Web backup action and require a second “确认覆盖并导入” click. Complete state links to `/grids`.

```tsx
<fieldset>
  <legend>冲突处理</legend>
  <label><input type="radio" name="policy" value="skip" checked={policy === "skip"} onChange={() => setPolicy("skip")} />跳过冲突（推荐）</label>
  <label><input type="radio" name="policy" value="overwrite" checked={policy === "overwrite"} onChange={() => setPolicy("overwrite")} />覆盖当前账号同代码产品</label>
</fieldset>
```

- [ ] **Step 4: Add the route and run tests**

```tsx
export default function ImportPage() { return <ImportWorkspace />; }
```

Run: `pnpm exec vitest run src/features/data-transfer/import-workspace.test.tsx src/app/base-path-routing.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the import page**

```bash
git add src/features/data-transfer/import-workspace.tsx src/features/data-transfer/data-transfer.module.css src/features/data-transfer/import-workspace.test.tsx src/app/'(protected)'/grids/import/page.tsx
git commit -m "feat: add android json import page"
```

### Task 5: Export dialog and list integration

**Files:**
- Create: `src/features/data-transfer/export-dialog.tsx`
- Create: `src/features/data-transfer/export-dialog.test.tsx`
- Modify: `src/features/grids/grid-workspace.tsx`
- Modify: `src/features/grids/grid-workspace.test.tsx`
- Modify: `src/features/grids/grid-workspace.module.css`

**Interfaces:**
- Consumes: `downloadExport(format)` from Task 2.
- Produces: `ExportDialog` that explains and downloads `android` or `web` format.

- [ ] **Step 1: Write failing export tests**

```tsx
it("explains both formats and blocks repeated download", async () => {
  const download = vi.fn(() => new Promise<ExportDownload>(() => undefined));
  render(<ExportDialog open onClose={vi.fn()} download={download} />);
  expect(screen.getByText(/重新导入安卓端/)).toBeInTheDocument();
  expect(screen.getByText(/服务器迁移和恢复/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "下载 Web 完整备份" }));
  expect(screen.getByRole("button", { name: "正在准备备份…" })).toBeDisabled();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run src/features/data-transfer/export-dialog.test.tsx`

Expected: FAIL because the dialog is missing.

- [ ] **Step 3: Implement safe browser download**

Create an object URL from the returned Blob, click an in-memory anchor with the safe filename, then call `URL.revokeObjectURL`. Show API errors without closing the dialog. Add “导入数据” linking to `/grids/import` and “数据备份” opening this dialog in the product-list heading and no-products empty state.

```ts
const { blob, filename } = await download(format);
const url = URL.createObjectURL(blob);
const anchor = document.createElement("a");
anchor.href = url;
anchor.download = filename;
anchor.click();
URL.revokeObjectURL(url);
```

- [ ] **Step 4: Run the full transfer gate**

Run: `pnpm exec vitest run src/lib/api-client.test.ts src/features/data-transfer src/features/grids/grid-workspace.test.tsx`

Expected: PASS.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm lint`

Expected: exit 0.

Run: `NEXT_PUBLIC_APP_BASE_PATH=/fitgrid pnpm build`

Expected: exit 0 and the build includes `/grids/import`.

- [ ] **Step 5: Commit exports and integration**

```bash
git add src/features/data-transfer/export-dialog.tsx src/features/data-transfer/export-dialog.test.tsx src/features/grids/grid-workspace.tsx src/features/grids/grid-workspace.test.tsx src/features/grids/grid-workspace.module.css
git commit -m "feat: add account data exports"
```
