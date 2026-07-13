# Windows Pilot Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify one signed Windows 10/11 x64 NSIS installer for the enterprise offline pilot.

**Architecture:** Enterprise packaging is a separate electron-builder configuration branch selected by the build profile. A preflight script requires all non-secret model metadata and signing inputs, builds x64 only, and a Windows smoke script verifies signature, resources, install/reinstall/uninstall persistence, idle network destinations, and local startup.

**Tech Stack:** electron-builder NSIS, Bun build scripts, PowerShell, Windows Authenticode, Electron package resources.

## Global Constraints

- Complete the foundation, Company LLM connection, and guidance harness plans first.
- Target Windows 10 and Windows 11 x64 only.
- Produce one per-user, one-click NSIS installer.
- The installer and first launch must not require public internet access.
- The pilot has no GitHub publish configuration and no automatic update feed.
- The installer must be Authenticode-signed and the signature must verify as `Valid`.
- The installer must contain the local sidecar, enterprise defaults, company guide, icons, and static assets.
- Reinstall and upgrade preserve user config, encrypted credentials, local state, and projects.
- Uninstall must not remove user projects.
- Signing secrets are build inputs and must not be committed.
- Preserve the upstream OpenCode license notice in the installed resources.
- Run tests and `bun typecheck` from package directories.

---

### Task 1: Add a distinct enterprise installer identity

**Files:**
- Modify: `packages/desktop/electron-builder.config.ts`
- Modify: `packages/desktop/electron-builder.config.test.ts`
- Modify: `packages/desktop/src/main/constants.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/index.test.ts`
- Modify: `packages/desktop/src/main/windows.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`

**Interfaces:**
- Produces stable enterprise identity `com.company.opencode.pilot` and product name `Company OpenCode Pilot`.
- Produces artifact name `company-opencode-pilot-${os}-${arch}.${ext}`.
- Enterprise config has no `publish` field and retains one-click, per-user NSIS.
- Enterprise config does not register the upstream `opencode://` protocol handler.

- [ ] **Step 1: Write failing builder and runtime identity tests**

Append to `electron-builder.config.test.ts`:

```ts
test("enterprise pilot uses an isolated signed Windows identity without a publisher", async () => {
  const previous = Object.fromEntries(
    [
      "OPENCODE_ENTERPRISE",
      "OPENCODE_ENTERPRISE_BASE_URL",
      "OPENCODE_ENTERPRISE_MODEL_ID",
      "OPENCODE_ENTERPRISE_MODEL_NAME",
      "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
      "OPENCODE_ENTERPRISE_DEFAULTS_VERSION",
      "OPENCODE_ENTERPRISE_GUIDE_VERSION",
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
    ].map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, {
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
    OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
    OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
    CSC_LINK: "C:/signing/company.pfx",
    CSC_KEY_PASSWORD: "secret",
  })

  const config = await import("./electron-builder.config.ts?enterprise=pilot")
    .then((module) => module.default as Configuration)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
          continue
        }
        process.env[key] = value
      }
    })

  expect(config.appId).toBe("com.company.opencode.pilot")
  expect(config.productName).toBe("Company OpenCode Pilot")
  expect(config.artifactName).toBe("company-opencode-pilot-${os}-${arch}.${ext}")
  expect(config.publish).toBeUndefined()
  expect(config.protocols).toBeUndefined()
  expect(config.win?.target).toEqual(["nsis"])
  expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false })
})
```

Add a pure runtime identity test to `src/main/index.test.ts`:

```ts
expect(desktopIdentity({ channel: "prod", enterprise: true })).toEqual({
  appId: "com.company.opencode.pilot",
  name: "Company OpenCode Pilot",
})
```

- [ ] **Step 2: Run tests and verify failure**

Run from `packages/desktop`:

```bash
bun test electron-builder.config.test.ts src/main/index.test.ts
```

Expected: FAIL because enterprise packaging and `desktopIdentity` are absent.

- [ ] **Step 3: Implement enterprise builder selection**

At module load in `electron-builder.config.ts`, compute:

```ts
const enterprise = process.env.OPENCODE_ENTERPRISE === "1"
```

Return this branch before the channel switch:

