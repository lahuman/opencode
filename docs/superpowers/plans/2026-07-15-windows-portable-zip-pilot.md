# Windows Portable ZIP Enterprise Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the enterprise NSIS/signing pipeline with a controlled Windows x64 ZIP build that verifies package contents, emits integrity metadata, and supports portable Windows acceptance without deleting AppData or projects.

**Architecture:** The existing enterprise identity and offline runtime remain unchanged. A fixed Windows-only runner validates the enterprise profile, strips inherited signing variables, builds the desktop, invokes electron-builder's ZIP target, verifies `win-unpacked` and the ZIP, then emits SHA-256 and release metadata. A PowerShell smoke script validates extraction, unsigned status, process egress, AppData persistence, and application-folder replacement on Windows 10 and 11.

**Tech Stack:** Bun 1.3, TypeScript, electron-builder 26, Electron 42, `@zip.js/zip.js`, PowerShell 5+, Windows DPAPI and networking cmdlets.

## Global Constraints

- Accepted release artifacts are built only on a controlled Windows x64 machine through `bun run package:enterprise:win`.
- The enterprise artifact is `company-opencode-pilot-${version}-win-x64.zip`.
- The official runner removes all inherited `CSC_*` and `WIN_CSC_*` variables; the pilot executable must report `NotSigned`.
- Direct enterprise electron-builder CLI use and `--prepackaged` are unsupported operator paths.
- Runtime state remains under `%LOCALAPPDATA%\com.company.opencode.pilot`; application-folder replacement or deletion must not remove it.
- Public update, sharing, protocol registration, WSL, plugin download, LSP download, and OpenCode public egress remain disabled.
- Do not change ordinary dev, beta, or production OpenCode packaging behavior.
- Do not edit generated clients or lockfiles.
- Run tests and `bun typecheck` from package directories, never from the repository root.
- Every implementation task uses TDD, receives a fresh implementation review, and is committed before the next task starts.

## File Responsibility Map

- `packages/desktop/scripts/enterprise-build.ts`: pure enterprise input validation and signing-environment removal.
- `packages/desktop/electron-builder.config.ts`: ordinary packaging plus the enterprise ZIP configuration.
- `packages/desktop/scripts/package-enterprise-win.ts`: supported Windows x64 orchestration only.
- `packages/desktop/scripts/verify-enterprise-package.ts`: unpacked package and ZIP entry verification.
- `packages/desktop/scripts/enterprise-release.ts`: SHA-256 and release metadata generation.
- `packages/desktop/scripts/windows-portable-smoke.ps1`: native Windows portable acceptance automation.
- `docs/enterprise/windows-portable-pilot-release.md`: operator workflow and manual acceptance record.

---

### Task 1: Replace certificate packaging with the fixed ZIP boundary

**Files:**
- Modify: `packages/desktop/scripts/enterprise-build.ts`
- Modify: `packages/desktop/scripts/enterprise-build.test.ts`
- Delete: `packages/desktop/scripts/enterprise-certificate.ts`
- Delete: `packages/desktop/scripts/enterprise-certificate.test.ts`
- Delete: `packages/desktop/test/enterprise-certificate-node-entrypoint.cjs`
- Modify: `packages/desktop/electron-builder.config.ts`
- Modify: `packages/desktop/electron-builder.config.test.ts`
- Modify: `packages/desktop/test/electron-builder-config-entrypoint.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.test.ts`

**Interfaces:**
- Produces: `validateEnterpriseBuild(env): EnterpriseBuildMetadata`
- Produces: `enterprisePackageEnvironment(env): Record<string, string | undefined>`
- Produces: `runEnterpriseWindowsPackage(input): Promise<number>` with fixed build and ZIP commands.
- Removes: all certificate staging, signing cleanup, and CSC validation interfaces.

Define and export the shared metadata contract in `enterprise-build.ts`:

```ts
export type EnterpriseBuildMetadata = {
  baseURL: string
  modelID: string
  modelName: string
  defaultsVersion: string
  guideVersion: string
  allowedOrigins: string[]
}
```

