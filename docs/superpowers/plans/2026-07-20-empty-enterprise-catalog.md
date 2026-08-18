# Empty Enterprise Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a SFMI Enterprise desktop package to start new users with zero providers and models while preserving every existing Windows user-global catalog.

**Architecture:** Treat `OPENCODE_ENTERPRISE_MODELS=[]` plus a blank or omitted default model ID as one valid packaged-profile state. Keep the existing profile and manifest fields stable by representing “no default” as `""`, conditionally validate the model/default pair, and retain catalog read-before-seed behavior so only a missing catalog is initialized empty.

**Tech Stack:** TypeScript, Bun test, Electron Vite, Electron Builder, Windows user-global JSON/DPAPI persistence.

## Global Constraints

- Existing valid user-global provider catalogs remain authoritative and are never cleared by an empty packaged profile.
- Non-empty JSON catalogs still require `OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID` to reference a packaged model.
- Legacy single-model variables retain their current required-field behavior.
- Manifest schema versions and public Protocol/Server `HttpApi` remain unchanged.
- Do not edit generated SDK files.
- Run tests from `packages/desktop` with `bun.cmd`; run `bun.cmd typecheck`, never `tsc`.
- Do not commit or push; the user will commit.

---

### Task 1: Accept an Explicit Empty Enterprise Build Profile

**Files:**

- Modify: `packages/desktop/src/enterprise-profile.ts`
- Modify: `packages/desktop/src/enterprise.test.ts`
- Modify: `packages/desktop/scripts/enterprise-build.ts`
- Modify: `packages/desktop/scripts/enterprise-build.test.ts`
- Modify: `packages/desktop/electron.vite.config.test.ts`

**Interfaces:**

- Consumes: `OPENCODE_ENTERPRISE_MODELS` JSON and `OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID`.
- Produces: an enabled profile/build metadata value with `models: []`, `defaultModelID: ""`, and `allowedOrigins: []` for the explicit empty state.

- [ ] **Step 1: Add failing runtime-profile tests**

Add tests that express the valid pair and invalid mixed states:

```ts
test("accepts an explicit empty Enterprise catalog", () => {
  const profile = parseEnterpriseProfile({
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_MODELS: "[]",
    OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "dev-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "sfmi-1",
    OPENCODE_ENTERPRISE_CATALOG_VERSION: "dev-1",
  })

  expect(profile).toMatchObject({ enabled: true, models: [], defaultModelID: "", allowedOrigins: [] })
  expect(enterpriseEnvironment(profile, { defaults: "C:/defaults", guide: "C:/guide" })).toMatchObject({
    OPENCODE_ENTERPRISE_MODELS: "[]",
    OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
  })
})

test("rejects mixed empty-catalog default states", () => {
  expect(() => parseEnterpriseProfile({ ...emptyEnv, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "ghost" })).toThrow(
    "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
  )
  expect(() => parseEnterpriseProfile({ ...nonEmptyEnv, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "" })).toThrow(
    "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
  )
})
```

Remove `[]` from the existing generic invalid-model array because emptiness is now validated separately.

- [ ] **Step 2: Run the runtime-profile tests and verify RED**

Run:

```powershell
bun.cmd test ./src/enterprise.test.ts -t "explicit empty|mixed empty"
```

Expected: FAIL because `parseModels()` rejects an empty array and the default is always required.

- [ ] **Step 3: Implement conditional profile validation**

Make JSON-array parsing accept an empty array while retaining array/type/duplicate validation. Compute the default with this contract:

```ts
const defaultModelID = env.OPENCODE_ENTERPRISE_MODELS
  ? models.length
    ? requireValue(env, "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
    : env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID?.trim() ?? ""
  : models[0].id

if (
  (models.length === 0 && defaultModelID) ||
  (models.length > 0 && !models.some((model) => model.id === defaultModelID))
) {
  throw new Error("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID must reference a configured model")
}
```

Change only the array check from “non-empty array” to “array.” Preserve every model metadata and URL validation branch.

- [ ] **Step 4: Add and run equivalent package-build RED tests**