```ts
if (enterprise) {
  return {
    ...getBase("com.company.opencode.pilot"),
    appId: "com.company.opencode.pilot",
    productName: "Company OpenCode Pilot",
    artifactName: "company-opencode-pilot-${os}-${arch}.${ext}",
    protocols: undefined,
    win: {
      ...getBase("com.company.opencode.pilot").win,
      target: ["nsis"],
      signtoolOptions: undefined,
    },
    extraResources: [
      ...(getBase("com.company.opencode.pilot").extraResources ?? []),
      { from: "resources/enterprise", to: "enterprise", filter: ["**/*"] },
      { from: "../../LICENSE", to: "licenses/OpenCode-LICENSE" },
    ],
  }
}
```

Leaving `signtoolOptions` undefined allows electron-builder to use standard `CSC_LINK` and `CSC_KEY_PASSWORD` signing inputs instead of the upstream Azure callback. Do not add `publish`.

In `src/main/constants.ts`, export:

```ts
export function desktopIdentity(input: { channel: Channel; enterprise: boolean }) {
  if (input.enterprise) return { appId: "com.company.opencode.pilot", name: "Company OpenCode Pilot" }
  if (input.channel === "dev") return { appId: "ai.opencode.desktop.dev", name: "OpenCode Dev" }
  if (input.channel === "beta") return { appId: "ai.opencode.desktop.beta", name: "OpenCode Beta" }
  return { appId: "ai.opencode.desktop", name: "OpenCode" }
}
```

Use this identity in `index.ts` for `app.setName`, `app.setAppUserModelId`, and the `userData` path. Remove duplicated local identity maps. Use `app.getName()` for the BrowserWindow title in `windows.ts`, and set `document.title` to `Company OpenCode Pilot` in the enterprise renderer before mounting the app. Guard `app.setAsDefaultProtocolClient("opencode")` with `!ENTERPRISE_ENABLED`; the pilot has no external deep-link requirement and must not take ownership of an ordinary OpenCode installation's protocol.

- [ ] **Step 4: Run identity tests and desktop typecheck**

Run from `packages/desktop`:

```bash
bun test electron-builder.config.test.ts src/main/index.test.ts
bun typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit installer identity**

```bash
git add packages/desktop/electron-builder.config.ts packages/desktop/electron-builder.config.test.ts packages/desktop/src/main/constants.ts packages/desktop/src/main/index.ts packages/desktop/src/main/index.test.ts packages/desktop/src/main/windows.ts packages/desktop/src/renderer/index.tsx
git commit -m "feat(desktop): add pilot installer identity"
```

### Task 2: Add enterprise package preflight and x64 build command

**Files:**
- Create: `packages/desktop/scripts/enterprise-build.ts`
- Create: `packages/desktop/scripts/enterprise-build.test.ts`
- Create: `packages/desktop/scripts/package-enterprise-win.ts`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/electron-builder.config.ts`

**Interfaces:**
- Produces: `validateEnterpriseBuild(env)` with normalized non-secret metadata.
- Produces package command `bun run package:enterprise:win`.
- Requires `CSC_LINK` and `CSC_KEY_PASSWORD` without printing either value.

- [ ] **Step 1: Write failing build-input tests**

```ts
// packages/desktop/scripts/enterprise-build.test.ts
import { expect, test } from "bun:test"
import { validateEnterpriseBuild } from "./enterprise-build"

const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  CSC_LINK: "C:/signing/company.pfx",
  CSC_KEY_PASSWORD: "secret",
}

test("accepts complete enterprise build inputs", () => {
  expect(validateEnterpriseBuild(valid)).toMatchObject({
    baseURL: "https://llm.corp.example/v1",
    modelID: "company-code",
    defaultsVersion: "pilot-1",
    guideVersion: "pilot-1",
  })
})

test("rejects missing signing input without echoing secrets", () => {
  expect(() => validateEnterpriseBuild({ ...valid, CSC_KEY_PASSWORD: undefined })).toThrow("CSC_KEY_PASSWORD")
})

test("rejects public model endpoints outside declared origins", () => {
  expect(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: "https://api.openai.com/v1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
    }),
  ).toThrow("allowed origins")
})

test("rejects credentials embedded in the model endpoint", () => {
  expect(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: "https://user:secret@llm.corp.example/v1",
    }),
  ).toThrow("must not contain credentials")
})
```

- [ ] **Step 2: Run the test and verify failure**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-build.test.ts
```

Expected: FAIL because `enterprise-build.ts` does not exist.

- [ ] **Step 3: Implement strict preflight validation**

```ts
// packages/desktop/scripts/enterprise-build.ts
type Env = Record<string, string | undefined>

