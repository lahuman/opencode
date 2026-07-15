# Company OpenCode Pilot: Windows Portable ZIP Release

This runbook is the only supported operator path from a reviewed source revision to Windows acceptance for the Company OpenCode Pilot portable release. It produces an unsigned Windows x64 ZIP and its integrity artifacts; it does not install the application, register a protocol, or remove user data.

## Release boundary

Use a controlled Windows x64 build machine and a reviewed, clean checkout of the exact commit to release. The build account needs Bun, the repository dependencies, Git, PowerShell 5.1 or later, and normal access to the approved internal LLM endpoints. The build machine and both acceptance VMs must trust both endpoints through the normal Windows trust store. Do not add a TLS bypass, install a private certificate as a workaround for this pilot, or use `--ignore-certificate-errors`.

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
$env:OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = "https://llm.corp.example,https://llm-dr.corp.example"
$env:OPENCODE_ENTERPRISE_DEFAULTS_VERSION = "pilot-1"
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION = "pilot-1"

Set-Location packages\desktop
bun test
bun typecheck
bun run package:enterprise:win
```

### Controlled release acceptance profile

Use this exact non-secret profile for the candidate build and both Windows acceptance VMs:

- Primary origin: `https://llm.corp.example`
- Second approved internal origin: `https://llm-dr.corp.example`
- Default base URL: `https://llm.corp.example/v1`
- Default model: `company-llm/company-code`

The base URL and default model remain primary. The second origin exists only to accept a project-level override to another approved internal OpenAI-compatible origin. `OPENCODE_ENTERPRISE_ALLOWED_ORIGINS` is a comma-separated list of absolute HTTP(S) origins; it must include the primary base-URL origin and may include the second origin, but must not include a path, credential, query, fragment, public provider, or acceptance-only substitute. Preserve these exact values with the external evidence for the candidate. They are part of the immutable packaged acceptance profile: do not alter them on an acceptance VM or rebuild/repackage only one component to change an endpoint. A profile change requires a fresh clean build, ZIP/checksum/release JSON set, and full Windows acceptance.

Both approved endpoints must validate through the normal Windows trust store. The second origin does not authorize a certificate exception, relaxed TLS validation, or any change to the release gates.

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

function Assert-ReleaseMetadataMatchesPristine {
  param(
    [PSCustomObject] $Metadata,
    [PSCustomObject] $Pristine
  )

  if ($Pristine.windowsAcceptance.Count -ne 0) { throw "Pristine release metadata is not pristine" }
  foreach ($field in @(
    "schemaVersion", "appVersion", "gitCommit", "artifact", "sha256", "defaultsVersion", "guideVersion", "modelID",
    "builtAt", "authenticode"
  )) {
    if ($Metadata.$field -ne $Pristine.$field) { throw "Release metadata immutable field mismatch: $field" }
  }
  if ($Metadata.target.os -ne $Pristine.target.os -or $Metadata.target.arch -ne $Pristine.target.arch) {
    throw "Release metadata immutable target mismatch"
  }
}

function Assert-ExpectedWindowsAcceptance {
  param(
    [PSCustomObject] $Record,
    [string] $ExpectedWindows
  )

  Assert-WindowsAcceptanceRecords -Records @($Record)
  if ($Record.windowsVersion -notmatch [regex]::Escape($ExpectedWindows)) {
    throw "Windows acceptance OS identity mismatch"
  }
  if ($Record.result -ne "pass") { throw "Windows acceptance result mismatch" }
}

function Assert-ExactWindowsAcceptanceRecord {
  param(
    [PSCustomObject] $Actual,
    [PSCustomObject] $Expected
  )

  Assert-WindowsAcceptanceRecords -Records @($Actual, $Expected)
  foreach ($field in @("windowsVersion", "windowsBuild", "testedAt", "tester", "result")) {
    if ($Actual.$field -cne $Expected.$field) { throw "Windows acceptance record mismatch: $field" }
  }
}

