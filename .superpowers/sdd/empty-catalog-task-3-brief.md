### Task 3: Seed New Users Empty and Preserve Existing Catalogs

**Files:**

- Modify: `packages/desktop/src/main/enterprise-providers.test.ts`
- Modify if required by RED: `packages/desktop/src/main/enterprise-providers.ts`
- Modify: `packages/desktop/src/main/enterprise-provider-runtime.test.ts`
- Modify if required by RED: `packages/desktop/src/main/enterprise-provider-runtime.ts`
- Modify: `packages/desktop/.env.enterprise.example`
- Modify locally: `packages/desktop/.env` (ignored; do not commit)

**Interfaces:**

- Consumes: Task 1 empty profile and Task 2 valid empty manifest.
- Produces: first-launch schema-v1 `{ providers: [] }`, preserved existing catalogs, and a runtime view with no default until the first model is created.

- [ ] **Step 1: Add catalog initialization regressions**

Add two tests:

```ts
test("seeds an empty catalog for a new user with no packaged models", async () => {
  const result = await store.initialize({ models: [], defaultModelID: "" })
  expect(result.catalog).toEqual({ schemaVersion: 1, providers: [] })
  expect(await store.read()).toEqual(result.catalog)
})

test("preserves an existing user catalog when packaged models are empty", async () => {
  await store.write(existing)
  expect((await store.initialize({ models: [], defaultModelID: "" })).catalog).toEqual(existing)
})
```

- [ ] **Step 2: Run the provider tests and verify the actual state**

Run:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts -t "empty catalog|packaged models are empty"
```

Expected: either RED identifying a real initialization gap or GREEN proving the existing read-before-seed implementation already satisfies the contract. Do not add production code if the test is already green.

- [ ] **Step 3: Add a startup/runtime empty-profile regression**

Exercise startup with no catalog file, `models: []`, and `defaultModelID: ""`. Assert:

```ts
expect(await runtime.providerCatalog()).toMatchObject({ providers: [], default: undefined })
```

Then create a provider and its first model and assert that model becomes the default. Also verify an existing on-disk catalog is returned unchanged under the empty profile.

- [ ] **Step 4: Run runtime tests and make only RED-driven fixes**

Run:

```powershell
bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "empty packaged profile|first model"
```

If credential migration incorrectly invents an empty provider/model ID or marks healthy empty credentials as corrupt, fix that narrow boundary without weakening orphan-credential validation.

- [ ] **Step 5: Update the example and local Desktop environment**

Set both files to the supported empty configuration and remove legacy model variables:

```env
LOCAL_TEST=1
OPENCODE_ENTERPRISE=1
OPENCODE_ENTERPRISE_MODELS=[]
OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID=
OPENCODE_ENTERPRISE_ALLOWED_ORIGINS=
OPENCODE_ENTERPRISE_DEFAULTS_VERSION=dev-1
OPENCODE_ENTERPRISE_GUIDE_VERSION=pilot-1
OPENCODE_ENTERPRISE_CATALOG_VERSION=dev-1
```

Keep `LOCAL_TEST=1` only in the local `.env`; omit it from `.env.enterprise.example`.

- [ ] **Step 6: Run final Desktop verification**

Run from `packages/desktop`:

```powershell
bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./src/main/enterprise-providers.test.ts ./src/main/enterprise-provider-runtime.test.ts
bun.cmd typecheck
```

Then run the build using the empty profile:

```powershell
$env:OPENCODE_CHANNEL='dev'
bun.cmd run build
```

Expected: all focused tests and typecheck exit 0; prebuild writes and verifies an empty `models.json`/manifest; Electron main, preload, and renderer bundles complete.

- [ ] **Step 7: Inspect the final diff and configuration**

Run:

```powershell
& 'C:\Program Files\Git\cmd\git.exe' diff --check
Get-Content .env
```

Expected: diff check exit 0 and `.env` contains no packaged model, endpoint, API key, or legacy model variables.
