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
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
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