function Read-VerifiedWindows10Control {
  param(
    [string] $Path,
    [PSCustomObject] $Pristine
  )

  $metadata = Read-VerifiedPortableReleaseMetadata -Path $Path
  Assert-ReleaseMetadataMatchesPristine -Metadata $metadata -Pristine $Pristine
  if ($metadata.windowsAcceptance.Count -ne 1) { throw "Windows 10 control must contain exactly one record" }
  Assert-ExpectedWindowsAcceptance -Record $metadata.windowsAcceptance[0] -ExpectedWindows "Windows 10"
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

### Preserve the pristine metadata baseline

The three release artifacts remain the ZIP, checksum, and release JSON. Preserve this additional read-only acceptance-control copy on the build host and transfer it with the acceptance materials; it is evidence, not a fourth release artifact. It lets Windows 11 and the final gate prove that every immutable metadata value still matches the original build JSON.

```powershell
$evidenceRoot = "\\release-evidence.corp.example\opencode-pilot"
$evidenceDirectory = Join-Path $evidenceRoot "$actualHash\$expectedCommit"
$pristineReleaseMetadata = Join-Path $evidenceDirectory "release.pristine.json"
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
if (Test-Path -LiteralPath $pristineReleaseMetadata) { throw "Pristine release metadata already exists" }
Copy-Item -LiteralPath $releaseMetadata -Destination $pristineReleaseMetadata
$pristineMetadata = Read-VerifiedPortableReleaseMetadata -Path $pristineReleaseMetadata
if ($pristineMetadata.windowsAcceptance.Count -ne 0) { throw "Pristine release metadata is not empty" }
Get-FileHash -Algorithm SHA256 -LiteralPath $pristineReleaseMetadata |
  Format-Table Algorithm, Hash, Path -AutoSize |
  Out-File -LiteralPath (Join-Path $evidenceDirectory "release.pristine.json.sha256.txt")
```

`EnterpriseReleaseMetadata` has these actual immutable values: `schemaVersion`, `appVersion`, `gitCommit`, `artifact`, `sha256`, `defaultsVersion`, `guideVersion`, `modelID`, `target`, `builtAt`, and `authenticode`. It does not contain `size` or `modelName`; do not invent fields or add them to `.release.json`. The ZIP and checksum remain immutable throughout acceptance. The only allowed release-JSON mutation is the smoke script appending valid fixed-schema Windows acceptance records.

## Acceptance-transfer validation

Deliver the ZIP, `.sha256`, and `.release.json` through the approved trusted internal channel as one release set. Do not publish the unsigned ZIP to a public channel and do not rely on SmartScreen reputation as an integrity mechanism. Record the internal channel, sender, recipient, transfer time, and the SHA-256 value in the release record.

On Windows 10, run the shared identity helper followed by the pristine build-host validation before smoke. On Windows 11, run the shared identity helper but do not run the pristine assertion: it would reject the valid Windows 10 record that the smoke script needs to preserve. Instead, after the Windows 10 smoke and control capture below, run the Windows 11 transfer validation. It verifies the same archive checksum, artifact name, and reviewed git commit, permits exactly one exact valid Windows 10 record, and rejects any other metadata shape or acceptance state.

## Windows 10 and Windows 11 acceptance

Use two clean x64 VMs: one Windows 10 and one Windows 11. Block public internet before launching the pilot, while allowing DNS and both configured internal LLM endpoints. Both endpoints must be trusted by the normal Windows trust store. Run the parser and package-fixture commands above on each VM before the smoke command. Use the controlled release acceptance profile above unchanged; its second approved origin is required for the project-override acceptance case.

Run the smoke on Windows 10 first. Copy the updated release JSON, not a newly generated JSON, to the Windows 11 VM before its run so the second successful execution appends the second record. Use the version selected above; this example shows version `1.17.18`.

```powershell
bun run smoke:enterprise:portable -- `
  -Archive .\dist\company-opencode-pilot-1.17.18-win-x64.zip `
  -Checksum .\dist\company-opencode-pilot-1.17.18-win-x64.zip.sha256 `
  -ReleaseMetadata .\dist\company-opencode-pilot-1.17.18-win-x64.release.json `
  -AllowedHost llm.corp.example `
  -SentinelProject "$env:USERPROFILE\CompanyOpenCodePilotSentinel"
```

The `smoke:enterprise:portable` wrapper uses PowerShell execution-policy scope only to run the local reviewed script. It is not a TLS or certificate bypass. Run this automated startup smoke against the default primary host, `llm.corp.example`; the second-origin override is exercised by the retained manual egress workflow below. The smoke validates the ZIP hash before extraction, requires `Get-AuthenticodeSignature` to report `NotSigned`, tracks the process tree's established TCP destinations through startup and shutdown, permits only the resolved primary host plus exact loopback, validates AppData persistence across folder replacement, preserves the sentinel project, removes only its temporary extraction directory, and then appends a passing record atomically.

### Preserve the Windows 10 acceptance control

Immediately after the Windows 10 smoke succeeds, preserve the exact accepted record before transfer:

```powershell
$pristineReleaseMetadata = Join-Path $evidenceDirectory "release.pristine.json"
$windows10ReleaseMetadata = Join-Path $evidenceDirectory "release.windows10.json"
if (Test-Path -LiteralPath $windows10ReleaseMetadata) { throw "Windows 10 release metadata already exists" }
Copy-Item -LiteralPath $releaseMetadata -Destination $windows10ReleaseMetadata
$pristineMetadata = Read-VerifiedPortableReleaseMetadata -Path $pristineReleaseMetadata
$windows10Metadata = Read-VerifiedWindows10Control -Path $windows10ReleaseMetadata -Pristine $pristineMetadata
```

Transfer the Windows 10-updated `.release.json`, the unchanged ZIP and `.sha256`, and the read-only `release.pristine.json` and `release.windows10.json` control copies to Windows 11. The transfer is invalid if any immutable metadata field, ZIP SHA-256, artifact name, or git commit differs from the reviewed build values. A transfer that changes the ZIP or checksum is always a failure; a transfer that changes the release JSON outside its single exact valid Windows 10 record is also a failure. Quarantine a failed set and obtain a fresh copy from the controlled build output.

### Windows 11 transfer validation

```powershell
# Run the shared identity helper above in the clean checkout at the reviewed build commit.
$evidenceRoot = "\\release-evidence.corp.example\opencode-pilot"
$evidenceDirectory = Join-Path $evidenceRoot "$actualHash\$expectedCommit"
$pristineReleaseMetadata = Join-Path $evidenceDirectory "release.pristine.json"
$windows10ReleaseMetadata = Join-Path $evidenceDirectory "release.windows10.json"
$pristineMetadata = Read-VerifiedPortableReleaseMetadata -Path $pristineReleaseMetadata
$windows10Metadata = Read-VerifiedWindows10Control -Path $windows10ReleaseMetadata -Pristine $pristineMetadata
$metadata = Read-VerifiedPortableReleaseMetadata -Path $releaseMetadata
Assert-ReleaseMetadataMatchesPristine -Metadata $metadata -Pristine $pristineMetadata
if ($metadata.windowsAcceptance.Count -ne 1) { throw "Windows 11 requires exactly one Windows 10 acceptance record" }
$windows10 = $metadata.windowsAcceptance[0]
Assert-ExpectedWindowsAcceptance -Record $windows10 -ExpectedWindows "Windows 10"
Assert-ExactWindowsAcceptanceRecord -Actual $windows10 -Expected $windows10Metadata.windowsAcceptance[0]
```

### Return the Windows 11 result through the trusted channel

After the Windows 11 instance of the smoke command succeeds, return only its updated `.release.json` to the controlled release host through the trusted internal channel. The source and destination names below are deliberately different: the final gate accepts only the returned destination file, never the Windows 11 local source file.

```powershell
# Run on the Windows 11 VM after its smoke command completes.
$windows11SourceReleaseMetadata = $releaseMetadata
$pristineMetadata = Read-VerifiedPortableReleaseMetadata -Path $pristineReleaseMetadata
$windows10Metadata = Read-VerifiedWindows10Control -Path $windows10ReleaseMetadata -Pristine $pristineMetadata
$windows11SourceMetadata = Read-VerifiedPortableReleaseMetadata -Path $windows11SourceReleaseMetadata
Assert-ReleaseMetadataMatchesPristine -Metadata $windows11SourceMetadata -Pristine $pristineMetadata
if ($windows11SourceMetadata.windowsAcceptance.Count -ne 2) { throw "Windows 11 return must contain exactly two records" }
Assert-ExpectedWindowsAcceptance -Record $windows11SourceMetadata.windowsAcceptance[0] -ExpectedWindows "Windows 10"
Assert-ExactWindowsAcceptanceRecord -Actual $windows11SourceMetadata.windowsAcceptance[0] -Expected $windows10Metadata.windowsAcceptance[0]
Assert-ExpectedWindowsAcceptance -Record $windows11SourceMetadata.windowsAcceptance[1] -ExpectedWindows "Windows 11"
$windows11SourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $windows11SourceReleaseMetadata).Hash.ToLowerInvariant()
$trustedReturnRoot = "\\release-transfer.corp.example\opencode-pilot"
$windows11ReturnDirectory = Join-Path $trustedReturnRoot "$actualHash\$expectedCommit"
$returnedReleaseMetadata = Join-Path $windows11ReturnDirectory "$($archive.BaseName).release.windows11-return.json"
$returnedReleaseChecksum = "$returnedReleaseMetadata.sha256"
New-Item -ItemType Directory -Path $windows11ReturnDirectory -Force | Out-Null
if (Test-Path -LiteralPath $returnedReleaseMetadata) { throw "Windows 11 return metadata already exists" }
Copy-Item -LiteralPath $windows11SourceReleaseMetadata -Destination $returnedReleaseMetadata
Set-Content -LiteralPath $returnedReleaseChecksum -Value "$windows11SourceHash  $([System.IO.Path]::GetFileName($returnedReleaseMetadata))" -NoNewline
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $returnedReleaseMetadata).Hash.ToLowerInvariant() -ne $windows11SourceHash) {
  throw "Windows 11 return metadata hash mismatch"
}
```

On the controlled release host, retrieve `\\release-transfer.corp.example\opencode-pilot\<zip-sha256>\<git-commit>\company-opencode-pilot-<version>-win-x64.release.windows11-return.json` and its adjacent `.sha256` through that same channel. The final gate below verifies the returned-file hash, then validates its artifact ZIP SHA-256 and git commit through `Read-VerifiedPortableReleaseMetadata` before accepting it.

## Final distribution gate

After Windows 11 succeeds, run the shared identity helper again against the ZIP, then run this final gate on the controlled release host. It revalidates the final JSON and the pristine baseline with the same helper used at transfer time, verifies the exact two acceptance shapes and OS families, and independently records the unsigned executable state before distribution.

```powershell
$evidenceRoot = "\\release-evidence.corp.example\opencode-pilot"
$evidenceDirectory = Join-Path $evidenceRoot "$actualHash\$expectedCommit"
$pristineReleaseMetadata = Join-Path $evidenceDirectory "release.pristine.json"
$windows10ReleaseMetadata = Join-Path $evidenceDirectory "release.windows10.json"
$trustedReturnRoot = "\\release-transfer.corp.example\opencode-pilot"
$windows11ReturnDirectory = Join-Path $trustedReturnRoot "$actualHash\$expectedCommit"
$returnedReleaseMetadata = Join-Path $windows11ReturnDirectory "$($archive.BaseName).release.windows11-return.json"
$returnedReleaseChecksum = "$returnedReleaseMetadata.sha256"
if (-not (Test-Path -LiteralPath $returnedReleaseMetadata -PathType Leaf)) { throw "Windows 11 return metadata is missing" }
if (-not (Test-Path -LiteralPath $returnedReleaseChecksum -PathType Leaf)) { throw "Windows 11 return checksum is missing" }
$returnedChecksumRecord = (Get-Content -Raw -LiteralPath $returnedReleaseChecksum).Trim()
if ($returnedChecksumRecord -notmatch '^([a-f0-9]{64})  (company-opencode-pilot-.+-win-x64\.release\.windows11-return\.json)$') {
  throw "Windows 11 return checksum format is invalid"
}
$expectedReturnedHash = $Matches[1]
$returnedArtifact = $Matches[2]
if ($returnedArtifact -ne [System.IO.Path]::GetFileName($returnedReleaseMetadata)) { throw "Windows 11 return checksum name mismatch" }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $returnedReleaseMetadata).Hash.ToLowerInvariant() -ne $expectedReturnedHash) {
  throw "Windows 11 return checksum mismatch"
}
$pristineMetadata = Read-VerifiedPortableReleaseMetadata -Path $pristineReleaseMetadata
$windows10Metadata = Read-VerifiedWindows10Control -Path $windows10ReleaseMetadata -Pristine $pristineMetadata
$metadata = Read-VerifiedPortableReleaseMetadata -Path $returnedReleaseMetadata
Assert-ReleaseMetadataMatchesPristine -Metadata $metadata -Pristine $pristineMetadata
if ($metadata.windowsAcceptance.Count -ne 2) { throw "Expected exactly two Windows acceptance records" }
Assert-ExpectedWindowsAcceptance -Record $metadata.windowsAcceptance[0] -ExpectedWindows "Windows 10"
Assert-ExactWindowsAcceptanceRecord -Actual $metadata.windowsAcceptance[0] -Expected $windows10Metadata.windowsAcceptance[0]
Assert-ExpectedWindowsAcceptance -Record $metadata.windowsAcceptance[1] -ExpectedWindows "Windows 11"

$signatureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "opencode-portable-signature-$([Guid]::NewGuid().ToString('N'))"
try {
  Expand-Archive -LiteralPath $archive.FullName -DestinationPath $signatureRoot
  $executables = @(Get-ChildItem -LiteralPath $signatureRoot -Recurse -File -Filter "Company OpenCode Pilot.exe")
  if ($executables.Count -ne 1) { throw "Portable archive must contain exactly one executable" }
  $signature = Get-AuthenticodeSignature -FilePath $executables[0].FullName
  $signature | Select-Object Path, Status, StatusMessage |
    Format-List |
    Out-File -LiteralPath (Join-Path $evidenceDirectory "authenticode-final.txt")
  if ($signature.Status -ne "NotSigned") { throw "Portable executable must remain unsigned" }
} finally {
  if (Test-Path -LiteralPath $signatureRoot) { Remove-Item -LiteralPath $signatureRoot -Recurse -Force }
}
$metadata.windowsAcceptance | Format-Table windowsVersion, windowsBuild, testedAt, tester, result -AutoSize
```

Do not distribute or tag the release until this gate passes. Record the final ZIP SHA-256, the two acceptance records, and `authenticode-final.txt` in the external evidence folder. Do not accept an artifact that is signed, has a changed immutable field, has fewer or more than two records, or contains a failed record.

## External acceptance evidence

Keep `.release.json` limited to its exact machine schema: it has no evidence-reference field. Store the human evidence outside the release set at `\\release-evidence.corp.example\opencode-pilot\<zip-sha256>\<git-commit>\windows-acceptance.md`. For the current release, derive the exact location as follows:

```powershell
$evidenceFile = Join-Path $evidenceDirectory "windows-acceptance.md"
$evidenceFile
```

The external file must identify the artifact, ZIP SHA-256, git commit, release-metadata filename, `release.pristine.json` control-copy hash, and the controlled acceptance profile's primary origin, second approved origin, default base URL, and default model. It must then retain separate Windows 10 and Windows 11 sections. Each section must copy the corresponding fixed-schema record values (`windowsVersion`, `windowsBuild`, `testedAt`, `tester`, and `result`) and cite the checksum output, smoke transcript, retained egress trace, and completed manual checklist. Do not put credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence file.

### Retained egress evidence

The smoke script is an automated fail-closed process-tree polling check for its own launch sequence. It does not perform the operator's credential setup or chat workflow, and it does not retain a chat trace. On each VM, run the following built-in Windows capture from an elevated PowerShell session for the complete manual workflow. Start it before launching the pilot and stop it only after the pilot has shut down.

```powershell
$vmEvidenceDirectory = Join-Path $evidenceDirectory "windows-10-egress"
New-Item -ItemType Directory -Path $vmEvidenceDirectory -Force | Out-Null
$traceFile = Join-Path $vmEvidenceDirectory "manual-workflow.etl"
$stepsFile = Join-Path $vmEvidenceDirectory "operator-steps.txt"
function Add-EgressEvidenceStep {
  param([string] $Step)
  "$([DateTime]::UtcNow.ToString('o'))`t$Step" | Add-Content -LiteralPath $stepsFile
}

