# Task 6 report: cross-package verification and Enterprise build checks

## Status

DONE_WITH_CONCERNS. The Enterprise-focused verification, all three package typechecks, focused Playwright spec, Desktop build, working-tree whitespace check, and secret/readback scans passed after three small integration fixes. Two prescribed broad checks remain red for unrelated pre-existing state: two `solid-virtual.test.ts` browser assertions and one committed branch document with an extra blank line at EOF. No commit or push was created.

## Task 6 fixes

- `packages/opencode/test/provider/diagnostic.test.ts`: changed the real diagnostic endpoint fixture from schema-v2 model credentials to the current schema-v3 provider credentials. RED was the prescribed OpenCode suite at `53 pass / 1 fail`; the endpoint requests retained the project credential because the stale payload was rejected. The isolated test then passed `1/1`, and the full suite passed `54/54`.
- `packages/opencode/src/config/enterprise.ts` and `packages/opencode/test/config/enterprise.test.ts`: preserved the validated catalog default in a typed object across the callback boundary, narrowed sanitizer policy parameters to their only consumed field (`enabled`), removed stale `defaultModel` test policy fields, and completed a typed model-limit fixture. RED was `bun.cmd typecheck` with eight errors; an intermediate run reduced that to two `unknown` errors, and the final run exited 0.
- `packages/app/e2e/tsconfig.json` and `packages/app/src/components/titlebar.tsx`: included `src/env.d.ts` in the Enterprise E2E project so Solid's `use:sortable` augmentation is present, and narrowed the optional channel before `includes`/`toUpperCase`. RED was `bun.cmd run typecheck:e2e` with four errors in the two sortable components and titlebar; GREEN exited 0. The regular App typecheck also remained green.

All fixes were made against observed failing tests/typechecks. No generated source was edited.

## Desktop verification

