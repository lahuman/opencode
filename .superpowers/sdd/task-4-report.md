# Task 4 report: Enterprise provider and model management UI

## Status

Complete. All changes remain uncommitted. Shared Task 1-3 changes were preserved.

## Implementation summary

- Replaced the legacy model-scoped Company LLM credential dialog with an Enterprise provider catalog and editor.
- Added provider create/edit/delete, immutable edit IDs, arbitrary HTTP(S) Base URLs, zero-model providers, scoped model create/edit/delete, default selection, and deterministic rendering of the catalog returned by each IPC mutation.
- Added pure provider validation, credential-intent, redacted presentation, action-locking, captured delete-confirmation, and selected diagnostic helpers.
- Credential editing uses explicit `preserve`, `replace`, and `clear` intent. The renderer receives only configured state, header names, and stable error codes; API keys and header values are never read back or rendered by the fixture.
- Added provider/model-specific diagnostics and retained accessible check/failure/readiness output.
- Updated both settings layouts to show provider count and the current `Provider / Model`, open `Manage providers`, and test only a valid default pair. Ordinary mode branches were not changed.
- Reworked the Playwright fixture around a mutable in-memory provider catalog implementing every Task 3 method, including same-provider default fallback.

## Files

Modified:

- `packages/app/src/components/dialog-company-provider-state.ts`
- `packages/app/src/components/dialog-company-provider.test.ts`
- `packages/app/src/components/dialog-company-provider.tsx`
- `packages/app/src/components/settings-providers.tsx`
- `packages/app/src/components/settings-v2/providers.tsx`
- `packages/app/src/components/settings-v2/settings-v2.css`
- `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- `packages/app/e2e/company-llm-enterprise.spec.ts`

## TDD evidence

### RED 1: pure provider state

From `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts
```

Initial result: exit 1, `0 pass`, `1 fail`, `1 error`; the new `enterpriseDeleteConfirmation` export and the rest of the provider-management state surface did not exist.

### GREEN 1: pure provider state

The same targeted command passed `12 tests`, `0 fail`, `19 expect() calls` after implementing validation, credential intent, presentation, locks, confirmations, and diagnostics.

### RED/GREEN 2: credential recovery presentation

The final self-review regression used the same command. RED: exit 1, `12 pass`, `1 fail`; credential decryption failure rendered `Credentials not configured`. GREEN: `13 pass`, `0 fail`, `20 expect() calls`; it now renders `Credentials must be re-entered` without secret values.

### RED 3: both settings layouts

From `packages/app`:

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "summarizes the Enterprise catalog"
```

Result: exit 1, `2 failed`. Both legacy and V2 layouts were missing the expected `1 provider` catalog summary.

### GREEN 3: both settings layouts

The same command passed `2 tests` after adding provider count, default pair, `Manage providers`, and default-pair diagnostic controls.

### RED/GREEN 4: full CRUD browser flow

From `packages/app`:

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "manages provider, model"
```

RED: exit 1 at the credential step; the redacted `credential-inputs` observation was empty because edit replacement used `updateProvider` instead of the explicit credential method. GREEN: `1 passed`; edit replacement now calls `replaceProviderCredentials` with a complete set.

The flow covers provider creation with `https://gateway.example/v1`, two scoped models, second-model default, credential replacement without DOM secret readback, immutable provider/model edit IDs, selected-pair diagnostics, same-provider fallback after default-model deletion, and empty state after provider deletion.

## Final verification

