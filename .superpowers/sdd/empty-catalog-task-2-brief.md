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
  guideVersion: "pilot-1",
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