- [ ] **Step 1: Write failing preflight and environment tests**

Add tests that remove `CSC_LINK` and `CSC_KEY_PASSWORD` from the valid fixture, require no signing values, and cover the final URL bypasses:

```ts
import { enterprisePackageEnvironment, validateEnterpriseBuild } from "./enterprise-build"

test("accepts a portable unsigned profile without signing inputs", () => {
  expect(validateEnterpriseBuild(valid)).toMatchObject({
    baseURL: "https://llm.corp.example/v1",
    modelID: "company-code",
    allowedOrigins: ["https://llm.corp.example"],
  })
})

test.each([
  "https://llm.corp.example/v1\\..\\admin",
  "https://llm.corp.example/v1/%2e\t%2e/admin",
  "https://llm.corp.example/v1/.\n./admin",
])("rejects control and backslash URL normalization: %s", (baseURL) => {
  expect(() => validateEnterpriseBuild({ ...valid, OPENCODE_ENTERPRISE_BASE_URL: baseURL })).toThrow(
    "absolute HTTP(S) URL",
  )
})

test.each(["http://0x7f000001/v1", "http://0x7f.0.0.1/v1"])(
  "rejects legacy IPv4 notation: %s",
  (baseURL) => {
    expect(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_BASE_URL: baseURL,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "http://127.0.0.1",
      }),
    ).toThrow("absolute HTTP(S) URL")
  },
)

test("strips inherited signing variables from package children", () => {
  const env = enterprisePackageEnvironment({
    ...valid,
    CSC_LINK: "secret-path",
    CSC_KEY_PASSWORD: "secret-password",
    WIN_CSC_LINK: "alternate-secret",
    PATH: "preserve-me",
  })
  expect(env.PATH).toBe("preserve-me")
  expect(
    Object.keys(env).filter((key) => {
      const upper = key.toUpperCase()
      return upper.startsWith("CSC_") || upper.startsWith("WIN_CSC_")
    }),
  ).toEqual([])
})
```

- [ ] **Step 2: Run the focused RED tests**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-build.test.ts scripts/package-enterprise-win.test.ts electron-builder.config.test.ts
```

Expected: failures because signing inputs are still required, certificate staging still runs, and the enterprise builder target is NSIS.

- [ ] **Step 3: Implement portable validation and signing-environment removal**

Keep the current raw authority parser, add a whole-input control/backslash check, and compare legacy IPv4 normalization:

```ts
import { isIP } from "node:net"

type Env = Record<string, string | undefined>

export function enterprisePackageEnvironment(env: Env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const upper = key.toUpperCase()
      return !upper.startsWith("CSC_") && !upper.startsWith("WIN_CSC_")
    }),
  )
}

