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

Set-Location ..\desktop
bun test scripts/verify-enterprise-package.test.ts scripts/enterprise-release.test.ts scripts/windows-portable-smoke.test.ts
bun test
bun typecheck
bun run test:e2e -- e2e/company-llm-enterprise.spec.ts
```

The focused desktop command is the package-fixture check; it exercises the unpacked/ZIP contract, integrity metadata, and PowerShell smoke contract. The full desktop test command is required as the integrated source check. The Playwright command requires the local listener available to the test runner; run it outside a local-listener sandbox when required. If the non-CI full app suite is also run, record the known Arabic locale parity failure separately and do not classify it as a portable-package regression.

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

Run the following strict host, ZIP, checksum, and metadata compatibility check. It refuses a non-Windows x64 host, mismatched artifact names, a malformed checksum record, metadata for another target or archive, a ZIP hash mismatch, or a release that already claims acceptance. It deliberately does not print secrets because release metadata must not contain any.

```powershell
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::Is64BitProcess -eq $false) {
  throw "Portable release verification requires a Windows x64 host"
}
if ((Get-CimInstance Win32_OperatingSystem).Caption -notmatch "Windows") {
  throw "Portable release verification requires Windows"
}
if ($archive.Name -notmatch '^company-opencode-pilot-[^-]+-win-x64\.zip$') {
  throw "Unexpected portable ZIP name"
}
$checksumRecord = (Get-Content -Raw -LiteralPath $checksum).Trim()
if ($checksumRecord -notmatch '^([a-f0-9]{64})  (company-opencode-pilot-[^-]+-win-x64\.zip)$') {
  throw "Checksum file has an invalid portable release format"
}
if ($Matches[2] -ne $archive.Name) { throw "Checksum archive name mismatch" }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive.FullName).Hash.ToLowerInvariant()
if ($actualHash -ne $Matches[1]) { throw "ZIP checksum mismatch" }
$metadata = Get-Content -Raw -LiteralPath $releaseMetadata | ConvertFrom-Json
if ($metadata.schemaVersion -ne 1 -or $metadata.artifact -ne $archive.Name -or $metadata.sha256 -ne $actualHash) {
  throw "Release metadata does not describe this ZIP"
}
if ($metadata.target.os -ne "win32" -or $metadata.target.arch -ne "x64" -or $metadata.authenticode -ne "NotSigned") {
  throw "Release metadata target or unsigned status is incompatible"
}
if ($metadata.windowsAcceptance -isnot [System.Array] -or $metadata.windowsAcceptance.Count -ne 0) {
  throw "Build artifact must begin with no Windows acceptance records"
}
```

Keep the resulting ZIP, checksum, and JSON immutable as a release set. The smoke script changes only the JSON by appending acceptance records; it never changes the ZIP or checksum.

## Internal distribution

Deliver the ZIP, `.sha256`, and `.release.json` through the approved trusted internal channel as one release set. Do not publish the unsigned ZIP to a public channel and do not rely on SmartScreen reputation as an integrity mechanism. Record the internal channel, sender, recipient, transfer time, and the SHA-256 value in the release record.

On each receiving VM, run the same checksum and metadata compatibility check above before extraction. Confirm the transferred ZIP hash matches the trusted internal release record and the checksum file. A transfer that changes the ZIP, checksum, or JSON is a failed release transfer: quarantine the entire received set and obtain a new copy from the controlled build output.

## Windows 10 and Windows 11 acceptance

Use two clean x64 VMs: one Windows 10 and one Windows 11. Block public internet before launching the pilot, while allowing DNS and the configured internal LLM endpoint. The endpoint must be trusted by the normal Windows trust store. Run the parser and package-fixture commands above on each VM before the smoke command.

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

## Manual acceptance record

Complete every item on both VMs and add the evidence reference, tester, timestamp, VM OS/build, and result to the release record. The automated smoke appends only the structured Windows record; this checklist supplies the human evidence.

- [ ] The Company guide and its configured version display in the application.
- [ ] A credential is saved, the application is restarted, and the credential remains available through DPAPI-backed enterprise AppData.
- [ ] A basic response completes, streaming is visible, and tool-call diagnostics work against the approved internal model.
- [ ] A project override to a second approved internal origin succeeds.
- [ ] A project override to a public provider origin is rejected.
- [ ] Network evidence covers startup, idle, setup, chat, and shutdown and shows no public OpenCode traffic. Retain the smoke output and the destination evidence.
- [ ] TLS uses the normal Windows trust store and there is no TLS/certificate-bypass option or launch flag.
- [ ] Replacing the extracted application folder preserves settings and credentials under `%LOCALAPPDATA%\com.company.opencode.pilot`.
- [ ] Deleting the extracted application folder preserves enterprise AppData and the selected project directory.
- [ ] The ZIP and checksum survive an internal-distribution transfer and still match the trusted SHA-256 record.

## Failure handling and rollback

Stop the release flow at the first failed build, verifier, checksum, metadata, parser, smoke, egress, or manual-checklist result. Preserve non-secret diagnostics, process/network evidence, artifact names, hashes, commit ID, VM OS/build, and timestamps for investigation. Never include credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence.

Do not distribute a partial set, edit a checksum or release JSON to force a match, manually add acceptance records, or rerun smoke against a different ZIP under the same metadata. A smoke failure leaves the previous acceptance records intact; investigate from a new clean extraction and create a fresh release set if the ZIP changes.

To roll back, distribute the last accepted complete ZIP/checksum/metadata set through the trusted internal channel, verify its hash and metadata compatibility before extraction, and replace only the extracted application folder. Do not delete `%LOCALAPPDATA%\com.company.opencode.pilot` or project directories during rollback. Settings and DPAPI-protected credentials must remain available after replacement and after deleting an extracted folder.

## Candidate tag and review

After the two passing records, create one immutable review package from the portable design base through the accepted release commit. A fresh reviewer must inspect package identity, archive verification, checksum and metadata safety, PowerShell destructive boundaries, public egress evidence, and both Windows records. Only after that approval and a clean worktree may the release owner create the annotated candidate tag:

```powershell
git tag -a enterprise-portable-pilot-v1 -m "Company OpenCode portable enterprise pilot v1"
```

The tag must point to the exact commit recorded for both Windows acceptance records.
