# Task 2 Report: Runtime Enterprise Catalog in the Sidecar

## Status

Implemented and verified. All changes remain uncommitted. Task 1's `enterprise-providers.ts`, `enterprise-providers.test.ts`, `enterprise-credentials.ts`, and `enterprise-credentials.test.ts` were preserved without edits.

## Implementation

- Extended the sidecar start contract with the Electron-owned schema-v1 provider catalog and schema-v3 provider credentials.
- Made `postSidecarStartCommand()` transfer both owned values in one post, release the owner references only after a successful post, and clear both command references.
- Removed inherited `OPENCODE_ENTERPRISE_PROVIDER_CATALOG` and credential environment data from the parent-created sidecar environment.
- Validated and serialized the catalog inside `sidecar.ts` before loading `virtual:opencode-server`, then installed provider-scoped credentials and released command references.
- Updated the Desktop server boundary to accept `EnterpriseProviderCatalog` and `EnterpriseProviderCredentials`.
- Replaced build-time Company LLM model materialization with Enterprise-only parsing of `OPENCODE_ENTERPRISE_PROVIDER_CATALOG`.
- Added `catalog` and derived `defaultModel` to `ConfigEnterprise.settings()`; an empty catalog is valid and has no default.
- Made catalog metadata authoritative during materialization and enforcement. Project config cannot add providers/models or replace IDs, names, SDK package, Base URL, or model provider API/package. Non-secret matching model capabilities/options can still survive enforcement.
- Preserved the existing local-plugin, sharing, autoupdate, guide, skill-path, and credential-sanitization gates.
- Changed `ProviderEnterprise` to decode schema-v3 credentials and route one provider credential set to every model under that provider, with case-insensitive configured-header replacement.
- Kept the manual redirect-blocking fetch wrapper for Enterprise provider execution while leaving ordinary execution unchanged when no valid Enterprise credential payload is installed.
- Changed the existing Desktop main call site from the legacy `all()` reader to Task 1's schema-v3 `read()` reader so the new sidecar contract typechecks. Task 3 remains responsible for catalog initialization and passing the catalog into actual starts/restarts.

## Files Changed

- `packages/desktop/src/main/sidecar-startup.ts`
- `packages/desktop/src/main/sidecar.ts`
- `packages/desktop/src/main/server.ts`
- `packages/desktop/src/main/sidecar-startup.test.ts` (created; the plan listed it but it did not previously exist)
- `packages/desktop/src/main/enterprise-sidecar-env.test.ts` (updated existing schema-v2 fixtures to the schema-v3 contract)
- `packages/desktop/src/main/index.ts` (one compile-safe schema-v3 reader adjustment)
- `packages/opencode/src/config/enterprise.ts`
- `packages/opencode/src/provider/enterprise.ts`
- `packages/opencode/test/config/enterprise.test.ts`
- `packages/opencode/test/provider/enterprise.test.ts`
- `.superpowers/sdd/task-2-report.md`

## TDD Evidence

### RED 1: OpenCode authoritative catalog and provider credential routing

Command, from `packages/opencode`:

```powershell
bun.cmd test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts
```

Result: exit 1, **17 pass / 2 fail**.

- Catalog enforcement failed with `Expected ["internal"], Received []`, proving the old enforcement did not rebuild providers from the runtime catalog.
- Provider credential routing failed because the received result retained project headers and had no provider API key, proving schema-v3 provider credentials were not decoded or routed.

### RED 2: Sidecar ownership and inherited environment isolation

