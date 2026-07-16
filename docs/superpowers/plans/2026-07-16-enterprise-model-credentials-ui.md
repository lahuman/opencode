# Enterprise Model Credentials UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authoritative, model-by-model Enterprise credential settings experience with safe restart handling and no secret exposure.

**Architecture:** Electron main projects the startup Enterprise profile and encrypted store into a non-secret credential catalog. The App merges that catalog with the sidecar public catalog, renders all models as status rows, and enables editing only for synchronized models. Existing model-specific mutation IPC remains the final validation boundary.

**Tech Stack:** TypeScript, SolidJS, Electron IPC/preload, Bun tests, Playwright, Electron Vite

## Global Constraints

- API keys and secret headers remain DPAPI encrypted and never enter `.env`, public config, manifests, release metadata, or logs.
- Public Server `HttpApi` is unchanged; do not generate SDKs.
- Run tests and `bun typecheck` only from package directories.
- Preserve the `company-llm` provider and model-specific mutation API.
- Do not merge into `enterprise-pilot`.

---

### Task 1: Authoritative credential catalog

**Files:**
- Modify: `packages/desktop/src/main/enterprise-credentials.ts`
- Modify: `packages/desktop/src/main/enterprise-credentials.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/preload/types.test.ts`
- Modify: `packages/app/src/context/platform.tsx`

**Interfaces:**
- Produces: `credentialCatalog(): Promise<EnterpriseCredentialCatalog>`
- `EnterpriseCredentialCatalog` contains `defaultModelID` and public model metadata plus `{ configured, errorCode? }`; it contains no API key or headers.

- [ ] **Step 1: Write failing store, IPC, and preload tests**

Assert that two configured models return two status rows, removed credentials are ignored, corrupt/encryption failures use safe error codes, and serialized results contain no secret strings.

- [ ] **Step 2: Run the focused Desktop tests and verify RED**

Run from `packages/desktop`:

```powershell
bun test src/main/enterprise-credentials.test.ts src/main/ipc.test.ts src/preload/types.test.ts
```

Expected: FAIL because `credentialCatalog` is absent.

- [ ] **Step 3: Implement the minimal catalog projection and IPC wiring**

Read the encrypted map once, project one result per `ENTERPRISE_PROFILE.models` entry, and expose it through main, IPC, preload, and the App platform type.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
bun test src/main/enterprise-credentials.test.ts src/main/ipc.test.ts src/preload/types.test.ts
bun typecheck
```

Expected: all pass.

### Task 2: Catalog merge and model action policy

**Files:**
- Modify: `packages/app/src/components/dialog-company-provider-state.ts`
- Modify: `packages/app/src/components/dialog-company-provider.test.ts`

**Interfaces:**
- Consumes: `EnterpriseCredentialCatalog` and `CompanyConfig` public models.
- Produces: a pure merged model-row projection with `synchronized`, `credentialStatus`, `isDefault`, and action eligibility.

- [ ] **Step 1: Write failing merge tests**

Cover exact catalogs, main-only models, sidecar-only models, URL mismatch, default ordering, and safe status text.

- [ ] **Step 2: Run the App unit test and verify RED**

```powershell
bun test src/components/dialog-company-provider.test.ts
```

- [ ] **Step 3: Implement the pure merge projection**

Keep main metadata authoritative for mutations, retain sidecar-only rows for restart guidance, and never copy secret-shaped fields.

- [ ] **Step 4: Run the unit test and typecheck**

```powershell
bun test src/components/dialog-company-provider.test.ts
bun typecheck
```

### Task 3: Model list and selected-model editor

**Files:**
- Modify: `packages/app/src/components/dialog-company-provider.tsx`
- Modify: `packages/app/src/components/settings-providers.tsx`
- Modify: `packages/app/src/components/settings-v2/providers.tsx`
- Modify: `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- Modify: `packages/app/e2e/company-llm-enterprise.spec.ts`

**Interfaces:**
- Consumes: merged model rows from Task 2.
- Produces: visible list rows and selected-model credential actions.

- [ ] **Step 1: Extend the E2E fixture and write failing scenarios**

Assert two model rows with URLs/statuses, default selection, state reset on selection, model-specific save/clear/diagnose, and disabled `Restart required` rows.

- [ ] **Step 2: Run focused Playwright and verify RED**

```powershell
playwright test e2e/company-llm-enterprise.spec.ts --grep "Company LLM"
```

- [ ] **Step 3: Implement the list/editor layout and restart banner**

Load `credentialCatalog()` once, merge with public config, select the default row, refresh after mutations, and disable actions for unsynchronized rows or catalog errors.

- [ ] **Step 4: Run focused App tests, Playwright, and type checks**

```powershell
bun test src/components/dialog-company-provider.test.ts
bun typecheck
bun run typecheck:e2e
playwright test e2e/company-llm-enterprise.spec.ts --grep "Company LLM"
```

### Task 4: Toast cleanup ownership

**Files:**
- Modify: `packages/app/src/utils/toast.tsx`
- Modify: `packages/ui/src/v2/components/toast-v2.tsx`
- Test: relevant existing toast unit test or a focused new test beside the adapter

**Interfaces:**
- Preserves: `showToast({ icon: "circle-check" })` caller API.
- Changes: V2 icon creation is deferred into the toaster-owned callback.

- [ ] **Step 1: Write a failing deferred-icon test**

Assert that resolving toast options does not construct the icon until the toast render callback executes.

- [ ] **Step 2: Run the focused test and verify RED**

- [ ] **Step 3: Pass a lazy icon factory and resolve it inside `showToastV2`**

- [ ] **Step 4: Run App/UI tests and package type checks**

### Task 5: Final verification and branch handoff

**Files:**
- Verify all modified files

- [ ] **Step 1: Run Desktop focused suites and `bun typecheck` from `packages/desktop`**
- [ ] **Step 2: Run App unit, E2E typecheck, and focused Playwright from `packages/app`**
- [ ] **Step 3: Run OpenCode Enterprise regression tests and `bun typecheck` from `packages/opencode`**
- [ ] **Step 4: Run a two-model Enterprise Desktop build**
- [ ] **Step 5: Run `git diff --check`, inspect secret exposure, and perform read-only code review**
- [ ] **Step 6: Commit to `enterprise-pilot-multi-model` and preserve the worktree without merging**
