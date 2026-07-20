# Empty Enterprise Catalog Task 2 Report

## Scope

Modified only the Task 2 implementation and test files:

- `packages/desktop/src/main/enterprise-preflight.ts`
- `packages/desktop/src/main/enterprise-preflight.test.ts`
- `packages/desktop/scripts/enterprise-manifest.test.ts`

No commit or push was created.

## RED

From `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts -t "empty Enterprise model manifest|empty default"
```

Result: exit 1, `1 pass`, `1 fail`, `6 filtered out`. The empty-manifest success test failed at `enterpriseModelCatalogIdentity` because the production guard rejected `modelIDs.length === 0`. The asymmetric invalid-pair test already passed because the old decoder rejected both invalid states.

The generation-level empty-profile case was also verified RED before production changed:

```powershell
bun.cmd test ./scripts/enterprise-manifest.test.ts -t "empty Enterprise model manifest"
```

Result: exit 1, `0 pass`, `1 fail`, `3 filtered out`, failing at the same zero-model catalog identity guard.

## GREEN

After replacing the unconditional membership rule with the shared catalog/default pair rule and allowing the empty catalog identity:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts -t "empty Enterprise model manifest|empty default"
```

Result: exit 0, `2 pass`, `0 fail`, `6 filtered out`, `4 expect() calls`.

```powershell
bun.cmd test ./scripts/enterprise-manifest.test.ts -t "empty Enterprise model manifest"
```

Result: exit 0, `1 pass`, `0 fail`, `3 filtered out`, `2 expect() calls`. The generated empty catalog uses schema version 2, `modelIDs: []`, `defaultModelID: ""`, `allowedOrigins: []`, and SHA-256 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` for JSON `[]`.

The first generation GREEN attempt reached the hash assertion but failed because the test literal contained a transcription error. Production emitted the correct SHA-256 above; correcting only the expected test literal made the focused test pass.

## Required consumer verification

The exact required command was run twice, including an unrestricted retry:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./scripts/enterprise-release.test.ts ./scripts/verify-enterprise-package.test.ts
```

Result both times: exit 1, `134 pass`, `3 fail`, `166 expect() calls`. Every Task 2 test, both unchanged enterprise-release tests, and all package-integrity tests that reached their assertions passed. The three failures are listed under Concerns.

The same four-file suite, filtering only those three unrelated failures, passed cleanly:

```powershell
bun.cmd test ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./scripts/enterprise-release.test.ts ./scripts/verify-enterprise-package.test.ts -t "^(?!keeps the generated Kernexa guide and manifest version aligned$)(?!rejects a required payload symlinked outside the package root$)(?!rejects an extra payload symlink in the unpacked tree$).*"
```

Result: exit 0, `134 pass`, `3 filtered out`, `0 fail`, `165 expect() calls`.

Type checking from `packages/desktop`:

```powershell
bun.cmd typecheck
```

Result: exit 0 (`tsgo -b`).

Diff hygiene:

```powershell
git diff --check -- packages/desktop/src/main/enterprise-preflight.ts packages/desktop/src/main/enterprise-preflight.test.ts packages/desktop/scripts/enterprise-manifest.test.ts
```

Result: exit 0 with no output.

## Behavior preserved

- Manifest `schemaVersion` remains exactly 2.
- Resource names, resource hashes, and exact-key validation are unchanged.
- Model IDs remain normalized, unique, and sorted.
- Allowed origins remain normalized, unique, and sorted.
- A non-empty catalog still requires a normalized non-empty default contained in `modelIDs`.
- Only the exact empty pair (`modelIDs: []`, `defaultModelID: ""`) is newly accepted.

## Concerns

- The checked-in `resources/enterprise/enterprise-manifest.json` has `guideVersion: "pilot-1"`, while the unchanged `keeps the generated Kernexa guide and manifest version aligned` test expects `kernexa-1`. Neither resource is modified in the worktree, so this is an existing checkout inconsistency outside Task 2.
- `rejects a required payload symlinked outside the package root` and `rejects an extra payload symlink in the unpacked tree` fail during test setup with Windows `EPERM` from `symlink(...)`. Retrying outside the sandbox produced the same result. Their implementation assertions are not reached.
- No out-of-scope resource or package-integrity test file was changed to mask these failures.