function createHTTPURL(value: string, rawHost: string, invalid: string) {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || !URL.canParse(value)) throw new Error(invalid)
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(invalid)
  if (isIP(url.hostname) === 4 && isIP(rawHost) !== 4) throw new Error(invalid)
  return url
}
```

Change `parseRawHTTPURL` to return `{ host, remainder }`, pass `host` to `createHTTPURL`, and remove `rejectAlternateSigningInputs`, `CSC_LINK`, and `CSC_KEY_PASSWORD` requirements. Keep all credential, query, fragment, port, dot-segment, and allowed-origin checks.

- [ ] **Step 4: Replace the enterprise builder branch with ZIP configuration**

Delete certificate imports and make `getEnterpriseConfig` synchronous:

```ts
function getEnterpriseConfig() {
  validateEnterpriseBuild(process.env)
  const appId = "com.company.opencode.pilot"
  const base = getBase(appId)
  return {
    ...base,
    appId,
    productName: "Company OpenCode Pilot",
    artifactName: "company-opencode-pilot-${version}-${os}-${arch}.${ext}",
    protocols: undefined,
    publish: undefined,
    nsis: undefined,
    win: {
      ...base.win,
      target: ["zip"],
      signtoolOptions: undefined,
    },
    extraResources: [
      ...(Array.isArray(base.extraResources) ? base.extraResources : base.extraResources ? [base.extraResources] : []),
      { from: "../../LICENSE", to: "licenses/OpenCode-LICENSE" },
    ],
  } satisfies Configuration
}
```

Update the isolated Jiti child assertions to require `winTarget: ["zip"]`, no NSIS, no `cscLink`, no `beforePack`, no publish, and no protocols. Remove all certificate scenarios and marker files. Preserve ordinary dev/beta/prod assertions.

- [ ] **Step 5: Simplify the supported package runner**

Remove the staging dependency and pass a sanitized child environment to the fixed commands:

```ts
export async function runEnterpriseWindowsPackage(input: {
  platform: string
  arch: string
  env: Env
  spawn: Spawn
}) {
  if (input.platform !== "win32" || input.arch !== "x64") {
    throw new Error("Enterprise portable packaging requires Windows x64")
  }
  validateEnterpriseBuild(input.env)
  const env = enterprisePackageEnvironment(input.env)
  const options = { cwd: path.resolve(import.meta.dir, ".."), env, stdout: "inherit" as const, stderr: "inherit" as const }
  const build = await input.spawn(["bun", "run", "build"], options).exited
  if (build !== 0) return build
  return input.spawn(["bun", "run", "package:win", "--x64"], options).exited
}
```

Update runner tests to assert exact command order, sanitized env, Windows/x64 rejection, validation-before-spawn, and first/second command exit propagation.

- [ ] **Step 6: Run Task 1 GREEN verification**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-build.test.ts scripts/package-enterprise-win.test.ts electron-builder.config.test.ts
bun test
bun typecheck
bunx prettier --check scripts/enterprise-build.ts scripts/enterprise-build.test.ts scripts/package-enterprise-win.ts scripts/package-enterprise-win.test.ts electron-builder.config.ts electron-builder.config.test.ts test/electron-builder-config-entrypoint.ts
bunx oxlint scripts/enterprise-build.ts scripts/package-enterprise-win.ts electron-builder.config.ts
git diff --check
```

Expected: all tests and typecheck pass; no certificate files remain; ordinary channel tests remain green.

- [ ] **Step 7: Commit the ZIP boundary**

```bash
git add packages/desktop/scripts/enterprise-build.ts packages/desktop/scripts/enterprise-build.test.ts packages/desktop/scripts/enterprise-certificate.ts packages/desktop/scripts/enterprise-certificate.test.ts packages/desktop/scripts/package-enterprise-win.ts packages/desktop/scripts/package-enterprise-win.test.ts packages/desktop/test/enterprise-certificate-node-entrypoint.cjs packages/desktop/test/electron-builder-config-entrypoint.ts packages/desktop/electron-builder.config.ts packages/desktop/electron-builder.config.test.ts
git commit -m "refactor(desktop): switch pilot packaging to zip"
```

---

### Task 2: Verify package contents and emit integrity artifacts

**Files:**
- Create: `packages/desktop/scripts/verify-enterprise-package.ts`
- Create: `packages/desktop/scripts/verify-enterprise-package.test.ts`
- Create: `packages/desktop/scripts/enterprise-release.ts`
- Create: `packages/desktop/scripts/enterprise-release.test.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.test.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Produces: `verifyEnterprisePackage(root): Promise<EnterprisePackageSummary>`
- Produces: `verifyEnterpriseArchive(archive): Promise<string[]>`
- Produces: `writeEnterpriseRelease(input): Promise<EnterpriseReleaseMetadata>`
- Extends: `runEnterpriseWindowsPackage` with verify, archive, checksum, and metadata steps.

- [ ] **Step 1: Write failing unpacked-package verifier tests**

Create a temporary fixture with the exact portable structure and test each semantic boundary:

```ts
test("accepts a complete portable enterprise tree", async () => {
  const root = await portableFixture()
  await expect(
    verifyEnterprisePackage(root),
  ).resolves.toEqual({
    executable: "Company OpenCode Pilot.exe",
    defaults: true,
    guide: true,
    models: true,
    appArchive: true,
    license: true,
  })
})