Working directory: `E:\03.DEV\opencode\packages\desktop`

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts ./src/main/enterprise-provider-runtime.test.ts ./src/main/sidecar-startup.test.ts ./src/main/ipc.test.ts ./src/preload/types.test.ts ./src/main/index.test.ts
```

- Exit 0.
- `72 pass`, `0 fail`, `229 expect()` calls across seven files.

```powershell
bun.cmd typecheck
```

- Exit 0; `tsgo -b` completed.

## OpenCode verification

Working directory: `E:\03.DEV\opencode\packages\opencode`. Direct Bun tests used the required 30-second timeout.

```powershell
bun.cmd test --timeout 30000 ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts ./test/provider/diagnostic.test.ts
```

- Initial complete RED: exit 1, `53 pass`, `1 fail`, `185 expect()` calls. Failure: `diagnostic.test.ts:693` expected both requests to use the Enterprise bearer token.
- After the schema-v3 fixture fix and all typecheck fixes, fresh final result: exit 0, `54 pass`, `0 fail`, `186 expect()` calls across four files.

```powershell
bun.cmd test --timeout 30000 ./test/provider/diagnostic.test.ts -t "runs the diagnostic endpoint through the configured provider and enterprise credential overlay"
```

- Exit 0, `1 pass`, `0 fail`, five assertions after the fixture correction.

```powershell
bun.cmd typecheck
```

- Initial RED: exit 2 with eight errors in Enterprise production/test types.
- Intermediate RED: exit 2 with two remaining `unknown` catalog-default errors.
- Fresh final result: exit 0; `tsgo --noEmit` completed.

## App verification

Working directory: `E:\03.DEV\opencode\packages\app`

```powershell
bun.cmd run test:unit
```

- Fresh final result: exit 0, `670 pass`, `0 fail`, `1737 expect()` calls across 98 files.

```powershell
bun.cmd run test:browser
```

- Fresh final result: exit 1, `37 pass`, `2 fail`, `79 expect()` calls across 13 files.
- Both failures are in untouched `test-browser/solid-virtual.test.ts`:
  - `end anchoring survives consecutive resizes when the first scroll write is clamped`
  - `clamps oversized offsets with scroll margin and padding changes`
- These same failures were recorded in the Task 5 report. The file has no working-tree diff.

```powershell
bun.cmd test --conditions=browser --preload ./happydom.ts ./test-browser/solid-virtual.test.ts
```

- Isolated reproduction: exit 1, `3 pass`, `2 fail`, `11 expect()` calls. No unrelated fix was made.

```powershell
bun.cmd typecheck
```

- Fresh final result: exit 0; `tsgo -b` completed.

```powershell
bun.cmd run typecheck:e2e
```

- Initial RED: exit 2 with four errors: missing Solid `use:sortable` augmentation in two files and unsafe optional channel use in two titlebar expressions.
- Fresh final result after the E2E ambient-type and channel-narrowing fixes: exit 0; `tsgo -p e2e/tsconfig.json` completed.

```powershell
bun.cmd run test:e2e -- ./e2e/company-llm-enterprise.spec.ts
```

- Exit 0, `19 passed` using one Chromium worker in 1.3 minutes.
- Includes Enterprise provider CRUD/credentials/defaults/diagnostics/deletion, mutation/confirmation locks, New Session provider loading and empty state, ordinary composer preservation, both settings layouts, guide behavior, and desktop/mobile viewport scenarios.

## Desktop build

Working directory: `E:\03.DEV\opencode\packages\desktop`

```powershell
bun.cmd run build
```

- First attempt: exit 1 before compilation. The Bun child shell could not find `git` while deriving the channel.
- A second attempt with Git added to PowerShell's PATH failed identically because Bun's child shell still did not resolve `git`.

```powershell
$env:OPENCODE_CHANNEL = 'dev'; bun.cmd run build
```

- Exit 0.
- Prebuild generated the Enterprise manifest, loaded the `models.dev` snapshot, and built the OpenCode node bundle.
- Electron Vite built the main bundle (`57 modules`, 1m 5s), preload bundle (`4 modules`, 92ms), and renderer bundle (`2457 modules`, 50.54s).
- Non-fatal existing Vite warnings included eval use in the bundled node output, mixed static/dynamic imports, and a non-module theme preload script.

## Diff and whitespace checks

Working directory: repository root.

```powershell
git diff --check origin/dev...HEAD
```

- Exit 2 because `docs/superpowers/plans/2026-07-19-sfmi-brand.md:192` has a new blank line at EOF in committed branch history.
- That file is clean in the working tree and unrelated to Tasks 1-6, so it was not edited.

```powershell
git diff --name-only origin/dev...HEAD
```

- Exit 0; 245 paths listed.

Because Tasks 1-6 are intentionally uncommitted, the brief's three-dot commands do not inspect their working-tree content. Supplemental checks were therefore run:

```powershell
git diff --check
git diff --name-only
git status --short
```

- Working-tree diff check: exit 0 with only CRLF conversion warnings.
- 48 tracked working-tree files are changed; 78 status entries exist including the shared untracked SDD artifacts and new Task files.
- A trailing-whitespace `rg` scan across all untracked Task production/test files found no matches (exit 1, expected for no matches).

## Secret and readback boundary

```powershell
rg -n "apiKey|headers" packages/desktop/src/preload packages/app/src/components/dialog-company-provider.tsx
```

- Exit 0 because matches are expected in write-only App form state/input handling and one preload test input fixture.
- No preload production response field contains an API key or header value.

Contract inspection confirmed `EnterpriseProviderCatalogView.providers[].credentials` contains only:

- `configured: boolean`
- `headerNames: string[]`
- optional `errorCode` limited to `credential_decryption_failed` or `credential_encryption_unavailable`

Credential mutation inputs intentionally contain `apiKey` and `headers`, but every mutation returns the redacted catalog view above. The runtime view builder derives only configured state and header names.

```powershell
rg -n "enterprise-api-key|enterprise-header-value|project-api-key|project-header-value|sk-secret|secret-header-value|RAW_RESPONSE_BODY" packages/desktop/src/preload packages/app/src/components/dialog-company-provider.tsx
rg -n "enterprise-api-key|enterprise-header-value|project-api-key|project-header-value|sk-secret|secret-header-value|RAW_RESPONSE_BODY" packages/desktop/out/renderer
```

- Both scans found no matches (exit 1 is the expected no-match status).
- Plaintext secrets are not present in the public preload/dialog implementation or the built renderer output.

## Remaining risks

- The prescribed App browser suite remains red only for the two isolated, previously reported `solid-virtual` assertions. All Enterprise browser targets in that suite pass, and focused Enterprise Playwright passes 19/19.
- The prescribed branch-relative whitespace check remains red only for the unrelated committed SFMI plan EOF blank line; the Task 1-6 working-tree diff check passes.
- On this Windows environment, an explicit `OPENCODE_CHANNEL=dev` was required for build channel resolution because Bun's child shell could not invoke Git. The actual prebuild and all three application bundle builds passed once the channel was supplied.
- No commit or push was created.