From `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts
bun.cmd run typecheck
bun.cmd run typecheck:e2e
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

Fresh final results:

- Unit: `13 pass`, `0 fail`, `20 expect() calls`.
- App typecheck: exit 0.
- E2E typecheck: exit 0.
- Focused Playwright spec: `15 passed` in 2.8 minutes, including desktop and mobile viewport cases.

Formatting and hygiene:

- Prettier was run on the eight owned files.
- `git diff --check` reported no whitespace errors; only existing CRLF-to-LF checkout warnings appeared.
- Focused oxlint reported no errors. Its warnings are existing fixture/settings patterns plus one Solid resource-source consistency warning; the new unsafe credential-mode assertion and unbound dialog close were removed during self-review.

## Self-review

- Provider and model IDs are editable only on create; edit mutations use captured selected IDs.
- Delete execution uses the stored confirmation object rather than mutable current selection.
- Every pending mutation/diagnostic disables provider selection, editors, and destructive/default/test actions.
- Providers with zero models save; default, edit-model, delete-model, and test actions remain disabled.
- Provider cards show ID, name, Base URL, model count, redacted credentials, and default metadata.
- Successful IPC results mutate the resource directly; no second read is required.
- Plaintext fields reset on provider/model selection, close, successful save/replacement, and mutation-error recovery.
- The fixture records only `hasApiKey` and header names, so secrets are absent from DOM observations and Playwright screenshots/traces.
- No generated files, public HTTP API, commits, pushes, plan documents, or Task 1-3 files outside the owned integration surface were changed.

## Concerns

- The full App unit/browser suites were not run; verification used the exact targeted provider unit, the complete focused Enterprise Playwright spec, and both App typechecks.

## Commit status

No commit or push was created, per instruction.

## Post-review corrections

The Task 4 review identified four Important issues and one Minor fixture/test accuracy issue. All were addressed without a commit or push.

### Exact changed files for the review fixes

- `packages/ui/src/context/dialog.tsx`
- `packages/ui/src/components/dialog.tsx`
- `packages/app/src/components/dialog-company-provider-state.ts`
- `packages/app/src/components/dialog-company-provider.test.ts`
- `packages/app/src/components/dialog-company-provider.tsx`
- `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- `packages/app/e2e/company-llm-enterprise.spec.ts`
- `.superpowers/sdd/task-4-report.md`
- `.superpowers/sdd/task-4-review.diff` (regenerated review artifact)

### 1. Atomic replacement and clear-failure reconciliation

Provider credential replacement now uses the backend's combined `updateProvider({ credentials })` transaction, so metadata and replacement credentials commit or roll back together. Clear remains a required second operation. If clear fails after metadata commits, the renderer immediately calls `providerCatalog()` and mutates the resource with that committed view before displaying the error.

RED, from `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts
```

Result: exit 1, `0 pass`, `1 fail`, `1 error`; `applyEnterpriseProviderUpdate` did not exist.

GREEN: `16 pass`, `0 fail`, `27 expect() calls`. The new tests prove combined replacement input and catalog reconciliation after a failed clear.

The browser CRUD regression also failed before integration because the provider card remained `Gateway` instead of the metadata value `Gateway Reconciled` after clear failed. The corrected flow renders the committed metadata, reports the clear error, and permits a subsequent successful clear.

### 2. Complete pending-operation close lock

The shared Dialog API now accepts reactive `preventClose`. A dialog-layer close guard is consulted by the header close button, Escape handling, controlled-dialog close attempts, and overlay clicks before `onClose` or its refetch callback can run. The Company provider dialog supplies the same pending/confirmation lock used by its controls.

Corrected RED proof, from `packages/app`, with only the provider dialog's guard temporarily removed after the test harness locator was fixed:

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "pending provider mutations"
```

Result: exit 1; `dialog-close-button` was expected disabled but remained enabled. After restoring the guard, the same command passed `1 test`. The regression also proves footer Close, Escape, and backdrop clicks cannot close during the pending credential transaction and that both close buttons unlock afterward.

### 3. Base URL backend-contract validation

Provider form validation now accepts only HTTP(S) URLs with no username, password, query, or fragment.

The focused unit RED/GREEN command above covers all three forbidden URL forms and passes in the final `16/16` result.

### 4. Accessible inline destructive confirmation

The inline confirmation now has a labelled `alertdialog`, a separate `aria-describedby` description, initial focus on the confirm button, focus restoration on cancel, and a modal interaction lock that disables provider/model CRUD plus all parent-dialog close paths while active. Confirmation buttons remain operable while no mutation is pending.

RED browser evidence: the focused three-test run could not find the required named/described alertdialog, and surrounding controls were still interactive. GREEN:

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "manages provider|pending provider mutations|delete confirmation"
```