function requireValue(env: Env, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required for an enterprise Windows package`)
  return value
}

export function validateEnterpriseBuild(env: Env) {
  if (env.OPENCODE_ENTERPRISE !== "1") throw new Error("OPENCODE_ENTERPRISE must be 1")
  const baseURL = requireValue(env, "OPENCODE_ENTERPRISE_BASE_URL")
  const base = new URL(baseURL)
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Base URL must use HTTP(S)")
  if (base.username || base.password) throw new Error("Base URL must not contain credentials")
  const origin = base.origin
  const allowedOrigins = requireValue(env, "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = new URL(item)
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Allowed origins must use HTTP(S)")
      if (url.username || url.password) throw new Error("Allowed origins must not contain credentials")
      return url.origin
    })
  if (!allowedOrigins.includes(origin)) throw new Error("Base URL is outside allowed origins")
  requireValue(env, "CSC_LINK")
  requireValue(env, "CSC_KEY_PASSWORD")
  return {
    baseURL,
    modelID: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_ID"),
    modelName: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_NAME"),
    defaultsVersion: requireValue(env, "OPENCODE_ENTERPRISE_DEFAULTS_VERSION"),
    guideVersion: requireValue(env, "OPENCODE_ENTERPRISE_GUIDE_VERSION"),
    allowedOrigins,
  }
}
```

The preflight must never include `CSC_LINK`, `CSC_KEY_PASSWORD`, API keys, or secret headers in its return value or error details.

- [ ] **Step 4: Add the Windows-only package runner**

```ts
// packages/desktop/scripts/package-enterprise-win.ts
import { validateEnterpriseBuild } from "./enterprise-build"

if (process.platform !== "win32") throw new Error("Enterprise pilot packaging must run on Windows x64")
if (process.arch !== "x64") throw new Error("Enterprise pilot packaging requires Windows x64")
validateEnterpriseBuild(process.env)

for (const command of [
  ["bun", "run", "build"],
  ["bun", "run", "package:win", "--x64"],
]) {
  const child = Bun.spawn(command, { cwd: import.meta.dir + "/..", env: process.env, stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) process.exit(code)
}
```

Add to `package.json`:

```json
"package:enterprise:win": "bun ./scripts/package-enterprise-win.ts"
```

Call `validateEnterpriseBuild(process.env)` from the enterprise branch of `electron-builder.config.ts` so direct builder invocation cannot bypass preflight.

- [ ] **Step 5: Run build-script tests and desktop typecheck**

Run from `packages/desktop`:

```bash
bun test scripts/enterprise-build.test.ts electron-builder.config.test.ts
bun typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit packaging preflight**

```bash
git add packages/desktop/scripts/enterprise-build.ts packages/desktop/scripts/enterprise-build.test.ts packages/desktop/scripts/package-enterprise-win.ts packages/desktop/package.json packages/desktop/electron-builder.config.ts
git commit -m "feat(desktop): add pilot package preflight"
```

### Task 3: Add package-content and Windows smoke verification

**Files:**
- Create: `packages/desktop/scripts/verify-enterprise-package.ts`
- Create: `packages/desktop/scripts/verify-enterprise-package.test.ts`
- Create: `packages/desktop/scripts/windows-pilot-smoke.ps1`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Produces: `verifyEnterprisePackage(root)` for unpacked resources.
- Produces command `bun run verify:enterprise:package`.
- Produces PowerShell smoke script accepting `-Installer`, `-AllowedHost`, and `-SentinelProject`.

- [ ] **Step 1: Write failing package-content tests**

```ts
// packages/desktop/scripts/verify-enterprise-package.test.ts
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { verifyEnterprisePackage } from "./verify-enterprise-package"

let dir = ""
afterEach(async () => dir && rm(dir, { recursive: true, force: true }))

test("requires application archive and all enterprise resources", async () => {
  dir = await mkdtemp(join(tmpdir(), "enterprise-package-"))
  await mkdir(join(dir, "resources", "enterprise"), { recursive: true })
  await mkdir(join(dir, "resources", "licenses"), { recursive: true })
  await writeFile(join(dir, "resources", "enterprise", "opencode.jsonc"), '{"provider":{"company-llm":{}}}')
  await writeFile(join(dir, "resources", "enterprise", "company-guide.md"), "# 사내 AI 활용 기본 가이드")
  await writeFile(join(dir, "resources", "enterprise", "models.json"), "{}")
  await writeFile(join(dir, "resources", "app.asar"), "archive")
  await writeFile(join(dir, "resources", "licenses", "OpenCode-LICENSE"), "MIT License")
  await expect(verifyEnterprisePackage(dir)).resolves.toEqual({
    defaults: true,
    guide: true,
    models: true,
    appArchive: true,
    license: true,
  })
})
```

- [ ] **Step 2: Run the test and verify failure**

Run from `packages/desktop`:

```bash
bun test scripts/verify-enterprise-package.test.ts
```

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement package-content verification**

```ts
// packages/desktop/scripts/verify-enterprise-package.ts
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

export async function verifyEnterprisePackage(root: string) {
  const paths = {
    defaults: join(root, "resources", "enterprise", "opencode.jsonc"),
    guide: join(root, "resources", "enterprise", "company-guide.md"),
    models: join(root, "resources", "enterprise", "models.json"),
    appArchive: join(root, "resources", "app.asar"),
    license: join(root, "resources", "licenses", "OpenCode-LICENSE"),
  }
  await Promise.all(Object.values(paths).map((file) => access(file)))
  const defaults = await readFile(paths.defaults, "utf8")
  const guide = await readFile(paths.guide, "utf8")
  const models = await readFile(paths.models, "utf8")
  const license = await readFile(paths.license, "utf8")
  if (!defaults.includes("company-llm")) throw new Error("Enterprise defaults do not contain company-llm")
  if (!guide.includes("사내 AI 활용 기본 가이드")) throw new Error("Company guide content is missing")
  JSON.parse(models)
  if (!license.includes("MIT License")) throw new Error("OpenCode license notice is missing")
  return { defaults: true, guide: true, models: true, appArchive: true, license: true }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error("Pass the win-unpacked directory")
  await verifyEnterprisePackage(root)
}
```

Add:

```json
"verify:enterprise:package": "bun ./scripts/verify-enterprise-package.ts ./dist/win-unpacked"
```

- [ ] **Step 4: Add the Windows install and idle-network smoke script**

The PowerShell script must perform these exact checks and throw on failure:

```powershell
param(
  [Parameter(Mandatory = $true)][string] $Installer,
  [Parameter(Mandatory = $true)][string] $AllowedHost,
  [Parameter(Mandatory = $true)][string] $SentinelProject
)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature $Installer
if ($signature.Status -ne "Valid") { throw "Installer signature is $($signature.Status)" }

New-Item -ItemType Directory -Force -Path $SentinelProject | Out-Null
Set-Content -Path (Join-Path $SentinelProject "keep.txt") -Value "preserve"
Start-Process -FilePath $Installer -ArgumentList "/S" -Wait

$app = Join-Path $env:LOCALAPPDATA "Programs\Company OpenCode Pilot\Company OpenCode Pilot.exe"
if (-not (Test-Path $app)) { throw "Installed executable is missing" }
$appSignature = Get-AuthenticodeSignature $app
if ($appSignature.Status -ne "Valid") { throw "Installed executable signature is $($appSignature.Status)" }
$process = Start-Process -FilePath $app -PassThru
Start-Sleep -Seconds 10

$allowed = @(Resolve-DnsName $AllowedHost -ErrorAction Stop |
  Where-Object { $_.Type -in @("A", "AAAA") } |
  Select-Object -ExpandProperty IPAddress)
if ($allowed.Count -eq 0) { throw "Allowed host did not resolve to an A or AAAA address" }
function Get-ProcessTreeIds([int] $RootId) {
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $before = $ids.Count
    Get-CimInstance Win32_Process | Where-Object { $ids.Contains([int]$_.ParentProcessId) } |
      ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }
  } while ($ids.Count -ne $before)
  return @($ids)
}

