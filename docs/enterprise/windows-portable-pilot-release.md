# Company OpenCode Pilot: Windows Portable ZIP Release

This runbook is the only supported operator path from a reviewed source revision to Windows acceptance for the Company OpenCode Pilot portable release. It produces an unsigned Windows x64 ZIP and its integrity artifacts; it does not install the application, register a protocol, or remove user data.

## Release boundary

Use a controlled Windows x64 build machine and a reviewed, clean checkout of the exact commit to release. The build account needs Bun, the repository dependencies, Git, PowerShell 5.1 or later, and normal access to the approved internal LLM endpoint. The build machine and both acceptance VMs must trust the endpoint through the normal Windows trust store. Do not add a TLS bypass, install a private certificate as a workaround for this pilot, or use `--ignore-certificate-errors`.

Before building, confirm the repository is clean and record the commit:

```powershell
git status --short
git rev-parse HEAD
```

Both commands must produce, respectively, no output and the reviewed commit ID. Build only on Windows x64. Direct enterprise `electron-builder` commands and any `--prepackaged` path are unsupported. They bypass the release runner's fixed target, archive-to-unpacked verification, signing-environment removal, checksum, and metadata boundaries.

The executable is intentionally unsigned. Windows SmartScreen or endpoint-protection approval may be required through the organization’s normal software-approval process. Do not replace the artifact or bypass Windows security controls to make it run.

## Source verification

Run these checks before the controlled Windows build. Run every command from the named package directory, never from the repository root.

```powershell
Set-Location packages\core
bun test
bun typecheck

Set-Location ..\opencode
bun test test/session/system.test.ts test/config/config.test.ts test/permission/next.test.ts
bun typecheck

Set-Location ..\client
bun test
bun typecheck

Set-Location ..\app
bun test src/desktop-menu.test.ts src/context/highlights.test.ts
bun run test:browser
bun typecheck
bun run typecheck:e2e
# package.json defines test:e2e as "playwright test" and sets no environment variables.
bun run test:e2e -- e2e/company-llm-enterprise.spec.ts

Set-Location ..\desktop
bun test scripts/verify-enterprise-package.test.ts scripts/enterprise-release.test.ts scripts/windows-portable-smoke.test.ts
bun test
bun typecheck
```

The focused desktop command is the package-fixture check; it exercises the unpacked/ZIP contract, integrity metadata, and PowerShell smoke contract. The full desktop test command is required as the integrated source check. Run the enterprise Playwright command from `packages/app`: that package owns the `test:e2e` script and its Playwright configuration. It requires the local listener available to the test runner; run it outside a local-listener sandbox when required. If the non-CI full app suite is also run, record the known Arabic locale parity failure separately and do not classify it as a portable-package regression.

On a Windows acceptance VM, parse the PowerShell script before executing it:

```powershell
Set-Location packages\desktop
[void][scriptblock]::Create((Get-Content -Raw .\scripts\windows-portable-smoke.ps1))
bun test scripts/verify-enterprise-package.test.ts scripts/enterprise-release.test.ts scripts/windows-portable-smoke.test.ts
```

## Controlled Windows x64 build

From the clean checkout root, set only the approved non-secret enterprise inputs. Do not set `CSC_*`, `WIN_CSC_*`, certificate, signing, credential, or TLS-bypass variables. The release runner removes inherited signing variables from its child processes and rejects a non-Windows or non-x64 host.

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

The supported command builds the desktop, packages only the Windows x64 ZIP target, verifies `dist\win-unpacked`, checks the archive against that unpacked tree, and writes all three artifacts beside one another:

```text
dist\company-opencode-pilot-<version>-win-x64.zip
dist\company-opencode-pilot-<version>-win-x64.zip.sha256
dist\company-opencode-pilot-<version>-win-x64.release.json
```

Locate exactly one release set and retain it together:

```powershell
$archive = @(Get-ChildItem .\dist\company-opencode-pilot-*-win-x64.zip -File)
if ($archive.Count -ne 1) { throw "Expected exactly one portable ZIP in dist" }
$archive = $archive[0]
$checksum = "$($archive.FullName).sha256"
$releaseMetadata = Join-Path $archive.DirectoryName "$($archive.BaseName).release.json"
if (-not (Test-Path -LiteralPath $checksum -PathType Leaf)) { throw "Missing ZIP checksum" }
if (-not (Test-Path -LiteralPath $releaseMetadata -PathType Leaf)) { throw "Missing release metadata" }
$archive.FullName
$checksum
$releaseMetadata
```

