# Empty Enterprise Catalog Task 3 Report

## Status

Implemented and verified. No commit or push was performed.

Task-scoped provider and runtime tests, Desktop typecheck, the filtered seven-file verification, the empty-profile dev build, and diff hygiene pass. The exact unfiltered seven-file command still has one pre-existing manifest-version failure documented under Concerns.

## Changed files

Tracked:

- packages/desktop/src/main/enterprise-providers.test.ts
- packages/desktop/src/main/enterprise-provider-runtime.test.ts
- packages/desktop/src/main/enterprise-provider-runtime.ts
- packages/desktop/.env.enterprise.example

Ignored local configuration:

- packages/desktop/.env

packages/desktop/src/main/enterprise-providers.ts did not change because its existing read-before-seed behavior passed the new regressions on their first run.

## RED

### Catalog initialization regressions

Command from packages/desktop:

    bun.cmd test ./src/main/enterprise-providers.test.ts -t "empty catalog|packaged models are empty"

The first run was already GREEN: exit 0, 3 pass, 8 filtered out, 0 fail, and 5 assertions. This proved that a missing file is seeded as schema-v1 providers: [], the catalog is persisted, and an existing user catalog wins over an empty packaged profile. No provider-store production change was made.

### Runtime empty-profile regression

Command:

    bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "empty packaged profile|first model"

Initial result: exit 1, 2 pass, 23 filtered out, 1 fail, and 4 assertions.

The empty startup produced schemaVersion: 1 and providers: [] without inventing credentials or provider/model IDs, and the existing-catalog case passed. The failing assertion identified the public view-shape gap: providerCatalog() omitted the default key instead of returning default: undefined.

## GREEN

The narrow production fix sets default: state.catalog.default in the runtime view. Catalog persistence, credential migration, and requireCredentialMembership were not changed.

Focused runtime rerun:

    bun.cmd test ./src/main/enterprise-provider-runtime.test.ts -t "empty packaged profile|first model"

Result: exit 0, 3 pass, 23 filtered out, 0 fail, and 5 assertions. Empty startup returns providers: [] with default: undefined; after creating a provider and its first model, that model becomes the default; an existing on-disk catalog remains unchanged under the empty packaged profile.

Full Task 3 provider/runtime verification:

    bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-provider-runtime.test.ts

Result: exit 0, 37 pass, 0 fail, and 89 assertions. The unchanged runtime tests that reject orphan provider credentials passed.

## Configuration

The tracked example is:

    OPENCODE_ENTERPRISE=1
    OPENCODE_ENTERPRISE_MODELS=[]
    OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID=
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS=
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION=dev-1
    OPENCODE_ENTERPRISE_GUIDE_VERSION=pilot-1
    OPENCODE_ENTERPRISE_CATALOG_VERSION=dev-1

The ignored packages/desktop/.env contains the same seven settings with LOCAL_TEST=1 as its first line. Inspection confirmed there are no packaged model IDs, endpoints, API keys, secrets, legacy OPENCODE_ENTERPRISE_MODEL_ID / MODEL_NAME variables, or OPENCODE_ENTERPRISE_BASE_URL.

## Build

Command from packages/desktop:

    $env:OPENCODE_CHANNEL='dev'
    bun.cmd run build

Result: exit 0. Prebuild completed, then Electron main, preload, and renderer bundles completed. The generated manifest has schemaVersion 2, modelIDs: [], defaultModelID: "", allowedOrigins: [], and modelCatalogSHA256 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945. The generated models.json is the empty object used by the packaged credential resource.

Non-fatal existing Vite/Rollup warnings about eval, mixed dynamic/static imports, the non-module theme preload script, and a duplicated sourcemap were emitted; the build still exited 0.

## Results

Exact required seven-file test command:

    bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./src/main/enterprise-providers.test.ts ./src/main/enterprise-provider-runtime.test.ts

Result: exit 1, 117 pass, 1 fail, and 351 assertions. Every Task 3 test and the orphan-credential rejection passed. The sole failure is the pre-existing manifest guide-version mismatch under Concerns.

The same suite excluding only that named pre-existing failure:

    bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./src/main/enterprise-providers.test.ts ./src/main/enterprise-provider-runtime.test.ts -t "^(?!keeps the generated SFMI guide and manifest version aligned$).*"

Result: exit 0, 117 pass, 1 filtered out, 0 fail, and 350 assertions.

Typecheck:

    bun.cmd typecheck

Result: exit 0 (tsgo -b).

Diff and local configuration inspection:

    & 'C:\Program Files\Git\cmd\git.exe' diff --check
    Get-Content .env

Result: diff check exit 0 with no output. The local environment contains exactly the supported empty profile plus LOCAL_TEST=1.

The scoped tracked review package is .superpowers/sdd/empty-catalog-task-3-review.diff. It separately notes the ignored local .env.

## Concerns

- The exact seven-file suite retains the Task 2 checkout inconsistency: scripts/enterprise-manifest.test.ts expects guideVersion "sfmi-1", while the unchanged ignored packaged manifest contains "pilot-1". This task's required empty configuration also explicitly uses pilot-1. No out-of-scope resource or test was changed to mask the failure.
- The build emits the existing non-fatal Vite/Rollup warnings listed above.
- No Task 3 behavior concern remains: existing catalogs win over the empty packaged profile, new users start empty, the first created model becomes the default, healthy empty credentials remain healthy, and orphan credential rejection remains enforced.
