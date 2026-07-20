# Final Review Important Fixes Report

Date: 2026-07-20

Scope: six Important findings from the final Enterprise provider/model CRUD review. All work remained uncommitted and unpushed in the shared checkout.

## 1. Legacy non-first default migration

Regression: `packages/desktop/src/main/enterprise-providers.test.ts` now migrates a three-model legacy profile whose default is second in packaged order. It asserts the default retains model ID `reasoning`, receives provider ID `company-llm`, remaining entries receive `company-llm-2` and `company-llm-3` in packaged order, and each endpoint/credential stays paired with its historical model identity.

RED command (from `packages/desktop`):

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts -t "assigns company-llm to a non-first legacy default"
```

RED result: exit 1, `0 pass / 1 fail`; received default provider `company-llm-2`, while the first non-default model incorrectly received `company-llm`.

GREEN command:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts
```

GREEN result: exit 0, `9 pass / 0 fail`, `18 expect()` calls.

Implementation: reserve `company-llm` for the configured legacy default before assigning deterministic suffixes to other packaged entries.

## 2. Electron-main credential validation

Regressions: direct runtime tests cover trimmed API key/header names/values, whitespace-only names/values, and case-insensitive duplicate names. The IPC child harness sends forged invalid replacements through the registered IPC handler to a real provider runtime.

Direct RED command (from `packages/desktop`):

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "credential secrets|duplicated credential headers"
```

RED result: exit 1, `0 pass / 2 fail`; whitespace was stored verbatim and invalid blank/duplicate headers resolved successfully.

IPC RED command after adding the forged-input regression and before restoring the validator:

```powershell
bun.cmd test ./src/main/ipc.test.ts -t "registerIpcHandlers registers and dispatches"
```

RED result: exit 1, `0 pass / 1 fail`; `credentialBypassErrors` was `[null, null]` instead of two stable validation failures.

GREEN command:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts ./src/main/ipc.test.ts
```

GREEN result: exit 0, `25 pass / 0 fail`, `67 expect()` calls.

Implementation: Electron main trims nonblank API keys, header names, and header values; omits an empty trimmed API key; rejects blank trimmed header names/values and duplicate trimmed names case-insensitively.

## 3. Atomic combined provider edits

Regressions: runtime clear intent must update metadata and credentials in one restart. App helper tests require one `updateProvider` call for replacement and clear and no optimistic metadata reconciliation after an atomic failure. Playwright records combined update requests and separately records standalone credential calls.

RED commands:

```powershell
# packages/desktop
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "updates provider metadata and clears credentials"

# packages/app
bun.cmd test ./src/components/dialog-company-provider.test.ts -t "atomically|atomic credential"
```

RED results: Desktop exit 1, `0 pass / 1 fail`; credentials remained configured after `clearCredentials: true`. App exit 1, `1 pass / 2 fail`; replacement attempted a missing second callback and clear sent only metadata without atomic clear intent.

GREEN commands/results:

```powershell
# packages/desktop
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts ./src/preload/types.test.ts
# 28 pass / 0 fail, 71 expect()

# packages/app
bun.cmd test ./src/components/dialog-company-provider.test.ts
# 17 pass / 0 fail at this checkpoint, 30 expect()

bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "manages provider"
# 1 passed
```

Implementation: `updateProvider` retains atomic replacement and adds explicit `clearCredentials: true`. The App sends preserve/replace/clear combined edits through exactly one update IPC. Failed combined replacement/clear leaves both metadata and credential presentation unchanged. Standalone replace/clear APIs remain wired and covered by runtime/preload tests; Playwright proves combined edits do not call either standalone IPC.

## 4. Recovery error-code propagation and guidance

Regressions: preload receives Electron's flattened `restart_failed_recovery_failed` message and must rehydrate `{ code, message }`. Full App integration triggers the failure during a combined provider edit and expects the existing restart/recovery guidance instead of `Request failed`.

RED commands/results:

```powershell
# packages/desktop
bun.cmd test ./src/preload/types.test.ts -t "preserves provider recovery"
# exit 1, 0 pass / 1 fail; received only the flattened Error with no code

# packages/app
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "provider recovery failure"
# exit 1, 0 pass / 1 fail; alert rendered "Request failed"
```

GREEN commands/results:

```powershell
# packages/desktop
bun.cmd test ./src/preload/types.test.ts -t "preserves provider recovery"
# 1 pass / 0 fail

# packages/app
bun.cmd test ./src/components/dialog-company-provider.test.ts -t "recovery code"
# 1 pass / 0 fail, 2 expect()

bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts --grep "provider recovery failure"
# 1 passed
```