In `scripts/enterprise-build.test.ts`, assert that `validateEnterpriseBuild()` returns the same empty metadata and rejects both mixed states. Run:

```powershell
bun.cmd test ./scripts/enterprise-build.test.ts -t "empty Enterprise catalog|mixed empty"
```

Expected: FAIL for the same minimum-model/default requirements in the independent packaging validator.

- [ ] **Step 5: Apply the same conditional contract to the package validator**

Update `scripts/enterprise-build.ts` with the same default computation and conditional validation. Do not weaken its stricter portable URL validation.

- [ ] **Step 6: Verify profile, build, and Vite injection behavior**

Add an Electron Vite config case with `OPENCODE_ENTERPRISE_MODELS: "[]"` and blank default, asserting the injected definitions contain `"[]"` and `""`. Run:

```powershell
bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts
```

Expected: PASS with zero failures.

---

### Task 2: Permit the Empty Pair in Enterprise Manifest and Preflight

**Files:**

- Modify: `packages/desktop/src/main/enterprise-preflight.ts`
- Modify: `packages/desktop/src/main/enterprise-preflight.test.ts`
- Modify: `packages/desktop/scripts/enterprise-manifest.test.ts`
- Test: `packages/desktop/scripts/enterprise-release.test.ts`
- Test: `packages/desktop/scripts/verify-enterprise-package.test.ts`

**Interfaces:**

- Consumes: Task 1 build metadata with `models: []` and `defaultModelID: ""`.
- Produces: schema-v2 manifest data containing `modelIDs: []`, the deterministic hash of `[]`, and `defaultModelID: ""`.

- [ ] **Step 1: Add failing empty-manifest tests**

Add a preflight test that creates, writes, and verifies this profile:

```ts
const emptyProfile = {
  models: [],
  defaultModelID: "",
  defaultsVersion: "dev-1",
  guideVersion: "sfmi-1",
  catalogVersion: "dev-1",
  allowedOrigins: [],
}

test("creates and verifies an empty Enterprise model manifest", async () => {
  await using fixture = await enterpriseFixture()
  const manifest = await createEnterpriseManifest({ appVersion: "1.2.3", profile: emptyProfile, resources: fixture.resources })
  expect(manifest).toMatchObject({ defaultModelID: "", modelIDs: [], allowedOrigins: [] })
  await writeEnterpriseManifest(fixture.manifest, manifest)
  expect(await verifyEnterpriseManifest({ manifest: fixture.manifest, appVersion: "1.2.3", profile: emptyProfile, resources: fixture.resources })).toEqual(manifest)
})
```

Add invalid manifest cases for `modelIDs: []` with a non-empty default and non-empty `modelIDs` with an empty default.

- [ ] **Step 2: Run the manifest tests and verify RED**

Run:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts -t "empty Enterprise model manifest|empty default"
```

Expected: FAIL because identity calculation rejects zero models and manifest decoding requires non-empty `defaultModelID`.

- [ ] **Step 3: Implement a shared catalog/default pair check**

Allow `enterpriseModelCatalogIdentity([])` and keep its hash deterministic:

```ts
if (new Set(modelIDs).size !== modelIDs.length) invalidManifest()
```

Replace unconditional membership checks with the exact pair rule:

```ts
function validDefaultModel(modelIDs: string[], defaultModelID: string) {
  if (modelIDs.length === 0) return defaultModelID === ""
  return isText(defaultModelID) && modelIDs.includes(defaultModelID)
}
```

Use it in manifest creation and decoding. Decode `defaultModelID` as a string whose whitespace is normalized exactly, allowing only the empty string for the empty list. Preserve all resource hashes, sorted model ID, origin, and exact-key validation.

- [ ] **Step 4: Verify manifest generation and package consumers**

Add an empty-profile case to `scripts/enterprise-manifest.test.ts`. Run:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./scripts/enterprise-release.test.ts ./scripts/verify-enterprise-package.test.ts
```

Expected: PASS. Existing non-empty release metadata and package integrity tests must remain unchanged and green.

---

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
OPENCODE_ENTERPRISE_GUIDE_VERSION=sfmi-1
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