Add-EgressEvidenceStep "Trace requested before pilot launch"
& netsh trace start capture=yes scenario=InternetClient tracefile="$traceFile" filemode=single maxsize=512 report=no persistent=no |
  Tee-Object -FilePath (Join-Path $vmEvidenceDirectory "netsh-trace-start.txt")
if ($LASTEXITCODE -ne 0) { throw "Unable to start retained egress trace" }
Add-EgressEvidenceStep "Trace started; launch pilot now"
Read-Host "Launch the pilot and press Enter after startup completes" | Out-Null
Add-EgressEvidenceStep "Startup complete"
Read-Host "Leave the pilot idle for 60 seconds and press Enter when complete" | Out-Null
Add-EgressEvidenceStep "Idle observation complete"
Read-Host "Complete credential setup and save, then press Enter" | Out-Null
Add-EgressEvidenceStep "Credential setup and save complete"
Read-Host "Complete one basic streamed chat and tool-call diagnostic, then press Enter" | Out-Null
Add-EgressEvidenceStep "Basic streamed chat and tool-call diagnostic complete"
Read-Host "In a fresh project, complete the approved second-origin override response, then press Enter" | Out-Null
Add-EgressEvidenceStep "Approved second-origin project override response complete"
Read-Host "In separate fresh projects, verify the non-allowed internal and public-provider overrides are rejected before connection, then press Enter" | Out-Null
Add-EgressEvidenceStep "Non-allowed internal and public-provider project overrides rejected before connection"
Read-Host "Shut down the pilot normally and press Enter only after it exits" | Out-Null
Add-EgressEvidenceStep "Pilot shutdown complete; stopping trace"
& netsh trace stop | Tee-Object -FilePath (Join-Path $vmEvidenceDirectory "netsh-trace-stop.txt")
if ($LASTEXITCODE -ne 0) { throw "Unable to stop retained egress trace" }
& tracerpt $traceFile -o (Join-Path $vmEvidenceDirectory "manual-workflow-events.xml") -of XML
if ($LASTEXITCODE -ne 0) { throw "Unable to write retained XML event dump" }
Get-ChildItem -LiteralPath $vmEvidenceDirectory -File |
  Get-FileHash -Algorithm SHA256 |
  Sort-Object Path |
  Format-Table Algorithm, Hash, Path -AutoSize |
  Out-File -LiteralPath (Join-Path $vmEvidenceDirectory "sha256.txt")