Implementation: the preload Enterprise provider boundary recognizes stable main-process error codes and rethrows a safe coded error. The App preserves the failure and maps recovery/rollback codes to the existing localized Enterprise restart guidance.

## 5. Authoritative default after merged config

Regressions: OpenCode enforcement receives an absent merged model and a stale `deleted/old` project selection; both must resolve to catalog default `internal/code`.

RED command (from `packages/opencode`):

```powershell
bun.cmd test ./test/config/enterprise.test.ts -t "supplies the catalog default|replaces a stale project model"
```

RED result: exit 1, `0 pass / 2 fail`; absent stayed `undefined` and stale stayed `deleted/old`.

GREEN command:

```powershell
bun.cmd test ./test/config/enterprise.test.ts
```

GREEN result: exit 0, `18 pass / 0 fail`, `42 expect()` calls.

Implementation: post-merge enforcement preserves `info.model` only when the exact provider/model pair exists in the authoritative catalog; otherwise it selects the catalog default or clears the invalid selection when no default exists.

## 6. Credential/catalog membership

Regressions: a catalog snapshot and startup each receive schema-v3 credentials containing an `orphan` provider key. Both must reject with a stable non-secret code, and startup must leave encrypted durable bytes unchanged. The existing deletion regression continues to assert that normal provider deletion removes the provider credential key atomically.

RED command (from `packages/desktop`):

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "outside the catalog|orphaned provider credentials"
```

RED result: exit 1, `0 pass / 2 fail`; both orphan states resolved successfully.

GREEN command:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts
```

GREEN result: exit 0, `24 pass / 0 fail`, `64 expect()` calls.

Implementation: runtime snapshots/catalog reads and startup validate every credential provider key against the current catalog and reject `credential_provider_not_configured`. No silent pruning or durable rewrite occurs. `deleteProvider` remains the explicit atomic path that filters its credential entry.

## Final verification

Desktop focused suite (from `packages/desktop`):

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts ./src/main/enterprise-provider-runtime.test.ts ./src/main/sidecar-startup.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts
```

Result: exit 0, `79 pass / 0 fail`, `243 expect()` calls.

OpenCode focused suite (from `packages/opencode`):

```powershell
bun.cmd test --timeout 30000 ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts ./test/provider/diagnostic.test.ts
```

Result: exit 0, `56 pass / 0 fail`, `188 expect()` calls. An earlier concurrent default-timeout run produced `55 pass / 1 timeout` in the unrelated timing-sensitive delayed-SSE test; an isolated rerun passed `1/1` in 3.14 seconds, and the complete serial suite above passed.

App focused unit suite (from `packages/app`):

```powershell
bun.cmd test ./src/components/dialog-company-provider.test.ts
```

Result: exit 0, `18 pass / 0 fail`, `32 expect()` calls.

Full Enterprise Playwright (from `packages/app`):

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

Result: exit 0, `20 passed`.

Type checks:

```powershell
# packages/desktop
bun.cmd typecheck
# exit 0: tsgo -b

# packages/opencode
bun.cmd typecheck
# exit 0: tsgo --noEmit

# packages/app
bun.cmd typecheck
# exit 0: tsgo -b

bun.cmd run typecheck:e2e
# exit 0: tsgo -p e2e/tsconfig.json
```

Diff hygiene:

```powershell
git diff --check
```

Result: exit 0; only existing Git CRLF-to-LF warnings were printed.

## Files changed for these fixes

- `packages/desktop/src/main/enterprise-providers.ts`
- `packages/desktop/src/main/enterprise-providers.test.ts`
- `packages/desktop/src/main/enterprise-provider-runtime.ts`
- `packages/desktop/src/main/enterprise-provider-runtime.test.ts`
- `packages/desktop/src/main/ipc.test.ts`
- `packages/desktop/test/ipc-entrypoint.ts`
- `packages/desktop/src/preload/types.ts`
- `packages/desktop/src/preload/types.test.ts`
- `packages/app/src/context/platform.tsx`
- `packages/app/src/components/dialog-company-provider-state.ts`
- `packages/app/src/components/dialog-company-provider.test.ts`
- `packages/app/src/components/dialog-company-provider.tsx`
- `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- `packages/app/e2e/company-llm-enterprise.spec.ts`
- `packages/opencode/src/config/enterprise.ts`
- `packages/opencode/test/config/enterprise.test.ts`
- `.superpowers/sdd/final-fixes-report.md`

No commit, push, generated SDK edit, public Protocol change, or Server `HttpApi` change was made.
