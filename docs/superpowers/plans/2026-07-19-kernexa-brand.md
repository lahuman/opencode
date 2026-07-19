# Kernexa Brand Implementation Plan

> **Required sub-skill:** Use `superpowers:executing-plans` to execute this plan task by task, `superpowers:test-driven-development` for each behavior change, and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Replace the active closed-network desktop product identity with Kernexa while preserving ordinary OpenCode behavior and keeping the former Pilot application and data fully separate.

**Architecture:** Keep the existing enterprise feature flag and packaging pipeline. Change only the enterprise identity values at their current ownership boundaries: Electron build configuration, main-process runtime identity, renderer titles, portable packaging/verifiers, supply-chain metadata, and the active operator runbook. Historical dated plans remain unchanged.

**Tech Stack:** TypeScript, Bun test runner, Electron/Electron Builder, PowerShell portable smoke script, Markdown runbooks.

**Global Constraints:** Enterprise-only changes must not alter ordinary OpenCode identities. Kernexa uses `com.company.kernexa`, `Kernexa.exe`, `kernexa-${version}-win-x64.*`, and `%LOCALAPPDATA%\com.company.kernexa`. No code may read, migrate, copy, or remove `%LOCALAPPDATA%\com.company.opencode.pilot`. Do not edit historical dated plans/specifications. Run tests and type checks from `packages/desktop`, never from the repository root.

---

## Task 1: Runtime and Electron build identity

**Files:**

- Modify: `packages/desktop/electron-builder.config.test.ts`
- Modify: `packages/desktop/src/main/index.test.ts`
- Modify: `packages/desktop/src/main/user-data.test.ts`
- Modify: `packages/desktop/src/main/windows.test.ts`
- Modify: `packages/desktop/src/renderer/platform.test.ts`
- Modify: `packages/desktop/electron-builder.config.ts`
- Modify: `packages/desktop/src/main/constants.ts`
- Modify: `packages/desktop/src/main/user-data.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`
- Modify: `packages/desktop/test/windows-policy-entrypoint.ts`

### Step 1: Write failing identity tests

Change enterprise expectations to:

- app ID: `com.company.kernexa`
- product/window/document title: `Kernexa`
- artifact pattern: `kernexa-${version}-${os}-${arch}.${ext}`
- user-data directory: `%LOCALAPPDATA%\com.company.kernexa`

Add or retain an assertion that the enterprise user-data resolution does not point at `com.company.opencode.pilot`.

### Step 2: Run the focused tests and confirm they fail for the former identity

Run from `packages/desktop`:

```powershell
bun.cmd test electron-builder.config.test.ts src/main/index.test.ts src/main/user-data.test.ts src/main/windows.test.ts src/renderer/platform.test.ts
```

Expected: failures show the old Pilot app ID, product name, title, or data path.

### Step 3: Implement the enterprise identity changes

Update the Electron Builder config, main-process identity, Windows user-data path/error, renderer title, and policy test entrypoint. Leave non-enterprise branches unchanged.

### Step 4: Re-run the focused tests

Run the same command. Expected: all selected tests pass.

## Task 2: Portable package creation and package verification

**Files:**

- Modify: `packages/desktop/scripts/package-enterprise-win.test.ts`
- Modify: `packages/desktop/scripts/verify-enterprise-package.test.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.ts`
- Modify: `packages/desktop/scripts/verify-enterprise-package.ts`

### Step 1: Write failing package naming tests

Change fixtures and expectations to require `Kernexa.exe` and `kernexa-${version}-win-x64.zip`, including related-file naming and Authenticode target selection.

### Step 2: Run the focused tests and confirm failure

```powershell
bun.cmd test scripts/package-enterprise-win.test.ts scripts/verify-enterprise-package.test.ts
```

Expected: source code still emits or expects Pilot names.

### Step 3: Implement package and verifier naming

Change archive construction, executable lookup, required-file checks, related metadata lookup, and size/integrity checks to Kernexa names without weakening verification.

### Step 4: Re-run the focused tests

