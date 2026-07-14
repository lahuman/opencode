# Company Guidance Harness Task 1 Implementation Report

## Range

- Immutable base: `dd9b41ab743346b9706c9718b0b6e15246710dbf`
- Immutable reviewed end before the packaging correction: `ea99aa7e819d02f3a6392e593229e1e1746ee575`
- Immutable reviewed range: `dd9b41ab743346b9706c9718b0b6e15246710dbf..ea99aa7e819d02f3a6392e593229e1e1746ee575`
- Branch: `enterprise-pilot`

Task 1 commits:

- `fe0d53747408550ca7d5074d3ad4545d585e271a feat(desktop): bundle company ai guide`
- `ea99aa7e819d02f3a6392e593229e1e1746ee575 test(desktop): verify enterprise version defines`
- `fix(desktop): package company guide resources` (the commit containing this report; its immutable SHA is recorded in the delivery response because a commit cannot embed its own hash)

## Implementation

- Required trimmed defaults and guide versions for every enabled enterprise profile.
- Defined both versions for Electron main and renderer builds and propagated them to the sidecar environment.
- Preserved absolute packaged defaults and guide paths constructed by desktop startup.
- Added the exact Korean company guide from the task brief.
- Packaged the complete enterprise resource directory beside `app.asar` at `${process.resourcesPath}/enterprise`.
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
- `packages/desktop/electron-builder.config.ts`
- `packages/desktop/electron-builder.config.test.ts`
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

- A signed Windows installer and packaged sidecar were not launched end to end.
- A directory package was not produced because this shared worktree does not contain the required generated `packages/desktop/native/` input. The builder regression and effective-config inspection verify the source/destination mapping, but artifact-level layout remains for packaging CI to exercise.
- Enterprise builds must now supply both version variables; missing or whitespace-only values intentionally fail build profile parsing.

## Review Follow-Up: Version Define Coverage

### Range

- Review base: `fe0d53747408550ca7d5074d3ad4545d585e271a`
- Immutable follow-up end: `ea99aa7e819d02f3a6392e593229e1e1746ee575`
- Immutable follow-up range: `fe0d53747408550ca7d5074d3ad4545d585e271a..ea99aa7e819d02f3a6392e593229e1e1746ee575`
- Immutable cumulative range through this follow-up: `dd9b41ab743346b9706c9718b0b6e15246710dbf..ea99aa7e819d02f3a6392e593229e1e1746ee575`
- Follow-up commit: `ea99aa7e819d02f3a6392e593229e1e1746ee575 test(desktop): verify enterprise version defines`

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

## Review Follow-Up: Packaged Enterprise Resources

### Scope

- Added an unfiltered Electron Builder file set from `resources/enterprise` to external destination `enterprise`.
- Preserved the existing filtered `native/` sidecar file set as a separate entry.
- Added builder-config coverage for the destination mapping and the presence of `opencode.jsonc` and `company-guide.md` in the source directory.
- Runtime path construction and ordinary application behavior are unchanged.

### TDD Evidence

RED:

- `packages/desktop`: `bun test electron-builder.config.test.ts` exited 1 with 4 passed and 1 expected failure.
- The effective config contained only the existing `native/` entry and did not contain `{ from: "resources/enterprise", to: "enterprise" }`.

GREEN:

- `packages/desktop`: `bun test electron-builder.config.test.ts` exited 0 with 5 passed, 0 failed, and 22 assertions.
- The config now contains exactly two external resource entries, preserves `native/`, maps the full enterprise directory to `enterprise`, and covers both required source files.

### Packaging Evidence

- Direct import of `electron-builder.config.ts` showed unchanged `files: ["out/**/*", "resources/**/*"]` plus separate `native/` and `resources/enterprise` external resource entries.
- The enterprise entry has no filter, so Electron Builder copies the complete source directory to `${process.resourcesPath}/enterprise`.
- A directory build was not attempted because `packages/desktop/native/` is absent in this shared worktree; omitting or fabricating that required sidecar input would not provide faithful artifact evidence.

### Updated Verification

| Command | Result |
| --- | --- |
| `packages/desktop: bun test electron-builder.config.test.ts` | 5 passed, 0 failed |
| `packages/desktop: bun test src/enterprise.test.ts` | 6 passed, 0 failed |
| `packages/desktop: bun test electron.vite.config.test.ts` | 4 passed, 0 failed |
| `packages/desktop: bun test src/main/index.test.ts` | 5 passed, 0 failed |
| `packages/desktop: bun typecheck` | exit 0 |
| `packages/opencode: bun test test/config/config.test.ts --filter "bundled guide"` | 99 passed, 0 failed |
| `packages/opencode: bun test test/config/enterprise.test.ts` | 7 passed, 0 failed |
| `packages/opencode: bun typecheck` | exit 0 |

Updated test total: 126 passed, 0 failed. The 99-test config suite ran outside the socket-restricted sandbox because Bun 1.3.14 did not narrow the requested `--filter` form and the full file includes a localhost regression.