$processIds = Get-ProcessTreeIds $process.Id
$connections = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -in $processIds }
$unexpected = @($connections | Where-Object {
  $_.RemoteAddress -notin $allowed -and
  $_.RemoteAddress -notin @("127.0.0.1", "::1", "0.0.0.0")
})
if ($unexpected.Count -gt 0) { throw "Unexpected network destination: $($unexpected.RemoteAddress -join ', ')" }

Stop-Process -Id $process.Id -Force
Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
$uninstaller = Join-Path $env:LOCALAPPDATA "Programs\Company OpenCode Pilot\Uninstall Company OpenCode Pilot.exe"
if (-not (Test-Path $uninstaller)) { throw "Uninstaller is missing" }
Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
if (-not (Test-Path (Join-Path $SentinelProject "keep.txt"))) { throw "Uninstall removed the sentinel project" }
```

`Get-ProcessTreeIds` makes the final network check include the Electron main process, renderers, utility sidecar, and crash handler.

- [ ] **Step 5: Run verifier tests and desktop typecheck**

Run from `packages/desktop`:

```bash
bun test scripts/verify-enterprise-package.test.ts
bun typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit release verification scripts**

```bash
git add packages/desktop/scripts/verify-enterprise-package.ts packages/desktop/scripts/verify-enterprise-package.test.ts packages/desktop/scripts/windows-pilot-smoke.ps1 packages/desktop/package.json
git commit -m "test(desktop): add pilot package verification"
```