Run the same command. Expected: tests pass, except any pre-existing Windows symlink privilege cases should be recorded separately with their exact error.

## Task 3: Release metadata, supply chain, and portable smoke checks

**Files:**

- Modify: `packages/desktop/scripts/enterprise-supply-chain.test.ts`
- Modify: `packages/desktop/scripts/enterprise-release.test.ts`
- Modify: `packages/desktop/scripts/windows-portable-smoke.test.ts`
- Modify: `packages/desktop/scripts/enterprise-supply-chain.ts`
- Modify: `packages/desktop/scripts/windows-portable-smoke.ps1`

### Step 1: Write failing release and smoke expectations

Require the `kernexa` SBOM component, Kernexa notice heading, Kernexa artifact sidecars, `Kernexa.exe`, and `%LOCALAPPDATA%\com.company.kernexa`.

### Step 2: Run the focused tests and confirm failure

```powershell
bun.cmd test scripts/enterprise-supply-chain.test.ts scripts/enterprise-release.test.ts scripts/windows-portable-smoke.test.ts
```

Expected: failures identify old package, component, executable, or AppData values.

### Step 3: Implement release and smoke identity changes

Update supply-chain component/heading and portable smoke executable/artifact/AppData discovery. Preserve all checksum, signature, allowlist, and integrity behavior.

### Step 4: Re-run the focused tests

Run the same command. Expected: all selected tests pass.

## Task 4: Active operator runbook

**Files:**

- Rename: `docs/enterprise/windows-portable-pilot-release.md` to `docs/enterprise/windows-portable-kernexa-release.md`
- Modify: `docs/enterprise/windows-portable-kernexa-release.md`
- Modify: `packages/desktop/scripts/windows-portable-smoke.test.ts`

### Step 1: Change the runbook contract test

Point the test at the Kernexa runbook and require current Kernexa executable, artifact, sidecar, and AppData examples.

### Step 2: Run the runbook test and confirm failure

```powershell
bun.cmd test scripts/windows-portable-smoke.test.ts
```

Expected: the Kernexa runbook does not yet exist or still contains Pilot instructions.

### Step 3: Rename and update the active runbook

Rename the file and update all active operator instructions to Kernexa. Retain operational controls and rollback guidance, but make clear that Pilot data is neither migrated nor deleted.

### Step 4: Re-run the runbook test

Run the same command. Expected: pass.

## Task 5: Cross-surface verification

**Files:**

- Verify: all files under `packages/desktop`
- Verify: all files under `docs/enterprise`
- Exclude from rename enforcement: dated history under `docs/superpowers/specs` and `docs/superpowers/plans`

### Step 1: Run active-name sweep

From the repository root:

```powershell
rg -n "Company OpenCode Pilot|com\.company\.opencode\.pilot|company-opencode-pilot|OpenCode Pilot" packages/desktop docs/enterprise
```

Expected: no active occurrences. If a test intentionally asserts non-use of the old path, keep it only when the assertion is explicit and safe.

### Step 2: Run the combined desktop tests

From `packages/desktop`:

```powershell
bun.cmd test electron-builder.config.test.ts src/main/index.test.ts src/main/user-data.test.ts src/main/windows.test.ts src/renderer/platform.test.ts scripts/package-enterprise-win.test.ts scripts/verify-enterprise-package.test.ts scripts/enterprise-supply-chain.test.ts scripts/enterprise-release.test.ts scripts/windows-portable-smoke.test.ts
```

Expected: all selected tests pass, with any environment-only symlink privilege issue separated from product failures.

### Step 3: Run type checking

```powershell
bun.cmd typecheck
```

Expected: exit code 0.

### Step 4: Inspect the final diff

From the repository root:

```powershell
git diff --check
git diff -- packages/desktop docs/enterprise docs/superpowers/plans/2026-07-19-kernexa-brand.md
```

Confirm ordinary OpenCode identity remains untouched, no migration code exists, packaging verification is not weakened, and only the active enterprise runbook was renamed.