Result: `3 passed` in 13.4 seconds.

### 5. Fixture and secret non-readback accuracy

The fixture now records only `hasApiKey` and header names for combined credential updates, supports a controllable pending credential operation, and can fail clear after metadata commits. Playwright reopens replacement mode and asserts API key, header name, and header value fields are blank; it also exercises failed and successful clear wiring. No secret value is read from the catalog or emitted into observation output.

### Post-review final verification

Commands and results:

```powershell
# packages/app
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts
bun.cmd run typecheck
bun.cmd run typecheck:e2e
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts

# packages/ui
bun.cmd test src --only-failures
bun.cmd run typecheck
```

- App provider units: `16 pass`, `0 fail`, `27 expect() calls`.
- App typecheck: exit 0.
- App E2E typecheck: exit 0.
- Complete focused Enterprise Playwright spec: `17 passed` in 2.9 minutes, including desktop and mobile viewport cases.
- UI tests: `12 pass`, `0 fail`, `25 expect() calls`.
- UI typecheck: exit 0.
- Focused oxlint: exit 0 with no errors; remaining warnings are existing fixture/parser assertions and pre-existing dialog autofocus assertions.
- Prettier ran on every review-fix source/test file.
- No Important review issue remains open. The prior sequential replacement concern is resolved; multi-step clear failure now reconciles the authoritative catalog view.

## Second re-review corrections (2026-07-20)

This section supersedes the earlier atomic-replacement and catalog-reread conclusions above.

### 1. Authoritative two-step credential reconciliation

Production now calls `updateProvider` with metadata only and explicitly calls `replaceProviderCredentials` for replacement. Clear continues to call `clearProviderCredentials`. If either credential operation fails after metadata committed, `applyEnterpriseProviderUpdate` directly mutates the resource with the authoritative `updated` catalog returned by `updateProvider` and then rethrows. It no longer rereads or swallows a failure from `providerCatalog()`.

Unit RED evidence showed all three old behaviors: replacement secrets were included in `updateProvider`, clear failure attempted the removed `providerCatalog` callback, and replacement failure resolved instead of rejecting. GREEN is `17 pass`, `0 fail`, `30 expect() calls`.

The browser RED showed `Gateway Replace Reconciled` remained stale after a failed replacement. GREEN now proves the metadata is visible, the prior configured-credential status is retained, the failed plaintext secret is cleared, and the error is still reported. The existing clear-failure path likewise renders committed metadata without a catalog reread.

### 2. True inline alertdialog keyboard containment

The destructive confirmation is now `aria-modal`, traps Tab and Shift+Tab within its enabled focusable controls, disables the background error-dismiss action, and removes the readiness summary from the tab order while active. The browser regression creates both background controls, verifies their exclusion, cycles in both directions between Confirm and Cancel, and still verifies focus restoration after cancel.

RED failed because `Dismiss error` remained enabled behind the confirmation. GREEN passes the focused confirmation scenario.

### Final verification after second re-review

```powershell
# packages/app
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts
bun.cmd run typecheck
bun.cmd run typecheck:e2e
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts

# packages/ui
bun.cmd test src
bun.cmd run typecheck
```

- App provider units: `17 pass`, `0 fail`, `30 expect() calls`.
- App typecheck: exit 0.
- App E2E typecheck: exit 0.
- Complete Enterprise Playwright spec: `17 passed` in 2.5 minutes.
- UI tests: `12 pass`, `0 fail`, `25 expect() calls`.
- UI typecheck: exit 0.
- Prettier completed for all second-review source and test files.
- No second re-review issue remains open.
