# Task 1 Report: Durable Provider Catalog and Provider Credentials

## Status

DONE_WITH_CONCERNS. No commits were created.

## Implementation summary

- Added `enterprise-providers.ts` with the schema-v1 provider catalog interfaces, synchronous validation, URL normalization, default-reference checks, and atomic JSON persistence.
- Added catalog initialization that seeds one provider per packaged legacy model, maps v2 model credentials to v3 provider credentials, uses stable `company-llm`, `company-llm-2`, and later suffix IDs, and leaves an existing valid catalog untouched.
- Added schema-v3 `EnterpriseProviderCredentials`, plus encrypted `read()`, `write()`, `health()`, and tagged `readLegacy()` APIs to the credential store. The decoder deliberately does not validate catalog membership.
- Preserved the existing model-scoped compatibility methods because current runtime consumers are migrated in later tasks.

## Files changed

- Created `packages/desktop/src/main/enterprise-providers.ts`
- Created `packages/desktop/src/main/enterprise-providers.test.ts`
- Modified `packages/desktop/src/main/enterprise-credentials.ts`
- Modified `packages/desktop/src/main/enterprise-credentials.test.ts`

## RED evidence

All RED commands were run from `E:\03.DEV\opencode\packages\desktop`.

1. Command: `bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts`
   Output: `error: Cannot find module './enterprise-providers' ...` with `21 pass, 1 fail, 1 error`.
2. Same command after adding the seeding test.
   Output: `SyntaxError: Export named 'createEnterpriseProviderStore' not found ...` with `21 pass, 1 fail, 1 error`.
3. Same command after adding the v3 credential test.
   Output: `TypeError: store.write is not a function` with `23 pass, 1 fail`.
4. Same command after asserting v3 health.
   Output: expected `{ state: "available" }`, received `{ state: "corrupt" }` with `23 pass, 1 fail`.
5. Same command after asserting reinitialization preservation.
   Output: expected `{ catalog }`, received `{ catalog, credentials: { schemaVersion: 3, providers: {} } }` with `27 pass, 1 fail`.

## GREEN verification

Command: `bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts; bun.cmd typecheck`

Output:

```text
28 pass
0 fail
93 expect() calls
Ran 28 tests across 2 files.
$ tsgo -b
```

## Tests covered

- Invalid URLs, dangling defaults, duplicate provider/model IDs, empty names, URL query/fragment rejection, empty catalogs, and normalized URLs.
- Catalog seeding, every legacy credential preserved, stable suffix IDs, corrupt JSON rejection, atomic temp cleanup, and existing-catalog preservation.
- Schema-v3 encrypted read/write, v3 health, tagged v2 legacy decoding, no plaintext secret in the on-disk credential file, plus the pre-existing credential-store regression suite.

## Self-review

- `git diff --check` produced no whitespace errors.
- Desktop typecheck passed.
- No plaintext credentials are persisted to the catalog fixture; catalog persistence is plain JSON by design and credential persistence stays encrypted.
- All Task 1 source changes remain uncommitted. Pre-existing untracked `.superpowers/sdd` files were not changed.

## Concerns

- Runtime startup/IPC consumers still use the retained v2 compatibility methods. A later task must orchestrate `readLegacy()`, provider-store `initialize()`, and v3 `write()` so the migration is invoked during application startup; this Task 1 boundary intentionally does not modify `index.ts` or runtime wiring.

## Follow-up review: retry safety and URL coverage

- `initialize()` now re-derives schema-v3 provider credentials from supplied legacy v2 data when a previously seeded catalog already exists. This covers a retry after a crash between catalog persistence and v3 credential persistence.
- Reinitialization without legacy data continues to return only the existing catalog, so user-authored catalogs do not receive invented credentials.
- Added an explicit query-string provider URL rejection test, separate from fragment rejection.
- Authoritative mutation validation/immutable provider IDs and application startup migration orchestration are explicitly out of scope for Task 1 and remain assigned to Task 3.

### Follow-up RED evidence

Command, run from `E:\03.DEV\opencode\packages\desktop`:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts
```

Exact result: `29 pass, 1 fail, 95 expect() calls`. The failing retry regression expected the existing catalog plus schema-v3 credentials and received only the catalog.

### Follow-up GREEN verification

Command, run from `E:\03.DEV\opencode\packages\desktop`:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts; bun.cmd typecheck
```

Exact output:

```text
30 pass
0 fail
95 expect() calls
Ran 30 tests across 2 files.
$ tsgo -b
```