```

Use `windows-11-egress` instead of `windows-10-egress` on the Windows 11 VM. The operator must retain the ETL, XML event dump, `netsh-trace-start.txt`, `netsh-trace-stop.txt`, timestamps, step log, and hashes in the SHA-256/git-commit evidence directory. Review the trace/XML event dump and the smoke output together. The primary origin is expected for the default chat; the second approved origin is expected only for the successful project override. There must be no DNS probe or TCP destination for `llm-unapproved.corp.example` or `api.openai.com`. Any endpoint outside the two configured allowed origins, required DNS, exact loopback, or separately approved enterprise infrastructure is a release blocker until the release owner and security reviewer document approval in `windows-acceptance.md`.

For each override case, use a separate fresh project so an invalid project file cannot affect the successful case. In that project's `.opencode\opencode.json`, write only the non-secret provider override shown below; do not put credentials, API keys, authorization headers, or TLS settings in the project file. Open the project in the pilot after writing the file. For the allowed case, complete the same basic streamed response used above. For each rejected case, confirm the provider is not available for the attempted request and record the matching trace interval; do not work around the rejection by changing environment variables, the trust store, or the packaged profile.

```json
{
  "provider": {
    "company-llm": {
      "options": {
        "baseURL": "https://llm-dr.corp.example/v1"
      }
    }
  }
}
```

Replace only the `baseURL` in that fixture for each negative case:

- Non-allowed internal origin: `https://llm-unapproved.corp.example/v1`
- Public provider origin: `https://api.openai.com/v1`

