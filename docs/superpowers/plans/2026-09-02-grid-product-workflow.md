# Grid Product Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete create, edit, detail, row inspection, recalculate, and delete workflow for an owner's grid products on desktop and mobile.

**Architecture:** Keep server calculation authoritative and place browser concerns in focused `src/features/grids` modules. Pages are thin route adapters; typed API functions feed client state machines, and presentational components receive explicit state and callbacks so they can be tested without a database.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, CSS Modules, Vitest, Testing Library, Playwright Core.

**Spec:** `docs/superpowers/specs/2026-09-02-fitgridweb-remaining-frontend-and-android-import-design.md`

## Global Constraints

- Preserve the TradingView-inspired dark, dense financial workspace already used by the login and list pages.
- Do not display `algorithmVersion` in ordinary UI.
- Do not implement the grid algorithm in browser code; render only API calculation results.
- Do not accept or send `ownerId`.
- Mobile uses a top bar/menu, never a fixed bottom navigation.
- All links and API requests must work with both base paths `""` and `"/fitgrid"`.
- Every mutation disables duplicate submission and preserves useful state after failure.
- Use `frontend-design` before changing production visual styles.

---

### Task 1: Typed grid detail and mutation API

**Files:**
- Modify: `src/features/grids/types.ts`
- Modify: `src/features/grids/grid-api.ts`
- Modify: `src/features/grids/grid-api.test.ts`

**Interfaces:**
- Consumes: `requestJson<T>(path, init)` from `src/lib/api-client.ts`.
- Produces: `GridTradeMutationInput`, `GridTradeDetail`, `GridItem`, `getGridTrade`, `createGridTrade`, `updateGridTrade`, `deleteGridTrade`, and `recalculateGridTrade`.

- [ ] **Step 1: Write failing API tests**

```ts
it("sends the optimistic-lock timestamp when updating", async () => {
  fetchMock.mockResolvedValue(jsonResponse(detail));
  await updateGridTrade("11111111-1111-4111-8111-111111111111", {
    ...validInput,
    expectedUpdatedAt: "2026-09-02T00:00:00.000Z",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/grid-trades/11111111-1111-4111-8111-111111111111",
    expect.objectContaining({ method: "PATCH" }),
  );
});

it("uses POST for authoritative recalculation", async () => {
  fetchMock.mockResolvedValue(jsonResponse(detail));
  await recalculateGridTrade("11111111-1111-4111-8111-111111111111");
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/recalculate"),
    expect.objectContaining({ method: "POST" }),
  );
});
```

- [ ] **Step 2: Run the tests and confirm the missing exports fail**

Run: `pnpm exec vitest run src/features/grids/grid-api.test.ts`

Expected: FAIL because detail and mutation functions are not exported.

- [ ] **Step 3: Add exact browser DTOs**

```ts
export interface GridTradeMutationInput {
  productName: string | null;
  productCode: string;
  maxPrice: string;
  minTradeQuantity: string;
  gearAmplitude: string;
  perShare: string;
  keepShare: number;
  increaseAmplitude: number;
  mediumAmplitude: number | null;
  bigAmplitude: number | null;
  maxAmplitude: number;
  isShort: boolean;
  category: string | null;
  sortOrder: number;
}

export interface GridItem {
  sequence: number;
  gridType: 1 | 2 | 3;
  gear: string;
  buyPrice: string;
  buyCount: string;
  buyAmount: string;
  sellPrice: string;
  sellCount: string;
  sellAmount: string;
  profitAmount: string;
  profitRate: string;
  keepProfit: string;
  keepCount: string;
}

export interface GridTradeDetail extends GridTradeSummary {
  input: GridTradeMutationInput & { algorithmVersion: "android-v2.1.0" };
  calculation: {
    items: GridItem[];
    totalBuyAmount: string;
    totalProfitAmount: string;
    totalProfitRate: string;
  };
}
```

- [ ] **Step 4: Implement the API functions**

```ts
export function getGridTrade(id: string, signal?: AbortSignal) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, { signal });
}

export function createGridTrade(input: GridTradeMutationInput) {
  return requestJson<GridTradeDetail>("/grid-trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateGridTrade(id: string, input: GridTradeMutationInput & { expectedUpdatedAt: string }) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteGridTrade(id: string) {
  return requestJson<void>(`/grid-trades/${id}`, { method: "DELETE" });
}

export function recalculateGridTrade(id: string) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}/recalculate`, { method: "POST" });
}
```

- [ ] **Step 5: Run the focused tests**

Run: `pnpm exec vitest run src/features/grids/grid-api.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the typed API slice**

```bash
git add src/features/grids/types.ts src/features/grids/grid-api.ts src/features/grids/grid-api.test.ts
git commit -m "feat: add grid detail mutation api"
```

