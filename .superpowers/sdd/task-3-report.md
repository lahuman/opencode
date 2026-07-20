# Task 3 report: transactional CRUD and typed Electron IPC

## Status

Complete. All changes remain uncommitted. Task 1 and Task 2 changes in the shared checkout were preserved.

## Implementation summary

- Added a single serialized enterprise provider runtime with immutable-ID provider/model CRUD, scoped lookups, complete candidate-catalog validation, deterministic default fallback, and provider-scoped credential replacement/clear behavior.
- Added a two-store persistence/restart transaction. A failed candidate restart restores catalog and credentials, restarts the previous state, and reports either `restart_failed_rolled_back` or `restart_failed_recovery_failed` without exposing the underlying error.
- Added redacted catalog views containing only credential configured state, header names, and the two allowed secure-storage error codes.
- Added retry-safe startup initialization for provider catalog schema v1 and provider credential schema v3, including legacy v1/v2 credential migration.
- Replaced main-process model-scoped credential wiring with provider runtime wiring. Normal startup, provider mutations, rollback recovery, and skill-pack restarts all pass complete current/candidate catalog and credential state to the sidecar.
- Added all ten explicit private Electron IPC channels and the exact provider API methods in preload and App platform contracts.
- Migrated the existing Company Provider caller and its fixtures to provider-scoped credentials. Mutations consume the returned catalog view directly and no longer request a desktop restart after the main runtime has already completed a healthy sidecar restart.
- Ordinary mode keeps an empty read-only catalog surface, rejects provider mutations, does not initialize enterprise files, and starts the ordinary sidecar without enterprise catalog/credential payloads.
- Reused Task 2's existing `spawnLocalServer` catalog/credential option and sidecar-start payload support; no additional Task 3 edit to `server.ts` was necessary.
- No public Protocol, Server `HttpApi`, generated client, or SDK files were changed.

## Files

Created:

- `packages/desktop/src/main/enterprise-provider-runtime.ts`
- `packages/desktop/src/main/enterprise-provider-runtime.test.ts`

Modified for the runtime and Electron boundary:

- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/index.test.ts`
- `packages/desktop/src/main/ipc.ts`
- `packages/desktop/src/main/ipc.test.ts`
- `packages/desktop/src/preload/types.ts`
- `packages/desktop/src/preload/types.test.ts`
- `packages/desktop/test/ipc-entrypoint.ts`
- `packages/desktop/test/main-index-entrypoint.ts`
- `packages/desktop/test/renderer-platform-entrypoint.ts`
- `packages/desktop/test/renderer-index-entrypoint.tsx`

Modified for the App platform caller contract:

- `packages/app/src/context/platform.tsx`
- `packages/app/src/components/dialog-company-provider.tsx`
- `packages/app/src/components/dialog-company-provider-state.ts`
- `packages/app/src/components/dialog-company-provider.test.ts`
- `packages/app/src/components/dialog-company-guide.test.ts`
- `packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts`
- `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- `packages/app/e2e/company-llm-enterprise.spec.ts`

Shared Task 1/2 files were inspected and exercised but not reverted. In particular, Task 2 had already added the required catalog/credential sidecar option in `packages/desktop/src/main/server.ts`.

## TDD evidence

### RED 1: runtime boundary

Command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts
```

Result: exit 1, `0 pass`, `1 fail`, with `Cannot find module './enterprise-provider-runtime'`. This was the expected missing-feature failure before production runtime code existed.

### GREEN 1: runtime CRUD/transaction

Same command after the minimal runtime implementation: initially `11 pass`, `0 fail`. After adding the startup retry case, the fresh final result is `12 pass`, `0 fail`, `27 expect() calls`.

Covered behavior:

- provider/model create, update, and delete;
- provider with zero models;
- immutable update IDs and missing scoped-ID rejection;
- initial default selection and exact same-provider/first-remaining fallback ordering;
- two-store rollback and explicit recovery-failure code;
- mutation serialization across restart completion;
- provider credential deletion, complete replacement, clear-with-provider-record preservation;
- redacted views and secure-storage error codes;
- retry-safe v2-to-v3 startup migration.

### RED 2: IPC/preload contract

Command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/ipc.test.ts ./src/preload/types.test.ts
```

Result: exit 1, `7 pass`, `3 fail`. Failures showed the missing `enterprise-provider-catalog` main channel, missing `providerCatalog()` preload method, and old mapped platform method names.

### GREEN 2: IPC/preload contract

Same command after wiring: `10 pass`, `0 fail`, `19 expect() calls`.

### RED 3: main startup/runtime integration