## Build-host package and artifact verification

Verify the unpacked package before release. This command checks the expected executable, enterprise defaults, guide, model catalog, `app.asar`, and license notice:

```powershell
bun run verify:enterprise:package
```

Run the following shared host, ZIP, checksum, and release-metadata identity helper from a clean checkout at the reviewed build commit. It validates the exact release schema, verifies the ZIP hash, and binds the artifact, hash, and commit to the reviewed build. It deliberately does not print secrets because release metadata must not contain any.

```powershell
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::Is64BitProcess -eq $false) {
  throw "Portable release verification requires a Windows x64 host"
}
if ((Get-CimInstance Win32_OperatingSystem).Caption -notmatch "Windows") {
  throw "Portable release verification requires Windows"
}
$expectedCommit = (git rev-parse HEAD).Trim()
if ($archive.Name -notmatch '^company-opencode-pilot-.+-win-x64\.zip$') {
  throw "Unexpected portable ZIP name"
}
$checksumRecord = (Get-Content -Raw -LiteralPath $checksum).Trim()
if ($checksumRecord -notmatch '^([a-f0-9]{64})  (company-opencode-pilot-.+-win-x64\.zip)$') {
  throw "Checksum file has an invalid portable release format"
}
$expectedHash = $Matches[1]
$checksumArtifact = $Matches[2]
if ($checksumArtifact -ne $archive.Name) { throw "Checksum archive name mismatch" }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive.FullName).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw "ZIP checksum mismatch" }

function Assert-WindowsAcceptanceRecords {
  param([object[]] $Records)

  $expectedFields = @("result", "testedAt", "tester", "windowsBuild", "windowsVersion")
  foreach ($record in $Records) {
    if ($null -eq $record) { throw "Release metadata Windows acceptance is invalid" }
    $fields = @($record.PSObject.Properties.Name | Sort-Object)
    if (($fields -join ",") -ne ($expectedFields -join ",")) { throw "Release metadata Windows acceptance is invalid" }
    foreach ($field in $expectedFields) {
      if ($record.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($record.$field)) {
        throw "Release metadata Windows acceptance is invalid"
      }
    }
    if ($record.result -ne "pass") { throw "Release metadata Windows acceptance is invalid" }
  }
}

function Read-VerifiedPortableReleaseMetadata {
  param([string] $Path)

  $metadata = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  $expectedFields = @(
    "appVersion", "artifact", "authenticode", "builtAt", "defaultsVersion", "gitCommit", "guideVersion", "modelID",
    "schemaVersion", "sha256", "target", "windowsAcceptance"
  ) | Sort-Object
  if ($metadata -isnot [PSCustomObject] -or (@($metadata.PSObject.Properties.Name | Sort-Object) -join ",") -ne ($expectedFields -join ",")) {
    throw "Release metadata shape is invalid"
  }
  foreach ($field in @("appVersion", "artifact", "authenticode", "builtAt", "defaultsVersion", "gitCommit", "guideVersion", "modelID", "sha256")) {
    if ($metadata.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($metadata.$field)) {
      throw "Release metadata shape is invalid"
    }
  }
  if ($metadata.schemaVersion -is [string] -or $metadata.schemaVersion -is [bool] -or $metadata.schemaVersion -isnot [System.IConvertible]) {
    throw "Release metadata schema version is invalid"
  }
  try {
    $schemaVersion = [decimal]$metadata.schemaVersion
  } catch {
    throw "Release metadata schema version is invalid"
  }
  if ([decimal]::Truncate($schemaVersion) -ne $schemaVersion -or $schemaVersion -ne 1) {
    throw "Release metadata schema version is invalid"
  }
  if (
    $metadata.target -isnot [PSCustomObject] -or
    (@($metadata.target.PSObject.Properties.Name | Sort-Object) -join ",") -ne "arch,os" -or
    $metadata.target.os -ne "win32" -or
    $metadata.target.arch -ne "x64"
  ) {
    throw "Release metadata target mismatch"
  }
  if ($metadata.artifact -ne $archive.Name -or $metadata.sha256 -ne $actualHash -or $metadata.gitCommit -ne $expectedCommit) {
    throw "Release metadata identity mismatch"
  }
  if ($metadata.authenticode -ne "NotSigned" -or $metadata.windowsAcceptance -isnot [System.Array]) {
    throw "Release metadata signature or Windows acceptance is invalid"
  }
  Assert-WindowsAcceptanceRecords -Records ([object[]]$metadata.windowsAcceptance)
  return $metadata
}
```

