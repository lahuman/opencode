### Task 6: Run cross-package verification and Enterprise build checks

**Files:**
- Modify only if a test exposes an implementation defect in Tasks 1-5.

**Interfaces:**
- Verifies all previously produced interfaces; introduces no new API.

- [ ] **Step 1: Run Desktop tests and type checking**

From `packages/desktop`:

```powershell
bun test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts ./src/main/enterprise-provider-runtime.test.ts ./src/main/sidecar-startup.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 2: Run OpenCode Enterprise/provider tests and type checking**

From `packages/opencode`:

```powershell
bun test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts ./test/provider/diagnostic.test.ts
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 3: Run App unit, browser, E2E typecheck, and focused Playwright tests**

From `packages/app`:

```powershell
bun run test:unit
bun run test:browser
bun typecheck
bun run typecheck:e2e
bun run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

Expected: all tests PASS, type checks exit 0, and Playwright records no failed desktop/compact scenario.

- [ ] **Step 4: Build the Enterprise Desktop application**

From `packages/desktop`:

```powershell
bun run build
```

Expected: Electron Vite builds main, preload, and renderer bundles successfully with the Enterprise environment supplied by the existing prebuild hook.

- [ ] **Step 5: Inspect the final diff and secret boundary**

From the repository root:

```powershell
git diff --check origin/dev...HEAD
git diff --name-only origin/dev...HEAD
rg -n "apiKey|headers" packages/desktop/src/preload packages/app/src/components/dialog-company-provider.tsx
```

Expected: no whitespace errors; public renderer/preload response types contain only `configured`, `headerNames`, and error codes, never secret values.