Command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/index.test.ts ./test/main-index-entrypoint.ts
```

Result: exit 1, `9 pass`, `1 fail`. The new provider credential IPC handler reached the old main dependency and failed with `replaceProviderCredentials is not a function`.

### GREEN 3: main startup/runtime integration

Same command after initialization and runtime wiring: `10 pass`, `0 fail`, `32 expect() calls`. The entrypoint captured both normal and restarted sidecar states and emitted no API key or header value.

### RED/GREEN 4: App caller migration

Command, from `packages/app`:

```powershell
bun.cmd test ./src/components/dialog-company-provider.test.ts
```

RED result: exit 1, `9 pass`, `2 fail`; the old partial credential input and hard-coded provider diagnostic ID contradicted the provider-scoped API.

GREEN result: `11 pass`, `0 fail`, `22 expect() calls` after complete-replacement input and scoped diagnostic routing were implemented.

### RED/GREEN 5: App e2e type contract

Command, from `packages/app`:

```powershell
bun.cmd typecheck:e2e
```

RED result: exit 1 with the old `credentialCatalog`, `credentialStatus`, `setCredentials`, and `clearCredentials` fixture contract. After migrating the fixture and completing its enterprise surface, the final result is exit 0.

## Final verification

Exact brief command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts ./test/main-index-entrypoint.ts ./test/ipc-entrypoint.ts
```

Result: exit 0, `32 pass`, `0 fail`, `78 expect() calls` across six files.

Task 1/2 stores, sidecar payload, environment, and renderer integration, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts ./src/main/sidecar-startup.test.ts ./src/main/enterprise-sidecar-env.test.ts ./src/renderer/platform.test.ts
```

Result: exit 0, `41 pass`, `0 fail`, `135 expect() calls` across five files.

Relevant App units, from `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-provider.test.ts ./src/components/dialog-company-guide.test.ts
```

Result: exit 0, `16 pass`, `0 fail`, `32 expect() calls`.

Type checks:

```powershell
# packages/desktop
bun.cmd typecheck

# packages/app
bun.cmd typecheck
bun.cmd typecheck:e2e
```

All three commands exited 0.

Whitespace validation:

```powershell
& 'C:\Program Files\Git\cmd\git.exe' diff --check
```

Result: no whitespace errors; Git only printed existing CRLF-to-LF checkout warnings.

## Self-review

- IDs are supplied only on create. Update methods accept scoped lookup IDs plus mutable fields and ignore no caller-supplied replacement ID.
- Every mutation validates its scoped IDs and runs `validateEnterpriseProviderCatalog` over the complete candidate catalog before persistence.
- Default fallback is deterministic: same provider's first remaining model, then the first model in provider order, then no default.
- One promise queue covers reads and mutations; a later mutation cannot enter its snapshot/persist/restart sequence before the earlier restart or rollback recovery finishes.
- Candidate and previous states always contain both stores. Candidate restart, recovery persistence, and recovery restart use those paired states.
- Complete credential replacement removes omitted API keys and replaces all headers. Clear preserves the provider credential record as `{ headers: {} }`; provider deletion removes that record.
- Views never contain API keys or header values. Error objects expose stable codes instead of caught restart details.
- Startup initialization handles missing state, v1 credentials, v2 credentials, existing v3 state, and retry after an interrupted migration without rewriting healthy v3 credentials.
- Normal startup and all restart paths receive catalog plus credentials. Ordinary startup receives neither.
- The preload/App surface contains the exact ten requested provider methods and no old model-scoped credential methods.
- No commit, push, generated-code edit, or public HTTP/API change was made.

## Concerns

- The full Playwright e2e browser suite was not executed. Its fixture, assertions, and separate TypeScript project were updated, and `bun.cmd typecheck:e2e` passes.
- The worktree contains intentional uncommitted Task 1/2 changes and SDD artifacts owned by the parent workflow. They remain untouched except where Task 3 necessarily integrated with their exported boundaries.
- The brief's rollback sample used an always-failing restart callback while expecting `restart_failed_rolled_back`; its transaction pseudocode requires the second failed recovery restart to report `restart_failed_recovery_failed`. Tests therefore distinguish a first-only restart failure from an always-failing recovery, matching the specified pseudocode and explicit recovery-error requirement.

## Post-review corrections

The review identified four issues. Each correction was driven by a failing regression test before its implementation changed.

### 1. Persistence failure rollback

Added runtime regressions proving that a candidate credential-write failure restores both the catalog and credential stores without restarting, and that a failed recovery write exposes only `restart_failed_recovery_failed`.

RED, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts
```

Result: exit 1, `12 pass`, `2 fail`. The catalog remained on the candidate state after credential persistence failed, and the recovery-write failure leaked the candidate credential error.

GREEN: `14 pass`, `0 fail`, `33 expect() calls`. Candidate persistence is now wrapped in paired-store recovery. Successful recovery rethrows the original persistence error and never restarts; failed recovery emits the stable recovery code.

### 2. Credential-store health gate

Added parameterized corrupt/encryption-unavailable tests for startup, catalog reads, and mutations. They prove that mutations fail before snapshots, writes, or restarts; redacted catalog views remain available; and startup leaves both durable files byte-for-byte unchanged.