### Task 2: Form model and validation

**Files:**
- Create: `src/features/grids/grid-form-model.ts`
- Create: `src/features/grids/grid-form-model.test.ts`

**Interfaces:**
- Consumes: `GridTradeMutationInput` from Task 1.
- Produces: `GridFormValues`, `defaultGridFormValues`, `detailToFormValues`, and `validateGridForm(values)` returning `{ input?: GridTradeMutationInput; fieldErrors: Record<string, string[]> }`.

- [ ] **Step 1: Write failing validation tests**

```ts
it("clears long-only values before a short submission", () => {
  const result = validateGridForm({ ...defaultGridFormValues, isShort: true, keepShare: "2", mediumAmplitude: "15", bigAmplitude: "30" });
  expect(result.input).toMatchObject({ isShort: true, keepShare: 0, mediumAmplitude: null, bigAmplitude: null });
});

it("rejects a maximum amplitude above one hundred", () => {
  const result = validateGridForm({ ...defaultGridFormValues, maxAmplitude: "101" });
  expect(result.fieldErrors.maxAmplitude).toContain("最大振幅必须介于 1 和 100 之间");
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `pnpm exec vitest run src/features/grids/grid-form-model.test.ts`

Expected: FAIL because `grid-form-model.ts` does not exist.

- [ ] **Step 3: Implement defaults and deterministic conversion**

```ts
export const defaultGridFormValues: GridFormValues = {
  productName: "",
  productCode: "",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: "2",
  increaseAmplitude: "5",
  mediumAmplitude: "15",
  bigAmplitude: "30",
  maxAmplitude: "60",
  isShort: false,
  category: "",
  sortOrder: "0",
};
```

Implement decimal validation with `/^(?:0|[1-9]\d*)(?:\.\d+)?$/`, integer validation with `/^-?\d+$/`, trim text values, enforce every range from `02-functional-spec.md`, and return no `input` when any field error exists.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm exec vitest run src/features/grids/grid-form-model.test.ts`

Expected: PASS for defaults, trim, positive decimals, integer ranges, and short-mode clearing.

- [ ] **Step 5: Commit the form model**

```bash
git add src/features/grids/grid-form-model.ts src/features/grids/grid-form-model.test.ts
git commit -m "feat: add grid form validation model"
```

### Task 3: Reusable product form and route pages

**Files:**
- Create: `src/features/grids/grid-form.tsx`
- Create: `src/features/grids/grid-form.module.css`
- Create: `src/features/grids/grid-form.test.tsx`
- Create: `src/features/grids/grid-form-page.tsx`
- Create: `src/app/(protected)/grids/new/page.tsx`
- Create: `src/app/(protected)/grids/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: Task 1 API functions and Task 2 form model.
- Produces: `GridForm`, `NewGridFormPage`, and `EditGridFormPage`.

- [ ] **Step 1: Write failing component tests**

```tsx
it("hides long-only controls when direction changes to short", async () => {
  render(<GridForm initialValues={defaultGridFormValues} submitLabel="创建产品" onSubmit={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "做空" }));
  expect(screen.queryByLabelText("留存份数")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("中网幅度")).not.toBeInTheDocument();
});