### Pristine build-host validation

Call the shared helper on the controlled build host before distribution. This is the only stage that requires an empty acceptance array:

```powershell
$metadata = Read-VerifiedPortableReleaseMetadata -Path $releaseMetadata
if ($metadata.windowsAcceptance.Count -ne 0) {
  throw "Build artifact must begin with no Windows acceptance records"
}
```

The ZIP and checksum remain immutable throughout acceptance. The smoke script changes only the JSON by appending its fixed-schema acceptance records.

## Acceptance-transfer validation

Deliver the ZIP, `.sha256`, and `.release.json` through the approved trusted internal channel as one release set. Do not publish the unsigned ZIP to a public channel and do not rely on SmartScreen reputation as an integrity mechanism. Record the internal channel, sender, recipient, transfer time, and the SHA-256 value in the release record.

On Windows 10, run the shared identity helper followed by the pristine build-host validation before smoke. On Windows 11, run the shared identity helper but do not run the pristine assertion: it would reject the valid Windows 10 record that the smoke script needs to preserve. Instead, use the acceptance-transfer validation below. It verifies the same archive checksum, artifact name, and reviewed git commit, permits exactly one valid Windows 10 record, and rejects any other metadata shape or acceptance state.

```powershell
# Run the shared identity helper above in the clean checkout at the reviewed build commit.
$metadata = Read-VerifiedPortableReleaseMetadata -Path $releaseMetadata
if ($metadata.windowsAcceptance.Count -ne 1) { throw "Windows 11 requires exactly one Windows 10 acceptance record" }
$windows10 = $metadata.windowsAcceptance[0]
if ($windows10.windowsVersion -notmatch "Windows 10") { throw "Windows 11 requires a Windows 10 acceptance record" }
if ($windows10.result -ne "pass") { throw "Windows 10 acceptance did not pass" }
```

Transfer the Windows 10-updated `.release.json` with the unchanged ZIP and `.sha256` to Windows 11. The transfer is invalid if the ZIP SHA-256, artifact name, or git commit differs from the reviewed build values. A transfer that changes the ZIP or checksum is always a failure; a transfer that changes the release JSON outside its single valid Windows 10 record is also a failure. Quarantine a failed set and obtain a fresh copy from the controlled build output.

## Windows 10 and Windows 11 acceptance

Use two clean x64 VMs: one Windows 10 and one Windows 11. Block public internet before launching the pilot, while allowing DNS and the configured internal LLM endpoint. The endpoint must be trusted by the normal Windows trust store. Run the parser and package-fixture commands above on each VM before the smoke command. This release profile intentionally declares only `https://llm.corp.example`; do not add a second origin merely for acceptance testing.

Run the smoke on Windows 10 first. Copy the updated release JSON, not a newly generated JSON, to the Windows 11 VM before its run so the second successful execution appends the second record. Use the version selected above; this example shows version `1.17.18`.

```powershell
bun run smoke:enterprise:portable -- `
  -Archive .\dist\company-opencode-pilot-1.17.18-win-x64.zip `
  -Checksum .\dist\company-opencode-pilot-1.17.18-win-x64.zip.sha256 `
  -ReleaseMetadata .\dist\company-opencode-pilot-1.17.18-win-x64.release.json `
  -AllowedHost llm.corp.example `
  -SentinelProject "$env:USERPROFILE\CompanyOpenCodePilotSentinel"