The negative origins are deliberately absent from `OPENCODE_ENTERPRISE_ALLOWED_ORIGINS`. The release evidence must show both were rejected before connection, with no DNS probe or TCP destination, while the second approved internal origin completed the response.

Complete every item on both VMs and retain its reference in that external evidence file. The automated smoke appends only its exact structured record to `.release.json`.

- [ ] The Company guide and its configured version display in the application.
- [ ] A credential is saved, the application is restarted, and the credential remains available through DPAPI-backed enterprise AppData.
- [ ] A basic response completes, streaming is visible, and tool-call diagnostics work against the configured allowed LLM origin, `llm.corp.example`.
- [ ] A project override to the second approved internal origin, `https://llm-dr.corp.example/v1`, completes a basic streamed response. Evidence identifies the override interval and its permitted destination.
- [ ] A project override to the non-allowed internal origin, `https://llm-unapproved.corp.example/v1`, is rejected before connection. Evidence shows no DNS probe or TCP destination for that origin.
- [ ] A project override to the public provider origin, `https://api.openai.com/v1`, is rejected before connection. Evidence shows no DNS probe or TCP destination for that origin.
- [ ] Network evidence covers startup, idle, setup, default chat, approved override, rejected overrides, and shutdown; it shows no public OpenCode traffic. Destinations are limited to the two configured allowed origins and exact loopback, apart from required DNS and separately approved enterprise infrastructure. Retain the smoke output and destination capture externally.
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