RED, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts
```

Result: exit 1, `14 pass`, `4 fail`; unhealthy mutations and startup incorrectly resolved.

GREEN: `18 pass`, `0 fail`, `49 expect() calls`. Initialization and mutations now reject with `credential_decryption_failed` or `credential_encryption_unavailable` before reading a credential snapshot or writing either store. Catalog views use catalog-only redaction while unhealthy.

### 3. Provider-scoped App identity

Added a duplicate-model-ID App regression with two providers. It requires exactly one scoped default, the correct selected credential state, and a diagnostic request containing the selected provider and model IDs.

RED, from `packages/app`:

```powershell
bun.cmd test ./src/components/dialog-company-provider.test.ts
```

Result: exit 1, `11 pass`, `1 fail`; scalar model identity could not identify the default provider.

GREEN: `12 pass`, `0 fail`, `25 expect() calls`. The provider dialog state, default selection, readiness, in-flight operation identity, save, clear, and diagnose paths now use `{ providerID, modelID }`.

### 4. Shared sidecar transition queue

Added a runtime regression that overlaps provider and skill-pack transitions, rejects the first transition, and requires subsequent transitions to remain serialized and runnable.

RED, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts
```

Result: exit 1 because the process-level transition queue did not exist.

GREEN: `19 pass`, `0 fail`, `53 expect() calls`. Main startup now gives provider-runtime and skill-pack restarts the same rejection-safe transition queue, preventing overlapping enterprise sidecar kill/start sequences while allowing later work after a failure.

## Post-review final verification

- Exact Task 3 suite: `39 pass`, `0 fail`, `104 expect() calls` across six files.
- Desktop integration regressions: `41 pass`, `0 fail`, `135 expect() calls` across five files.
- App provider/guide regressions: `17 pass`, `0 fail`, `35 expect() calls` across two files.
- `bun.cmd typecheck` passed in `packages/desktop` and `packages/app`; `bun.cmd typecheck:e2e` passed in `packages/app`.
- `git diff --check` exited 0 with only CRLF-to-LF checkout warnings.
- No commit or push was created.

## Post-review startup health correction

The remaining review issue was in the real Electron main startup path. `initializeEnterpriseProviderStores()` correctly rejected unhealthy credentials for explicit migration calls, but `index.ts` treated that rejection as fatal after `app.whenReady()`. Main therefore stopped before IPC registration, sidecar startup, and window restoration. Main also reread the credential store for ordinary sidecar starts without consulting health first.

### RED: real-main unhealthy credential startup

Added a main-entrypoint integration regression covering both `corrupt` and `encryption-unavailable` credential health. The corrupt case starts with a readable existing catalog; the encryption-unavailable case starts without a catalog and requires packaged non-secret catalog seeding. The harness uses real catalog and credential files and a real credential store while isolating Electron/process boundaries.

The regression requires:

- main startup and IPC registration to complete;
- `providerCatalog()` to return the readable/seeded catalog with the stable credential `errorCode` and no secret values;
- the initial sidecar to receive an empty schema-v3 credential provider map, including when the test decryptor could otherwise read the unavailable blob;
- credential replacement to reject with the same stable health code;
- the credential file bytes and a fixed pre-test modification timestamp to remain unchanged, proving no durable credential write occurred;
- startup output to contain none of the corrupt, unavailable, replacement, or header secret markers.

Command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/index.test.ts
```

RED result: exit 1, `10 pass`, `1 fail`, `35 expect() calls`. `providerCatalog` was `undefined`, confirming that the unhealthy credential initializer aborted main before IPC registration.

### GREEN: health-aware main initialization and state reads

Main now checks credential health before migration. For corrupt or encryption-unavailable credentials it initializes only the non-secret catalog, preserving an existing catalog or seeding a missing catalog from the packaged profile without reading or writing the credential blob. Initial and skill-pack sidecar starts, readiness, and support export use a shared health-aware credential read that returns an empty in-memory schema-v3 payload while unhealthy. The transactional runtime retains its existing health gate, so every catalog and secret mutation remains blocked.

Focused GREEN result: exit 0, `11 pass`, `0 fail`, `56 expect() calls`.

### Startup correction final verification

- Exact Task 3 suite: `40 pass`, `0 fail`, `128 expect() calls` across six files.
- Desktop integration regressions: `41 pass`, `0 fail`, `135 expect() calls` across five files.
- Affected App provider/guide regressions: `17 pass`, `0 fail`, `35 expect() calls` across two files.
- `bun.cmd typecheck` passed in `packages/desktop` and `packages/app`.
- `bun.cmd typecheck:e2e` passed in `packages/app`.
- `git diff --check` exited 0 with only CRLF-to-LF checkout warnings.
- Full Playwright browser execution remains outside this task's verification; its TypeScript project passes.
- No commit or push was created.
