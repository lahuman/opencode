# Empty Enterprise Catalog Task 1 Report

## Status

Implemented and verified. No commit or push was performed.

## Changed files

- `packages/desktop/src/enterprise-profile.ts`
- `packages/desktop/src/enterprise.test.ts`
- `packages/desktop/scripts/enterprise-build.ts`
- `packages/desktop/scripts/enterprise-build.test.ts`
- `packages/desktop/electron.vite.config.test.ts`

## RED / GREEN evidence

All commands were run from `packages/desktop` with `bun.cmd`.

### Runtime profile RED

Command:

```powershell
bun.cmd test ./src/enterprise.test.ts -t "explicit empty|mixed empty"
```

Result before implementation: exit 1; 0 pass, 2 fail, 21 filtered out. Both focused tests failed because `parseModels()` threw `OPENCODE_ENTERPRISE_MODELS must contain at least one model`; the mixed-state assertion consequently received the model-array error instead of `OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID`.

### Runtime profile GREEN

Command:

```powershell
bun.cmd test ./src/enterprise.test.ts -t "explicit empty|mixed empty"
```

Result after implementation: exit 0; 2 pass, 0 fail, 21 filtered out, 4 assertions.

### Package build RED

Command:

```powershell
bun.cmd test ./scripts/enterprise-build.test.ts -t "empty Enterprise catalog|mixed empty"
```

Result before implementation: exit 1; 0 pass, 2 fail, 22 filtered out. Both focused tests failed because the independent package validator threw `OPENCODE_ENTERPRISE_MODELS must contain at least one model`; the mixed-state assertion consequently received the model-array error instead of `OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID`.

### Package build GREEN

Command:

```powershell
bun.cmd test ./scripts/enterprise-build.test.ts -t "empty Enterprise catalog|mixed empty"
```

Result after implementation: exit 0; 2 pass, 0 fail, 22 filtered out, 3 assertions.

### Full scoped verification

Command:

```powershell
bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts
```

Result: exit 0; 52 pass, 0 fail, 212 assertions across 3 files.

Additional package verification:

```powershell
bun.cmd typecheck
```

Result: exit 0 (`tsgo -b`).

## Self-review and concerns

- Runtime and package validation use the same JSON-array acceptance rule, default selection, and mixed-state predicate.
- Existing model metadata, duplicate-ID, and URL validation branches were preserved.
- The package validator's stricter portable URL validation was not changed.
- The empty state produces `models: []`, `defaultModelID: ""`, and `allowedOrigins: []`, and Vite injects `"[]"` plus `""` for both main and renderer.
- No Task 1 concerns remain. Existing unrelated uncommitted files were left untouched.

## Review follow-up: complete default matrix

Added parameterized runtime and package-validator coverage for the complete documented matrix:

- Empty catalog with an omitted, empty, or whitespace-only default is accepted and normalized to `defaultModelID: ""`.
- Empty catalog with a nonblank default is rejected.
- Non-empty catalog with an omitted, empty, or whitespace-only default is rejected.
- Non-empty catalog with a valid configured default is accepted.
- Electron Vite injection is verified with both a blank and an omitted default environment key.

No production source changed during this follow-up.

Focused matrix command:

```powershell
bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts -t "default matrix|explicit empty Enterprise catalog"
```

Result: exit 0; 19 pass, 0 fail, 50 filtered out, 20 assertions across 3 files.

The first full-suite verification was run concurrently with typecheck. Typecheck exited 0, while the suite reported 68 pass and 1 fail because the ordinary Vite configuration test's child process exceeded Bun's 5-second test timeout under the competing load. All other tests, including both Vite empty-catalog cases, passed. The unchanged suite was rerun by itself to isolate resource contention:

```powershell
bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts
```

Final isolated result: exit 0; 69 pass, 0 fail, 229 assertions across 3 files.

Package typecheck command:

```powershell
bun.cmd typecheck
```

Result: exit 0 (`tsgo -b`).