Command, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/sidecar-startup.test.ts ./src/main/enterprise-sidecar-env.test.ts
```

Result: exit 1, **5 pass / 2 fail**.

- Posted `catalog` was `undefined` instead of the owned catalog.
- `OPENCODE_ENTERPRISE_PROVIDER_CATALOG` retained the inherited attacker value instead of being removed.

### RED 3: Catalog default remains authoritative

Command, from `packages/opencode`:

```powershell
bun.cmd test ./test/config/enterprise.test.ts --test-name-pattern "materializes runtime provider catalog metadata"
```

Result: exit 1, **0 pass / 1 fail**. The materialized model was `project-injected/model` rather than the catalog default `company-llm/company-code`.

### GREEN

- The RED 3 command passed **1/1** after deriving materialized defaults directly from `catalog.default`.
- The final required Desktop command passed **7/7 tests, 19 assertions**.
- The final OpenCode command with the required timeout passed **25/25 tests, 61 assertions**.

## Final Verification

From `packages/desktop`:

```powershell
bun.cmd test ./src/main/sidecar-startup.test.ts ./src/main/enterprise-sidecar-env.test.ts
bun.cmd typecheck
```

Result: exit 0; **7 pass / 0 fail**, then `tsgo -b` exited 0.

From `packages/opencode`:

```powershell
bun.cmd test --timeout 30000 ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts
bun.cmd typecheck
```

Result: exit 0; **25 pass / 0 fail**, then `tsgo --noEmit` exited 0.

Task 1 preservation check, from `packages/desktop`:

```powershell
bun.cmd test ./src/main/enterprise-providers.test.ts ./src/main/enterprise-credentials.test.ts
```

Result: exit 0; **30 pass / 0 fail, 95 assertions**.

Repository whitespace check: `git diff --check` exited 0 (Git emitted only existing CRLF conversion warnings).

## Self-review

- Confirmed ordinary mode returns the original config and provider options without installing the Enterprise fetch wrapper.
- Confirmed an empty authoritative catalog removes every merged provider and sets `enabled_providers` to an empty list while preserving offline gates.
- Confirmed configured provider/model secrets are stripped before enforced config is exposed and catalog data contains no credentials.
- Confirmed credential headers replace case variants without dropping unrelated configured headers.
- Confirmed a failed sidecar post retains both owner references; successful posting releases both.
- Confirmed no public Protocol or Server `HttpApi` changed, no generated files changed, and no commit was created.

## Concerns / Follow-up

- This task prepares and tests the sidecar contract, but Task 3 intentionally owns durable catalog initialization and passing catalog/credential candidates into every normal start and restart. Until Task 3 wires that caller, the `catalog` option remains optional at the current main-entrypoint call site.
- The main-entrypoint `read()` adjustment is deliberately minimal and will be superseded by Task 3's transactional runtime initialization/migration path.

## Review Fix: Authoritative API/Model IDs and Redirect Copy

### Findings addressed

- A registered provider could retain a project-configured legacy top-level `api`, which provider resolution consumes ahead of the catalog Base URL.
- A registered model could retain a project-configured `id`, which provider resolution consumes as the upstream API model ID.
- Redirect rejection still referred specifically to Company LLM after providers became catalog-defined.

### Files changed in this review cycle

- `packages/opencode/src/config/enterprise.ts`
- `packages/opencode/src/provider/enterprise.ts`
- `packages/opencode/test/config/enterprise.test.ts`
- `packages/opencode/test/provider/enterprise.test.ts`
- `.superpowers/sdd/task-2-report.md`

No Desktop file changed in this review cycle, so the conditional Desktop sidecar rerun was not required.

### RED evidence

Command, from `packages/opencode`:

```powershell
bun.cmd test ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts
```

Result: exit 1, **18 pass / 3 fail**.

- Provider API test expected `https://internal.example/v1` but received the project value `https://attacker.example/v1`.
- Model ID test expected `code` but received the project value `attacker-model`.
- Redirect test expected `Enterprise provider redirects are disabled` but received `Company LLM redirects are disabled`.

### GREEN evidence

After adding the authoritative provider `api`, authoritative model `id`, and generalized error copy, the same focused command passed **21/21 tests, 57 assertions**.

Final required command, from `packages/opencode`:

```powershell
bun.cmd test --timeout 30000 ./test/config/enterprise.test.ts ./test/provider/enterprise.test.ts ./test/provider/header-timeout.test.ts
bun.cmd typecheck
```

Result: exit 0; **27 pass / 0 fail, 64 assertions**, followed by `tsgo --noEmit` exit 0.

`git diff --check` also exited 0 with only the existing CRLF conversion warnings. No commit was created.
