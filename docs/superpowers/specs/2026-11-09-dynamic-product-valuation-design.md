# Dynamic product identity and valuation discovery

Approved scope: the user authorized implementation on 2026-11-09. Local feature branch only; no production access, deployment or data mutation.

## Approach
Use existing market search and verified instruments for new grids. Persist canonical codes and valuation mappings separately. Keep the 26 existing mappings as reviewed seeds; new products use provider capabilities rather than a product whitelist. GET reads local data only. Refresh POST discovers missing identities and benchmark metadata and collects bounded history. Grid creation never waits for valuation collection.

Price discovery is independent of benchmark discovery. Fund benchmark evidence must come from explicit profile fields, not the fund name. Ambiguous, active, leveraged or inverse products cannot silently inherit ordinary index valuations. Stocks use company metrics when supported; missing company history remains explicitly unsupported. REIT distributions retain existing verification and coverage rules.

Persist complete product definitions, provenance and retry/check timestamps in the database; preserve existing series keys/history. Requests use fixed provider hosts plus strict symbol/metric/frequency validation; clients cannot supply URLs. Existing raw-code grids get associated during refresh without changing parameters or breaking imports/exports. New form selection is required; existing free-text grid edits remain compatible.

## Acceptance
QQQ and arbitrary verified new symbols can obtain their own price history without catalog entries. Explicit benchmark metadata resolves to supported index capabilities and survives restart. Each missing metric states its reason; upstream failures preserve cached data. Market/query changes invalidate prior selection and stale requests cannot overwrite current state. Backend validates selected identity. Full tests, typecheck, lint, build, isolated DB roundtrip and UI inspection.

## Alternatives
Per-product releases were rejected. Database-only manual configuration still burdens every addition. Fully automatic name guessing is inaccurate. Selected approach: automatic identity and evidence-based mapping with explicit unmatched states; the user confirms only the instrument.

## Implemented coverage and operations
- China means the existing Shanghai/Shenzhen provider coverage. Search and verification support stocks, ETF, LOF and public REIT instruments; US supports USD stocks and ETF.
- Fund profiles first use symbol-verified structured metadata; China has an identity-checked HTML fallback. Mapping stores the evidence, source URL, check time and retry time. Existing reviewed mappings and history keys remain available.
- New domestic index codes can use the CSI PE capability. Other index PE/PB/yield capabilities require already verified provider support. Unsupported metrics stay blank; supporting a new provider or metric still requires integration work, while another instrument using supported capabilities does not require a release.
- Company historical PE/PB/dividend yield are not currently connected; stocks retain their own price history and state this limitation.
- New REIT yield coverage begins conservatively at the start of fully collected price history when a reviewed listing date is unavailable. Notice identity, amount, unit, exchange ex-date, split and incomplete-history checks remain mandatory.
- `research_products` is a public, rebuildable research cache. Full database backups include it. Portable user backups keep their existing schema and omit this cache, as they already omit research histories; refresh rebuilds mappings after restore.
- The new migration must be applied as part of any future approved deployment. This task does not apply migrations to production or deploy the branch.

## Validation record — 2026-11-09
- Final application suite: 116 files, 1,046 tests passed, including real PostgreSQL tests with an unprivileged application role and isolated schemas. The temporary local PostgreSQL version was 18.6; production was not accessed.
- Full suite run: 1,314 passed, 4 failed, 6 skipped. The missing local signing-secret configuration and two load-sensitive shell timeouts were resolved by supplying the test secret and rerunning serially with a 15-second allowance: 20 files, 196 tests passed. The remaining mobile password-change smoke test timeout also occurred on unchanged main and is outside this feature. The feature's browser create/edit/delete flow passed.
- Browser inspection: search results fit 320, 390 and 1,440 px; product confirmation and market-change invalidation passed. No horizontal overflow.
- Real public-source smoke: production registry adapter discovered QQQ → NDX and 588000.SH → 000688, saved both profiles to an isolated local database, and fetched their own historical prices using the application's actual HTTP transport.
- Typecheck, lint and production build passed. No production credentials were used for implementation or validation.
- Independent read-only review found two Important issues: case-sensitive aliases and unchanged-code edits on pre-existing alias pairs. Both were reproduced by failing regressions and fixed; the targeted suite passed 13 tests, including the PostgreSQL lookup, followed by the final 1,046-test application suite. No Critical or deferred Minor findings.
- Review limits: live providers were checked by the implementer; availability can still change. Production backup restoration was not exercised under the no-production-mutations constraint. Public mappings rebuild after a portable restore; missing upstream data remains unavailable until a successful refresh.