```

The `smoke:enterprise:portable` wrapper uses PowerShell execution-policy scope only to run the local reviewed script. It is not a TLS or certificate bypass. The smoke validates the ZIP hash before extraction, requires `Get-AuthenticodeSignature` to report `NotSigned`, tracks the process tree's established TCP destinations through startup and shutdown, permits only the resolved allowed host plus exact loopback, validates AppData persistence across folder replacement, preserves the sentinel project, removes only its temporary extraction directory, and then appends a passing record atomically.

After both successful runs, validate the final metadata on the controlled release host:

```powershell
$metadata = Get-Content -Raw -LiteralPath $releaseMetadata | ConvertFrom-Json
$records = @($metadata.windowsAcceptance)
if ($records.Count -ne 2) { throw "Expected exactly two Windows acceptance records" }
if (@($records | Where-Object { $_.result -ne "pass" }).Count -ne 0) { throw "Windows acceptance did not pass" }
if (@($records | Where-Object { $_.windowsVersion -match "Windows 10" }).Count -ne 1) { throw "Missing Windows 10 acceptance" }
if (@($records | Where-Object { $_.windowsVersion -match "Windows 11" }).Count -ne 1) { throw "Missing Windows 11 acceptance" }
$records | Format-Table windowsVersion, windowsBuild, testedAt, tester, result -AutoSize
```

Record the final ZIP SHA-256 and the two acceptance records with the candidate commit. Confirm the extracted executable’s Authenticode state is `NotSigned` on both VMs. Do not accept an artifact that is signed, has a different hash, has fewer or more than two records, or contains a failed record.

## External acceptance evidence

Keep `.release.json` limited to its exact machine schema: it has no evidence-reference field. Store the human evidence outside the release set at `\\release-evidence.corp.example\opencode-pilot\<zip-sha256>\<git-commit>\windows-acceptance.md`. For the current release, derive the exact location as follows:

```powershell
$evidenceRoot = "\\release-evidence.corp.example\opencode-pilot"
$evidenceDirectory = Join-Path $evidenceRoot "$actualHash\$($metadata.gitCommit)"
$evidenceFile = Join-Path $evidenceDirectory "windows-acceptance.md"
$evidenceFile
```

The external file must identify the artifact, ZIP SHA-256, git commit, and release-metadata filename, then retain separate Windows 10 and Windows 11 sections. Each section must copy the corresponding fixed-schema record values (`windowsVersion`, `windowsBuild`, `testedAt`, `tester`, and `result`) and cite the checksum output, smoke transcript, network/egress capture, and completed manual checklist. Do not put credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence file.

Complete every item on both VMs and retain its reference in that external evidence file. The automated smoke appends only its exact structured record to `.release.json`.

- [ ] The Company guide and its configured version display in the application.
- [ ] A credential is saved, the application is restarted, and the credential remains available through DPAPI-backed enterprise AppData.
- [ ] A basic response completes, streaming is visible, and tool-call diagnostics work against the configured allowed LLM origin, `llm.corp.example`.
- [ ] A project override to a second, non-allowed internal origin is rejected before connection. Evidence shows no probe or TCP destination for that origin.
- [ ] A project override to a public provider origin is rejected before connection. Evidence shows no probe or TCP destination for that origin.
- [ ] Network evidence covers startup, idle, setup, chat, and shutdown and shows no public OpenCode traffic. Destinations are limited to the configured allowed host and exact loopback; retain the smoke output and destination capture externally.
- [ ] TLS uses the normal Windows trust store and there is no TLS/certificate-bypass option or launch flag.
- [ ] Replacing the extracted application folder preserves settings and credentials under `%LOCALAPPDATA%\com.company.opencode.pilot`.
- [ ] Deleting the extracted application folder preserves enterprise AppData and the selected project directory.
- [ ] The ZIP and checksum survive an internal-distribution transfer and still match the trusted SHA-256 record.

## Failure handling and rollback

Stop the release flow at the first failed build, verifier, checksum, metadata, parser, smoke, egress, or manual-checklist result. Preserve non-secret diagnostics, process/network evidence, artifact names, hashes, commit ID, VM OS/build, and timestamps in the external evidence location for investigation. Never include credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence.

Do not distribute a partial set, edit a checksum or release JSON to force a match, manually add acceptance records, or rerun smoke against a different ZIP under the same metadata. A smoke failure leaves the previous acceptance records intact; investigate from a new clean extraction and create a fresh release set if the ZIP changes.

To roll back, distribute the last accepted complete ZIP/checksum/metadata set through the trusted internal channel, verify its hash and metadata compatibility before extraction, and replace only the extracted application folder. Do not delete `%LOCALAPPDATA%\com.company.opencode.pilot` or project directories during rollback. Settings and DPAPI-protected credentials must remain available after replacement and after deleting an extracted folder.

## Candidate tag and review

After the two passing records, create one immutable review package from the portable design base through the accepted release commit. A fresh reviewer must inspect package identity, archive verification, checksum and metadata safety, PowerShell destructive boundaries, public egress evidence, and both Windows records. Only after that approval and a clean worktree may the release owner create the annotated candidate tag:

```powershell
git tag -a enterprise-portable-pilot-v1 -m "Company OpenCode portable enterprise pilot v1"
```

The tag must point to the exact commit recorded for both Windows acceptance records.
