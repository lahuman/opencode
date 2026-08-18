# Empty Catalog Final Fixes Report

## Status

Implemented the two final-review Important fixes in the shared `enterprise-pilot` checkout. No commit or push was performed.

## Files

Final-fix tracked files:

- `packages/desktop/src/main/enterprise-preflight.ts`
- `packages/desktop/scripts/enterprise-release.ts`
- `packages/desktop/scripts/enterprise-release.test.ts`
- `packages/desktop/scripts/windows-portable-smoke.ps1`
- `packages/desktop/scripts/windows-portable-smoke.test.ts`
- `docs/enterprise/windows-portable-sfmi-release.md`
- `packages/desktop/.env.enterprise.example`

Ignored local/build files aligned or regenerated:

- `packages/desktop/.env`
- `packages/desktop/resources/enterprise/enterprise-manifest.json`

The previously uncommitted empty-catalog implementation files were preserved. The guide content and the tracked guide/manifest hash guard were not changed.

## RED

From `packages/desktop`:

    bun.cmd test ./scripts/enterprise-release.test.ts ./scripts/windows-portable-smoke.test.ts

Initial result: exit 1, 34 pass, 3 fail, 220 assertions. The two invalid release-writer pairs resolved instead of rejecting, and the actual PowerShell validator rejected the valid `defaultModelID: ""`, `modelIDs: []` pair. Existing nonempty release generation and PowerShell validation passed.

## GREEN

The manifest/preflight exact-pair predicate is now reused by release generation. The PowerShell smoke validator and executable release-runbook validator both accept only these states:

- zero model IDs with `defaultModelID` exactly `""`;
- one or more sorted unique model IDs with a nonblank included default.

Focused rerun:

    bun.cmd test ./scripts/enterprise-release.test.ts ./scripts/windows-portable-smoke.test.ts

Result: exit 0, 37 pass, 0 fail, 223 assertions. This includes the valid empty pair, both invalid mixed pairs, a non-included default rejection, existing nonempty metadata, and PowerShell parser/fixture coverage against the actual smoke implementation.

## Guide Alignment and Build

Both `packages/desktop/.env.enterprise.example` and ignored `packages/desktop/.env` now contain:

    OPENCODE_ENTERPRISE_GUIDE_VERSION=sfmi-1

Required empty-profile build from `packages/desktop`:

    $env:OPENCODE_CHANNEL='dev'; bun.cmd run build

Result: exit 0. The regenerated ignored manifest contains `guideVersion: "sfmi-1"`, `defaultModelID: ""`, `modelIDs: []`, `allowedOrigins: []`, and `modelCatalogSHA256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"`. The generated `models.json` remains `{}`.

## Acceptance Verification

Exact previously red seven-file suite, unfiltered, from `packages/desktop`:

    bun.cmd test ./src/enterprise.test.ts ./scripts/enterprise-build.test.ts ./electron.vite.config.test.ts ./src/main/enterprise-preflight.test.ts ./scripts/enterprise-manifest.test.ts ./src/main/enterprise-providers.test.ts ./src/main/enterprise-provider-runtime.test.ts

Result: exit 0, 118 pass, 0 fail, 353 assertions. The generated SFMI guide/manifest alignment and guide-content hash guard passed unchanged.

Desktop typecheck:

    bun.cmd typecheck

Result: exit 0 (`tsgo -b`).

Diff hygiene from the repository root:

    & 'C:\Program Files\Git\cmd\git.exe' diff --check

Result: exit 0 with no output.

## Ancillary Package-Verifier Note

An additional combined run included the entire unrelated `scripts/verify-enterprise-package.test.ts` suite. Its empty-catalog/release tests passed, but two Windows symlink fixtures failed during setup with `EPERM`. A separate escalated rerun still lacked Windows symlink privilege and additionally hit one existing 5-second archive timeout under load. That file contains no empty-catalog pair cases and is not part of the requested seven-file or release/smoke focused suites; no product assertion related to these fixes failed.

## Final Minor Drift Alignment

The empty-catalog design and implementation plan now use the user-approved `sfmi-1` guide version everywhere they describe the default empty profile. No production code or guide content changed.

The ignored local environment is exactly eight lines: `LOCAL_TEST=1` followed by the seven empty Enterprise profile lines. The tracked `.env.enterprise.example` is exactly those seven profile lines and omits `LOCAL_TEST`.

Read-only verification from the repository root compared both files line-for-line with explicit expected arrays, rejected any remaining `pilot-1` in the design/plan, counted the approved references, and then ran diff hygiene. Result: exit 0; local env 8 exact lines, tracked example 7 exact lines, 4 `sfmi-1` design/plan references, no `pilot-1`, and `git diff --check` clean.