test.each([
  "Company OpenCode Pilot.exe",
  "resources/app.asar",
  "resources/enterprise/opencode.jsonc",
  "resources/enterprise/company-guide.md",
  "resources/enterprise/models.json",
  "resources/licenses/OpenCode-LICENSE",
])("rejects a package missing %s", async (relative) => {
  const root = await portableFixture()
  await rm(path.join(root, relative), { force: true })
  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package")
})
```

Add corrupt defaults, empty guide, invalid models JSON, empty `app.asar`, and wrong license tests. The defaults fixture must contain `enabled_providers: ["company-llm"]`; `models.json` only needs to be a valid local object because the configured model comes from the enterprise profile.

- [ ] **Step 2: Write failing ZIP entry and release-artifact tests**

Use `@zip.js/zip.js` to build an in-memory test archive and assert exact required entries. Add deterministic release tests with an injected clock and commit:

```ts
test("writes checksum and non-secret release metadata", async () => {
  const result = await writeEnterpriseRelease({
    archive,
    version: "1.17.18",
    gitCommit: "0123456789abcdef",
    builtAt: new Date("2026-07-15T00:00:00.000Z"),
    profile: validateEnterpriseBuild(valid),
  })
  expect(result).toMatchObject({
    schemaVersion: 1,
    artifact: "company-opencode-pilot-1.17.18-win-x64.zip",
    appVersion: "1.17.18",
    gitCommit: "0123456789abcdef",
    target: { os: "win32", arch: "x64" },
    authenticode: "NotSigned",
    windowsAcceptance: [],
  })
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
})
```

Assert the checksum file is exactly `<hash>  <archive-name>\n` and serialized metadata contains no base URL, credential, authorization header, or signing environment value.

- [ ] **Step 3: Run Task 2 RED tests**

Run from `packages/desktop`:

```bash
bun test scripts/verify-enterprise-package.test.ts scripts/enterprise-release.test.ts
```

Expected: module-not-found failures for both new implementations.

- [ ] **Step 4: Implement unpacked and ZIP verification**

Implement package verification with `Bun.file`, `node:fs/promises`, and ZIP.js:

```ts
export async function verifyEnterprisePackage(root: string) {
  const files = {
    executable: path.join(root, "Company OpenCode Pilot.exe"),
    defaults: path.join(root, "resources", "enterprise", "opencode.jsonc"),
    guide: path.join(root, "resources", "enterprise", "company-guide.md"),
    models: path.join(root, "resources", "enterprise", "models.json"),
    appArchive: path.join(root, "resources", "app.asar"),
    license: path.join(root, "resources", "licenses", "OpenCode-LICENSE"),
  }
  await Promise.all(Object.values(files).map((file) => access(file)))
  const defaults = await Bun.file(files.defaults).json()
  const models = await Bun.file(files.models).json()
  if (!defaults.enabled_providers?.includes("company-llm")) throw new Error("Portable package defaults are invalid")
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Portable package catalog is invalid")
  if (!(await Bun.file(files.guide).text()).startsWith("# ")) throw new Error("Portable package guide is invalid")
  if ((await stat(files.appArchive)).size === 0) throw new Error("Portable package archive is empty")
  if (!(await Bun.file(files.license).text()).includes("MIT License")) throw new Error("Portable package license is invalid")
  return { executable: path.basename(files.executable), defaults: true, guide: true, models: true, appArchive: true, license: true }
}
```

`verifyEnterpriseArchive` opens the ZIP through `ZipReader` and requires the same six normalized forward-slash paths at the ZIP root. Reject duplicate normalized names, parent traversal, absolute entries, missing files, and extra top-level installer/uninstaller executables.

- [ ] **Step 5: Implement checksum and release metadata generation**

Create a streaming SHA-256 helper and write adjacent `.sha256` and `.release.json` files:

```ts
export async function writeEnterpriseRelease(input: {
  archive: string
  version: string
  gitCommit: string
  builtAt: Date
  profile: EnterpriseBuildMetadata
}) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(input.archive).stream()) hasher.update(chunk)
  const sha256 = hasher.digest("hex")
  const artifact = path.basename(input.archive)
  const metadata = {
    schemaVersion: 1,
    appVersion: input.version,
    gitCommit: input.gitCommit,
    artifact,
    sha256,
    defaultsVersion: input.profile.defaultsVersion,
    guideVersion: input.profile.guideVersion,
    modelID: input.profile.modelID,
    target: { os: "win32", arch: "x64" },
    builtAt: input.builtAt.toISOString(),
    authenticode: "NotSigned" as const,
    windowsAcceptance: [],
  }
  await Bun.write(`${input.archive}.sha256`, `${sha256}  ${artifact}\n`)
  await Bun.write(input.archive.replace(/\.zip$/, ".release.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}
```

- [ ] **Step 6: Integrate verification and release output into the runner**

After electron-builder exits zero, compute paths from `packages/desktop/package.json` version, verify `dist/win-unpacked`, verify the versioned ZIP, resolve `git rev-parse HEAD`, and write release artifacts. Keep these dependencies injectable in runner tests so command order is asserted as:

```text
validate -> build -> package -> verify-unpacked -> verify-zip -> git-commit -> release
```

Add `verify:enterprise:package` to `package.json`:

```json
"verify:enterprise:package": "bun ./scripts/verify-enterprise-package.ts ./dist/win-unpacked"
```

- [ ] **Step 7: Run Task 2 GREEN verification**

Run from `packages/desktop`:

```bash
bun test scripts/verify-enterprise-package.test.ts scripts/enterprise-release.test.ts scripts/package-enterprise-win.test.ts electron-builder.config.test.ts
bun test
bun typecheck
bunx prettier --check scripts/verify-enterprise-package.ts scripts/verify-enterprise-package.test.ts scripts/enterprise-release.ts scripts/enterprise-release.test.ts scripts/package-enterprise-win.ts scripts/package-enterprise-win.test.ts package.json
bunx oxlint scripts/verify-enterprise-package.ts scripts/enterprise-release.ts scripts/package-enterprise-win.ts
git diff --check
```

Expected: all tests pass, all output paths are versioned, and no signing secret appears in fixtures or serialized metadata.

- [ ] **Step 8: Commit package verification**

```bash
git add packages/desktop/scripts/verify-enterprise-package.ts packages/desktop/scripts/verify-enterprise-package.test.ts packages/desktop/scripts/enterprise-release.ts packages/desktop/scripts/enterprise-release.test.ts packages/desktop/scripts/package-enterprise-win.ts packages/desktop/scripts/package-enterprise-win.test.ts packages/desktop/package.json
git commit -m "feat(desktop): verify portable pilot artifacts"
```

---

### Task 3: Add Windows portable smoke automation

**Files:**
- Create: `packages/desktop/scripts/windows-portable-smoke.ps1`
- Create: `packages/desktop/scripts/windows-portable-smoke.test.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Produces: PowerShell command accepting `-Archive`, `-Checksum`, `-ReleaseMetadata`, `-AllowedHost`, and `-SentinelProject`.
- Updates: `windowsAcceptance` in the release metadata after a passing native smoke run.

- [ ] **Step 1: Write the PowerShell contract test**

The Bun test reads the script and requires the exact parameter names and safety primitives. On Windows, it additionally asks PowerShell to parse the script without executing it:

```ts
test("portable smoke script exposes the release contract", async () => {
  const script = await Bun.file(new URL("./windows-portable-smoke.ps1", import.meta.url)).text()
  for (const token of [
    "$Archive",
    "$Checksum",
    "$ReleaseMetadata",
    "$AllowedHost",
    "$SentinelProject",
    "Get-FileHash",
    "Expand-Archive",
    "Get-AuthenticodeSignature",
    "Get-NetTCPConnection",
    "Get-CimInstance Win32_Process",
  ]) expect(script).toContain(token)
  expect(script).not.toMatch(/Remove-Item[^\r\n]*com\.company\.opencode\.pilot/i)
  expect(script).not.toMatch(/Remove-Item[^\r\n]*SentinelProject/i)
})
```

Add a Windows-only child test that runs:

```powershell
[void][scriptblock]::Create((Get-Content -Raw .\scripts\windows-portable-smoke.ps1))
```

- [ ] **Step 2: Run the smoke contract RED test**

Run from `packages/desktop`:

```bash
bun test scripts/windows-portable-smoke.test.ts
```

Expected: module/file-not-found failure.

- [ ] **Step 3: Implement checksum, extraction, signature, and process helpers**

Start the script with strict parameters and fixed failure behavior:

```powershell
param(
  [Parameter(Mandatory = $true)][string] $Archive,
  [Parameter(Mandatory = $true)][string] $Checksum,
  [Parameter(Mandatory = $true)][string] $ReleaseMetadata,
  [Parameter(Mandatory = $true)][string] $AllowedHost,
  [Parameter(Mandatory = $true)][string] $SentinelProject
)

$ErrorActionPreference = "Stop"
$expectedHash = ((Get-Content -Raw $Checksum).Trim() -split "\s+")[0].ToUpperInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) { throw "Portable archive checksum mismatch" }
```

Create a unique temporary extraction directory, call `Expand-Archive`, require exactly one `Company OpenCode Pilot.exe`, and require `Get-AuthenticodeSignature(...).Status -eq "NotSigned"`.

Add `Get-ProcessTreeIds` using `Get-CimInstance Win32_Process`, and collect established connections through `Get-NetTCPConnection`. Resolve `AllowedHost` to A/AAAA addresses and allow only those addresses plus `127.0.0.1`, `::1`, and IPv4-mapped loopback.

- [ ] **Step 4: Implement persistence and replacement smoke flow**

The script must:

1. Create `SentinelProject\keep.txt`.
2. Launch the extracted executable and wait 10 seconds.
3. Fail if the process exits during startup.
4. Audit the complete process tree's established TCP destinations.
5. Stop the process tree in `finally`.
6. Require `%LOCALAPPDATA%\com.company.opencode.pilot` to exist.
7. Write `portable-smoke-sentinel.txt` into that AppData directory.
8. Delete the extracted application directory, extract the same archive again, and relaunch.
9. Confirm both AppData and project sentinel files remain.
10. Stop the app and delete only the temporary extracted directory.

On success, load the release JSON, append this record, and write it back atomically:

```powershell
$record = [ordered]@{
  windowsVersion = (Get-CimInstance Win32_OperatingSystem).Caption
  windowsBuild = [Environment]::OSVersion.Version.ToString()
  testedAt = [DateTime]::UtcNow.ToString("o")
  tester = $env:USERNAME
  result = "pass"
}
$metadata.windowsAcceptance = @($metadata.windowsAcceptance) + $record
```

The script must never remove the enterprise AppData directory or the sentinel project.

- [ ] **Step 5: Add the package script and run static verification**

Add:

```json
"smoke:enterprise:portable": "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/windows-portable-smoke.ps1"
```

Run from `packages/desktop`:

```bash
bun test scripts/windows-portable-smoke.test.ts
bun typecheck
bunx prettier --check scripts/windows-portable-smoke.test.ts package.json
git diff --check
```

Expected on macOS: the contract test passes and native PowerShell execution is skipped. Expected on Windows: contract and parse tests both pass.

- [ ] **Step 6: Commit Windows smoke automation**

```bash
git add packages/desktop/scripts/windows-portable-smoke.ps1 packages/desktop/scripts/windows-portable-smoke.test.ts packages/desktop/package.json
git commit -m "test(desktop): add portable windows smoke"
```

---

### Task 4: Publish the portable release runbook and verify the deliverable

**Files:**
- Create: `docs/enterprise/windows-portable-pilot-release.md`
- Modify: `.superpowers/sdd/progress.md` (ignored local progress only)

**Interfaces:**
- Produces: exact clean-checkout-to-acceptance operator workflow.
- Records: Windows 10 and Windows 11 acceptance in the release metadata.

- [ ] **Step 1: Write the Windows operator runbook**

Include this exact PowerShell setup without CSC or certificate variables:

```powershell
$env:OPENCODE_ENTERPRISE = "1"
$env:OPENCODE_ENTERPRISE_BASE_URL = "https://llm.corp.example/v1"
$env:OPENCODE_ENTERPRISE_MODEL_ID = "company-code"
$env:OPENCODE_ENTERPRISE_MODEL_NAME = "Company Code"
$env:OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = "https://llm.corp.example"
$env:OPENCODE_ENTERPRISE_DEFAULTS_VERSION = "pilot-1"
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION = "pilot-1"

Set-Location packages\desktop
bun test
bun typecheck
bun run package:enterprise:win
```

Then show how to locate the versioned ZIP, `.sha256`, and `.release.json`, run `verify:enterprise:package`, and execute:

```powershell
bun run smoke:enterprise:portable -- `
  -Archive .\dist\company-opencode-pilot-1.17.18-win-x64.zip `
  -Checksum .\dist\company-opencode-pilot-1.17.18-win-x64.zip.sha256 `
  -ReleaseMetadata .\dist\company-opencode-pilot-1.17.18-win-x64.release.json `
  -AllowedHost llm.corp.example `
  -SentinelProject "$env:USERPROFILE\CompanyOpenCodePilotSentinel"
```

Document that direct enterprise electron-builder commands and `--prepackaged` are unsupported, the executable is intentionally unsigned, SmartScreen or endpoint-protection approval may be required, and checksum delivery must use the trusted internal channel.

- [ ] **Step 2: Add the manual acceptance checklist**

Require confirmation of:

- Guide and version display.
- Credential save, restart, and DPAPI persistence.
- Basic response, streaming, and tool-call diagnostics.
- Project override to a second allowed internal origin.
- Rejection of a public provider origin.
- No public OpenCode traffic during startup, idle, setup, chat, and shutdown.
- Normal Windows trust-store behavior with no TLS bypass option.
- Folder replacement preserves settings and credentials.
- Extracted-folder deletion preserves AppData and projects.
- ZIP and checksum survive transfer through the internal distribution channel.

- [ ] **Step 3: Run complete source verification**

Run package-local focused tests and typechecks from `packages/core`, `packages/opencode`, `packages/client`, `packages/app`, and `packages/desktop`. At minimum include:

```bash
# packages/opencode
bun test test/session/system.test.ts test/config/config.test.ts test/permission/next.test.ts
bun typecheck

# packages/app
bun test src/desktop-menu.test.ts src/context/highlights.test.ts
bun run test:browser
bun typecheck
bun run typecheck:e2e

# packages/desktop
bun test
bun typecheck
```

Run the enterprise Playwright suite outside the local-listener sandbox when necessary:

```bash
bun run test:e2e -- e2e/company-llm-enterprise.spec.ts
```

Record the existing unrelated Arabic locale parity failure separately if the non-CI full app suite is run; do not treat it as a portable-package regression.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/enterprise/windows-portable-pilot-release.md
git commit -m "docs: add portable windows release runbook"
```

- [ ] **Step 5: Build and accept on Windows x64**

On the controlled Windows build machine:

1. Start from the reviewed clean commit.
2. Run the exact runbook build command.
3. Confirm the ZIP, checksum, and metadata filenames and hashes.
4. Run package verification against `dist\win-unpacked`.
5. Run the PowerShell smoke once on clean Windows 10 x64 and once on clean Windows 11 x64 with public internet blocked.
6. Complete the manual checklist on both VMs.
7. Confirm two passing records exist in `windowsAcceptance`.

Expected: both VMs pass, Authenticode status is `NotSigned`, no public egress is observed, and AppData/projects survive application-folder replacement and deletion.

- [ ] **Step 6: Final independent review and candidate tag**

Generate one immutable review package from the portable design base through the accepted release commit. Use a fresh reviewer to inspect package identity, archive verification, checksum/metadata safety, PowerShell destructive boundaries, public egress, and Windows evidence.

Only after approval and a clean worktree:

```bash
git tag -a enterprise-portable-pilot-v1 -m "Company OpenCode portable enterprise pilot v1"
```

Expected: annotated tag points to the exact commit used for both Windows acceptance records.