it("blocks a second save while the first save is pending", async () => {
  const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
  render(<GridForm initialValues={validFormValues} submitLabel="创建产品" onSubmit={onSubmit} />);
  await user.click(screen.getByRole("button", { name: "创建产品" }));
  await user.click(screen.getByRole("button", { name: "正在保存…" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the component test and confirm failure**

Run: `pnpm exec vitest run src/features/grids/grid-form.test.tsx`

Expected: FAIL because `GridForm` is missing.

- [ ] **Step 3: Implement the form component**

Use controlled string inputs, three semantic fieldsets, a two-button direction control with `aria-pressed`, inline `role="alert"` field messages, and this submit contract:

```ts
type GridFormProps = {
  initialValues: GridFormValues;
  submitLabel: string;
  onSubmit(input: GridTradeMutationInput): Promise<void>;
  serverFieldErrors?: Record<string, string[]>;
  formError?: string | null;
};
```

Register `beforeunload` only while values differ from the initial snapshot. The cancel link must call `window.confirm("尚有未保存的修改，确定离开吗？")` before navigation.

- [ ] **Step 4: Implement thin new/edit page controllers**

```tsx
export function NewGridFormPage() {
  const router = useRouter();
  return <GridForm initialValues={defaultGridFormValues} submitLabel="创建产品" onSubmit={async (input) => {
    const created = await createGridTrade(input);
    router.push(`/grids/${created.id}`);
  }} />;
}
```

For edit, fetch with `getGridTrade(id)`, derive values with `detailToFormValues`, and append `expectedUpdatedAt: detail.updatedAt` to `updateGridTrade`. Map `ClientApiError.fieldErrors` to controls and show `EDIT_CONFLICT` as “产品已在其他页面更新，请重新载入后再编辑”。

- [ ] **Step 5: Add App Router adapters**

```tsx
export default function NewGridPage() { return <NewGridFormPage />; }

export default async function EditGridPage({ params }: { params: Promise<{ id: string }> }) {
  return <EditGridFormPage id={(await params).id} />;
}
```

- [ ] **Step 6: Run form and route tests**

Run: `pnpm exec vitest run src/features/grids/grid-form-model.test.ts src/features/grids/grid-form.test.tsx src/app/base-path-routing.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit product forms**

```bash
git add src/features/grids/grid-form.tsx src/features/grids/grid-form.module.css src/features/grids/grid-form.test.tsx src/features/grids/grid-form-page.tsx src/app/'(protected)'/grids/new/page.tsx src/app/'(protected)'/grids/'[id]'/edit/page.tsx
git commit -m "feat: add product create and edit pages"
```

### Task 4: Detail table and row inspector

**Files:**
- Create: `src/features/grids/grid-detail.tsx`
- Create: `src/features/grids/grid-detail.module.css`
- Create: `src/features/grids/grid-detail.test.tsx`
- Create: `src/features/grids/grid-row-inspector.tsx`
- Create: `src/app/(protected)/grids/[id]/page.tsx`

**Interfaces:**
- Consumes: `GridTradeDetail`, `GridItem`, and Task 1 API functions.
- Produces: `GridDetail({ id })` with selected row state and an accessible `GridRowInspector`.

- [ ] **Step 1: Write failing detail interaction tests**

```tsx
it("opens a row and moves to the next calculation item", async () => {
  render(<GridDetailView detail={detailWithThreeRows} onRecalculate={vi.fn()} onDelete={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "查看第 1 笔明细" }));
  expect(screen.getByRole("dialog", { name: "网格行明细" })).toHaveTextContent("1 / 3");
  await user.click(screen.getByRole("button", { name: "下一笔" }));
  expect(screen.getByRole("dialog", { name: "网格行明细" })).toHaveTextContent("2 / 3");
});

it("shows sell columns before buy columns for short products", () => {
  render(<GridDetailView detail={{ ...detail, isShort: true }} onRecalculate={vi.fn()} onDelete={vi.fn()} />);
  const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
  expect(headers.indexOf("卖出价格")).toBeLessThan(headers.indexOf("买入价格"));
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `pnpm exec vitest run src/features/grids/grid-detail.test.tsx`

Expected: FAIL because the detail components are missing.

- [ ] **Step 3: Implement detail state and authoritative recalculate**

Fetch once on mount, preserve the current detail on recalculation failure, replace it on success, and block duplicate requests:

```ts
async function handleRecalculate() {
  if (recalculating) return;
  setRecalculating(true);
  try { setDetail(await recalculateGridTrade(id)); }
  catch (error) { setActionError(clientMessage(error)); }
  finally { setRecalculating(false); }
}
```

- [ ] **Step 4: Implement the financial table and row inspector**

Render the complete specification columns, a summary footer, text labels “小网/中网/大网”, and clickable row buttons. `GridRowInspector` receives `{ items, selectedIndex, isShort, onSelect, onClose }`; it disables previous at index 0 and next at `items.length - 1`. CSS uses a right drawer above 768 px and a fixed full-content panel below 768 px, with no bottom navigation.

- [ ] **Step 5: Add the detail route adapter**

```tsx
export default async function GridDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <GridDetail id={(await params).id} />;
}
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm exec vitest run src/features/grids/grid-detail.test.tsx src/app/base-path-routing.test.tsx`

Expected: PASS, including short-column order and row navigation.

- [ ] **Step 7: Commit detail and row inspection**

```bash
git add src/features/grids/grid-detail.tsx src/features/grids/grid-detail.module.css src/features/grids/grid-detail.test.tsx src/features/grids/grid-row-inspector.tsx src/app/'(protected)'/grids/'[id]'/page.tsx
git commit -m "feat: add grid detail and row inspector"
```

### Task 5: Delete confirmation and list entry points

**Files:**
- Modify: `src/features/grids/grid-detail.tsx`
- Modify: `src/features/grids/grid-detail.test.tsx`
- Modify: `src/features/grids/grid-workspace.tsx`
- Modify: `src/features/grids/grid-workspace.module.css`
- Modify: `src/features/grids/grid-workspace.test.tsx`

**Interfaces:**
- Consumes: `deleteGridTrade(id)` and Next navigation.
- Produces: navigable product rows, new-product action, empty-state action, and explicit typed delete confirmation.

- [ ] **Step 1: Write failing navigation and delete tests**

```tsx
it("links each product name to its stable detail route", () => {
  render(<GridWorkspaceView controller={controllerWithItems} />);
  expect(screen.getByRole("link", { name: "黄金 ETF" })).toHaveAttribute("href", `/grids/${item.id}`);
});

it("deletes only after the product code is entered", async () => {
  render(<GridDetailView detail={detail} onRecalculate={vi.fn()} onDelete={onDelete} />);
  await user.click(screen.getByRole("button", { name: "删除产品" }));
  await user.type(screen.getByLabelText("输入产品代码确认"), detail.productCode);
  await user.click(screen.getByRole("button", { name: "确认永久删除" }));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm exec vitest run src/features/grids/grid-workspace.test.tsx src/features/grids/grid-detail.test.tsx`

Expected: FAIL because rows are not links and delete confirmation is absent.

- [ ] **Step 3: Add list actions and distinct empty states**

Add a primary `Link` to `/grids/new` in the heading. For an account with no products, show both `/grids/new` and `/grids/import`; for a search with no matches, show only “清除搜索”. Keep the current four mobile data columns and six desktop columns.

```tsx
<Link className={styles.primaryAction} href="/grids/new">新建产品</Link>
```

- [ ] **Step 4: Add explicit delete confirmation**

Show product name, product code, irreversible warning, and an input that must equal the exact code. Disable confirmation while mismatched or deleting. On success call `router.replace("/grids")`; on failure retain the dialog and display the public API message/requestId.

```tsx
<button type="button" disabled={confirmation !== detail.productCode || deleting} onClick={handleDelete}>
  {deleting ? "正在删除…" : "确认永久删除"}
</button>
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm exec vitest run src/features/grids/grid-workspace.test.tsx src/features/grids/grid-detail.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the completed product workflow**

```bash
git add src/features/grids/grid-workspace.tsx src/features/grids/grid-workspace.module.css src/features/grids/grid-workspace.test.tsx src/features/grids/grid-detail.tsx src/features/grids/grid-detail.test.tsx
git commit -m "feat: complete grid product workflow"
```

### Task 6: Demo adapter, responsive smoke test, and release gate

**Files:**
- Modify: `src/features/grids/demo-grid-data.ts`
- Modify: `src/features/grids/grid-api.ts`
- Modify: `src/features/grids/grid-api.test.ts`
- Modify: `src/e2e/ui-demo.smoke.test.ts`

**Interfaces:**
- Consumes: all product routes and components from Tasks 1–5.
- Produces: deterministic demo CRUD/detail behavior that is available only when `NEXT_PUBLIC_UI_DEMO_MODE=1`.

- [ ] **Step 1: Write failing demo and browser assertions**

Add API tests asserting demo detail/recalculate return deterministic fixtures and production mode still calls `fetch`. Add smoke assertions that a desktop user can open a row inspector and a 390 px mobile viewport has no fixed bottom navigation and can open the same detail.

```ts
await page.goto(`${baseUrl}/grids/${demoGridId}`);
await page.getByRole("button", { name: "查看第 1 笔明细" }).click();
await expect(page.getByRole("dialog", { name: "网格行明细" })).toBeVisible();
await page.setViewportSize({ width: 390, height: 844 });
await expect(page.getByRole("dialog", { name: "网格行明细" })).toBeVisible();
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm exec vitest run src/features/grids/grid-api.test.ts src/e2e/ui-demo.smoke.test.ts`

Expected: FAIL until the demo adapter covers the new routes.

- [ ] **Step 3: Implement a module-local demo repository**

Export deterministic functions with the same signatures as Task 1:

```ts
export function getDemoGridTrade(id: string): GridTradeDetail;
export function createDemoGridTrade(input: GridTradeMutationInput): GridTradeDetail;
export function updateDemoGridTrade(id: string, input: GridTradeMutationInput): GridTradeDetail;
export function deleteDemoGridTrade(id: string): void;
```

Use the existing demo fixtures and precomputed calculation rows. Do not import `calculateGrid` into client code. Select this adapter only inside `isUiDemoMode()` branches.

- [ ] **Step 4: Run the complete release gate**

Run: `pnpm test`

Expected: all tests pass; PostgreSQL integration tests may remain skipped only when `TEST_DATABASE_URL` is absent.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm lint`

Expected: exit 0.

Run: `NEXT_PUBLIC_APP_BASE_PATH=/fitgrid pnpm build`

Expected: exit 0 and routes include `/grids/new`, `/grids/[id]`, and `/grids/[id]/edit`.

- [ ] **Step 5: Commit demo and verification coverage**

```bash
git add src/features/grids/demo-grid-data.ts src/features/grids/grid-api.ts src/features/grids/grid-api.test.ts src/e2e/ui-demo.smoke.test.ts
git commit -m "test: cover complete grid product workflow"
```
