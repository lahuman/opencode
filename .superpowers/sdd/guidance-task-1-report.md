# Company Guidance Harness Task 1 Implementation Report

## Range

- Base: `dd9b41ab743346b9706c9718b0b6e15246710dbf`
- Branch: `enterprise-pilot`
- Task range: `dd9b41ab743346b9706c9718b0b6e15246710dbf..enterprise-pilot`
- Commit: `feat(desktop): bundle company ai guide`

The task range contains one task commit. The delivery response records the immutable end SHA after that commit is created.

## Implementation

- Required trimmed defaults and guide versions for every enabled enterprise profile.
- Defined both versions for Electron main and renderer builds and propagated them to the sidecar environment.
- Preserved absolute packaged defaults and guide paths constructed by desktop startup.
- Added the exact Korean company guide from the task brief.
- Added the absolute guide path to structured enterprise defaults before project instructions and removed duplicate occurrences.
- Added metadata-only startup logging for defaults and guide versions. Provider URLs, credentials, headers, prompts, guide contents, paths, and environment values are not logged.
- Preserved ordinary-mode behavior and avoided JSONC environment-token substitution for the guide path.

## Changed Files

- `.superpowers/sdd/guidance-task-1-report.md`
- `packages/desktop/resources/enterprise/company-guide.md`
- `packages/desktop/src/enterprise-profile.ts`
- `packages/desktop/src/enterprise.ts`
- `packages/desktop/src/enterprise.test.ts`
- `packages/desktop/electron.vite.config.ts`
- `packages/desktop/electron.vite.config.test.ts`
- `packages/desktop/src/main/env.d.ts`
- `packages/desktop/src/main/index.ts`
- `packages/opencode/src/config/enterprise.ts`
- `packages/opencode/test/config/config.test.ts`

Two adjacent files outside the ownership list were necessary:

- `packages/desktop/src/enterprise-profile.ts` owns `EnterpriseProfile`, `parseEnterpriseProfile`, and `enterpriseEnvironment` after an earlier parser split; the required interface and sidecar changes cannot be implemented in the re-exporting `enterprise.ts` alone.
- `packages/desktop/electron.vite.config.test.ts` supplies enabled build fixtures. Adding both required versions keeps its credential-validation regressions focused on their intended fields.

## TDD Evidence

Baseline:

- Desktop enterprise profile: 5 passed, 0 failed.
- Desktop Vite regression: 3 passed, 0 failed.
- OpenCode config file: 98 passed, 0 failed outside the socket-restricted sandbox.

RED:

- `packages/desktop`: `bun test src/enterprise.test.ts` exited 1 with 4 passed and 2 expected failures. The parser did not reject missing versions, and the environment lacked both version fields.
- `packages/opencode`: `bun test test/config/config.test.ts --filter "bundled guide"` exited 1 with 98 passed and 1 expected failure. Merged instructions contained only `project-guide.md`; the absolute bundled guide was absent.

GREEN:

- Desktop enterprise profile: 6 passed, 0 failed, 8 assertions.
- OpenCode config file: 99 passed, 0 failed, 170 assertions. The new test verifies guide-first precedence and deduplication.

## Verification

All commands ran from their package directories where applicable.

| Command | Result |
| --- | --- |
| `packages/desktop: bun test src/enterprise.test.ts` | 6 passed, 0 failed |
| `packages/desktop: bun test electron.vite.config.test.ts` | 3 passed, 0 failed |
| `packages/desktop: bun test src/main/index.test.ts` | 5 passed, 0 failed |
| `packages/desktop: bun typecheck` | exit 0 |
| `packages/opencode: bun test test/config/config.test.ts --filter "bundled guide"` | 99 passed, 0 failed |
| `packages/opencode: bun test test/config/enterprise.test.ts` | 7 passed, 0 failed |
| `packages/opencode: bun typecheck` | exit 0 |

Test total: 120 passed, 0 failed. In Bun 1.3.14, the requested `--filter` form did not narrow by test name, so it ran the complete 99-test config file.

Additional checks:

- The bundled guide has no diff from the markdown block in the task brief.
- No `{env:OPENCODE_ENTERPRISE_GUIDE_PATH}` token exists in desktop or OpenCode sources.
- Enterprise startup logging contains only `defaultsVersion` and `guideVersion`; the existing application startup record supplies the application version.
- `git diff --check` exits 0.

## Residual Risks

- A Windows installer was not built or launched in this task. Resource placement relies on the existing desktop packaging pipeline already used by `opencode.jsonc`, while tests cover Windows-style path propagation and real config merging.
- Tests validate the exact sidecar environment map and config load path, but do not launch a packaged sidecar process end to end.
- Enterprise builds must now supply both version variables; missing or whitespace-only values intentionally fail build profile parsing.

## Review Follow-Up: Version Define Coverage

### Range

- Review base: `fe0d53747408550ca7d5074d3ad4545d585e271a`
- Follow-up range: `fe0d53747408550ca7d5074d3ad4545d585e271a..enterprise-pilot`
- Updated cumulative range: `dd9b41ab743346b9706c9718b0b6e15246710dbf..enterprise-pilot`
- Follow-up commit: `test(desktop): verify enterprise version defines`

The delivery response records the immutable follow-up HEAD after the commit is created.

### Scope

- Added a valid enabled enterprise-profile Vite regression with the Company base URL, model ID, model name, defaults version, and guide version.
- Asserted both version definitions under both `main.define` and `renderer.define`.
- Updated only the test harness to serialize the loaded target define maps from Electron Vite. Runtime configuration and application behavior are unchanged.

### TDD Evidence

RED:

- `packages/desktop`: `bun test electron.vite.config.test.ts` exited 1 with 3 passed and 1 expected failure.
- The enabled profile loaded with exit code 0, but the harness result had no `defines` property, so all four main/renderer version assertions were absent.

GREEN:

- `packages/desktop`: `bun test electron.vite.config.test.ts` exited 0 with 4 passed, 0 failed, and 6 assertions.
- The harness now exposes the loaded `main.define` and `renderer.define` maps, and both contain JSON-stringified `pilot-1` defaults and guide versions.

### Updated Verification

| Command | Result |
| --- | --- |
| `packages/desktop: bun test src/enterprise.test.ts` | 6 passed, 0 failed |
| `packages/desktop: bun test electron.vite.config.test.ts` | 4 passed, 0 failed |
| `packages/desktop: bun test src/main/index.test.ts` | 5 passed, 0 failed |
| `packages/desktop: bun typecheck` | exit 0 |
| `packages/opencode: bun test test/config/config.test.ts --filter "bundled guide"` | 99 passed, 0 failed |
| `packages/opencode: bun test test/config/enterprise.test.ts` | 7 passed, 0 failed |
| `packages/opencode: bun typecheck` | exit 0 |

Updated test total: 121 passed, 0 failed. Bun 1.3.14 again treated the requested `--filter` form as a full-file run, so the 99-test config suite ran outside the socket-restricted sandbox to allow its localhost regression to bind an ephemeral port.