### Task 4: Document and execute the pilot release checklist

**Files:**
- Create: `docs/enterprise/windows-pilot-release.md`

**Interfaces:**
- Provides the exact operator workflow from clean checkout to accepted installer.

- [ ] **Step 1: Write the operator checklist**

The document must contain these commands using PowerShell environment variables:

```powershell
$env:OPENCODE_ENTERPRISE = "1"
$env:OPENCODE_ENTERPRISE_BASE_URL = "https://llm.corp.example/v1"
$env:OPENCODE_ENTERPRISE_MODEL_ID = "company-code"
$env:OPENCODE_ENTERPRISE_MODEL_NAME = "Company Code"
$env:OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = "https://llm.corp.example"
$env:OPENCODE_ENTERPRISE_DEFAULTS_VERSION = "pilot-1"
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION = "pilot-1"
$env:CSC_LINK = "C:\signing\company-opencode.pfx"
$signingPassword = Read-Host -AsSecureString
$env:CSC_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $signingPassword).Password

Set-Location packages\desktop
bun test scripts\enterprise-build.test.ts scripts\verify-enterprise-package.test.ts electron-builder.config.test.ts
bun typecheck
bun run package:enterprise:win
bun run verify:enterprise:package
Get-AuthenticodeSignature .\dist\company-opencode-pilot-win-x64.exe
.\scripts\windows-pilot-smoke.ps1 -Installer .\dist\company-opencode-pilot-win-x64.exe -AllowedHost llm.corp.example -SentinelProject "$env:USERPROFILE\CompanyOpenCodePilotSentinel"
```

The checklist must also require manual confirmation of:

- First launch with public internet blocked.
- Company guide and version display.
- Encrypted credential save and restart.
- Basic response, streaming, and tool-call diagnostics.
- Company-CA TLS succeeds through the Windows trust store, while an untrusted certificate fails without a bypass option.
- Project override to a second allowed internal origin.
- Rejection of a public provider origin.
- No OpenCode Console, models.dev, sharing, updater, plugin registry, LSP download, WSL download, changelog, documentation, feedback, icon, or Discord traffic during startup, idle, setup, chat, and shutdown.
- Reinstall preserves settings and credentials.
- Uninstall preserves projects.

- [ ] **Step 2: Commit the release runbook**

```bash
git add docs/enterprise/windows-pilot-release.md
git commit -m "docs: add windows pilot release runbook"
```

- [ ] **Step 3: Run complete automated verification**

Run package-local tests and typechecks from `packages/core`, `packages/opencode`, `packages/client`, `packages/app`, and `packages/desktop`. Use the focused commands from the preceding three plans plus each package's `bun typecheck`.

Expected: zero test failures and every typecheck exits 0.

- [ ] **Step 4: Build and sign on Windows x64**

Run the exact PowerShell workflow in `docs/enterprise/windows-pilot-release.md` on the pilot Windows build machine.

Expected: one `company-opencode-pilot-win-x64.exe` artifact, package verifier success, and Authenticode status `Valid`.

- [ ] **Step 5: Execute Windows 10 and Windows 11 acceptance**

Run `windows-pilot-smoke.ps1` and the manual checklist once on a clean Windows 10 x64 VM and once on a clean Windows 11 x64 VM with public internet blocked.

Expected: every automated and manual checklist item passes on both operating systems. Record installer SHA-256, app version, defaults version, guide version, Windows version, test date, tester, and result in the release record.

- [ ] **Step 6: Tag the accepted pilot candidate**

After both acceptance records pass:

```bash
git status --short
git tag -a enterprise-pilot-v1 -m "Company OpenCode enterprise pilot v1"
```

Expected: clean worktree and annotated tag `enterprise-pilot-v1` on the tested commit.
