# CHAI: Windows Portable ZIP Release

This runbook is the only supported operator path from a reviewed source revision to Windows acceptance for the CHAI portable release. It produces an unsigned Windows x64 ZIP and its integrity artifacts; it does not install the application, register a protocol, migrate data from the former Pilot application, or remove user data.

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
$env:OPENCODE_ENTERPRISE_MODELS = '[{"id":"company-code","name":"Company Code","baseURL":"https://llm.corp.example/v1"},{"id":"company-reasoning","name":"Company Reasoning","baseURL":"https://llm-dr.corp.example/v1"}]'
$env:OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID = "company-code"
$env:OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = ""
$env:OPENCODE_ENTERPRISE_DEFAULTS_VERSION = "pilot-1"
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION = "chai-1"
$env:OPENCODE_ENTERPRISE_CATALOG_VERSION = "pilot-1"

Set-Location packages\desktop
bun test
bun typecheck
bun run package:enterprise:win
```

### Controlled release acceptance profile

Use this exact non-secret profile for the candidate build and both Windows acceptance VMs:

- Primary origin: `https://llm.corp.example`
- Reasoning-model origin: `https://llm-dr.corp.example`
- Default model: `company-llm/company-code`

Each entry in `OPENCODE_ENTERPRISE_MODELS` has its own non-secret ID, display name, and OpenAI-compatible base URL. Model origins are allowed automatically; `OPENCODE_ENTERPRISE_ALLOWED_ORIGINS` is reserved for additional approved project-level overrides and may be empty. It must contain only comma-separated absolute HTTP(S) origins without paths, credentials, queries, or fragments. Never place API keys, authorization headers, or tokens in `.env`; enter credentials for each model in the Company LLM settings screen so Windows DPAPI encrypts them. The legacy `BASE_URL`, `MODEL_ID`, and `MODEL_NAME` variables remain accepted for one compatibility release only.

Both approved endpoints must validate through the normal Windows trust store. The second origin does not authorize a certificate exception, relaxed TLS validation, or any change to the release gates.

The supported command builds the desktop, packages only the Windows x64 ZIP target, verifies `dist\win-unpacked`, checks the archive against that unpacked tree, and writes all five release artifacts beside one another:

```text
dist\chai-<version>-win-x64.zip
dist\chai-<version>-win-x64.zip.sha256
dist\chai-<version>-win-x64.release.json
dist\chai-<version>-win-x64.sbom.cdx.json
dist\chai-<version>-win-x64.third-party-licenses.txt
```

The `.sha256` file generated by `enterprise-release.ts` has exact bytes: one lowercase 64-hex digest, two ASCII spaces, the exact artifact filename, and one LF byte (`0x0A`). CRLF, a missing LF, additional records, and any other leading or trailing whitespace are invalid.

Locate exactly one release set and retain it together:

```powershell
$archive = @(Get-ChildItem .\dist\chai-*-win-x64.zip -File)
if ($archive.Count -ne 1) { throw "Expected exactly one portable ZIP in dist" }
$archive = $archive[0]
$checksum = "$($archive.FullName).sha256"
$releaseMetadata = Join-Path $archive.DirectoryName "$($archive.BaseName).release.json"
$sbom = Join-Path $archive.DirectoryName "$($archive.BaseName).sbom.cdx.json"
$thirdPartyLicenses = Join-Path $archive.DirectoryName "$($archive.BaseName).third-party-licenses.txt"
if (-not (Test-Path -LiteralPath $checksum -PathType Leaf)) { throw "Missing ZIP checksum" }
if (-not (Test-Path -LiteralPath $releaseMetadata -PathType Leaf)) { throw "Missing release metadata" }
if (-not (Test-Path -LiteralPath $sbom -PathType Leaf)) { throw "Missing CycloneDX SBOM" }
if (-not (Test-Path -LiteralPath $thirdPartyLicenses -PathType Leaf)) { throw "Missing third-party licenses" }
$archive.FullName
$checksum
$releaseMetadata
$sbom
$thirdPartyLicenses
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
if ($archive.Name -notmatch '^chai-.+-win-x64\.zip$') {
  throw "Unexpected portable ZIP name"
}
$checksumRecord = Get-Content -Raw -LiteralPath $checksum
$escapedArchiveName = [regex]::Escape($archive.Name)
$checksumMatch = [regex]::Match($checksumRecord, "\A([a-f0-9]{64})  $escapedArchiveName\n\z")
if (-not $checksumMatch.Success) {
  throw "Checksum file has an invalid portable release format"
}
$expectedHash = $checksumMatch.Groups[1].Value
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
    "appVersion", "artifact", "authenticode", "builtAt", "defaultModelID", "defaultsVersion", "gitCommit", "guideVersion",
    "modelCatalogSHA256", "modelIDs", "sbom", "schemaVersion", "sha256", "target", "thirdPartyLicenses", "windowsAcceptance"
  ) | Sort-Object
  if ($metadata -isnot [PSCustomObject] -or (@($metadata.PSObject.Properties.Name | Sort-Object) -join ",") -ne ($expectedFields -join ",")) {
    throw "Release metadata shape is invalid"
  }
  foreach ($field in @("appVersion", "artifact", "authenticode", "builtAt", "defaultsVersion", "gitCommit", "guideVersion", "modelCatalogSHA256", "sha256")) {
    if ($metadata.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($metadata.$field)) {
      throw "Release metadata shape is invalid"
    }
  }
  if ($metadata.defaultModelID -isnot [string]) { throw "Release metadata model catalog is invalid" }
  if ($metadata.modelCatalogSHA256 -notmatch "\A[0-9a-f]{64}\z") { throw "Release metadata model catalog is invalid" }
  if ($metadata.modelIDs -isnot [System.Array]) { throw "Release metadata model catalog is invalid" }
  $modelIDs = @($metadata.modelIDs)
  if (@($modelIDs | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) { throw "Release metadata model catalog is invalid" }
  $modelIDSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  if (@($modelIDs | Where-Object { -not $modelIDSet.Add($_) }).Count -ne 0) { throw "Release metadata model catalog is invalid" }
  $sortedModelIDs = [string[]]$modelIDs.Clone()
  [Array]::Sort($sortedModelIDs, [System.StringComparer]::Ordinal)
  if (($modelIDs -join "`0") -cne ($sortedModelIDs -join "`0")) { throw "Release metadata model catalog is invalid" }
  if ($modelIDs.Count -eq 0) {
    if ($metadata.defaultModelID -cne "") { throw "Release metadata model catalog is invalid" }
  } elseif ([string]::IsNullOrWhiteSpace($metadata.defaultModelID) -or -not $modelIDSet.Contains($metadata.defaultModelID)) {
    throw "Release metadata model catalog is invalid"
  }
  if ($metadata.schemaVersion -is [string] -or $metadata.schemaVersion -is [bool] -or $metadata.schemaVersion -isnot [System.IConvertible]) {
    throw "Release metadata schema version is invalid"
  }
  try {
    $schemaVersion = [decimal]$metadata.schemaVersion
  } catch {
    throw "Release metadata schema version is invalid"
  }
  if ([decimal]::Truncate($schemaVersion) -ne $schemaVersion -or $schemaVersion -ne 3) {
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
  foreach ($supplemental in @($metadata.sbom, $metadata.thirdPartyLicenses)) {
    if (
      $supplemental -isnot [PSCustomObject] -or
      (@($supplemental.PSObject.Properties.Name | Sort-Object) -join ",") -ne "file,sha256" -or
      [System.IO.Path]::GetFileName($supplemental.file) -ne $supplemental.file
    ) { throw "Release supplemental artifact is invalid" }
    $supplementalPath = Join-Path $archive.DirectoryName $supplemental.file
    if (-not (Test-Path -LiteralPath $supplementalPath -PathType Leaf)) { throw "Release supplemental artifact is missing" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $supplementalPath).Hash.ToLowerInvariant() -ne $supplemental.sha256) {
      throw "Release supplemental artifact checksum mismatch"
    }
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
    "schemaVersion", "appVersion", "gitCommit", "artifact", "sha256", "defaultsVersion", "guideVersion", "defaultModelID", "modelCatalogSHA256",
    "builtAt", "authenticode"
  )) {
    if ($Metadata.$field -ne $Pristine.$field) { throw "Release metadata immutable field mismatch: $field" }
  }
  if (($Metadata.modelIDs | ConvertTo-Json -Compress) -cne ($Pristine.modelIDs | ConvertTo-Json -Compress)) {
    throw "Release metadata immutable field mismatch: modelIDs"
  }
  foreach ($field in @("sbom", "thirdPartyLicenses")) {
    if (($Metadata.$field | ConvertTo-Json -Compress) -cne ($Pristine.$field | ConvertTo-Json -Compress)) {
      throw "Release metadata immutable field mismatch: $field"
    }
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

The five release artifacts are the ZIP, checksum, release JSON, CycloneDX SBOM, and third-party license document. Preserve this additional read-only acceptance-control copy on the build host and transfer it with the acceptance materials; it is evidence, not a sixth release artifact. It lets Windows 11 and the final gate prove that every immutable metadata value still matches the original build JSON.

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

`EnterpriseReleaseMetadataV3` has these actual immutable values: `schemaVersion`, `appVersion`, `gitCommit`, `artifact`, `sha256`, `defaultsVersion`, `guideVersion`, `defaultModelID`, `modelIDs`, `modelCatalogSHA256`, `target`, `builtAt`, `authenticode`, `sbom`, and `thirdPartyLicenses`. It contains neither model names nor endpoint URLs or credentials. Do not invent fields or add them to `.release.json`. All five release artifacts remain immutable throughout acceptance. The only allowed release-JSON mutation is the smoke script appending valid fixed-schema Windows acceptance records.

## Acceptance-transfer validation

Deliver the ZIP, `.sha256`, `.release.json`, `.sbom.cdx.json`, and `.third-party-licenses.txt` through the approved trusted internal channel as one release set. Two assigned reviewers must independently run `Get-FileHash -Algorithm SHA256` on the ZIP, SBOM, and license document and compare their results with the checksum/release JSON before transfer and again after receipt. Record both reviewer identities, outputs, internal channel, sender, recipient, and transfer time. Do not publish the unsigned ZIP to a public channel and do not rely on SmartScreen reputation as an integrity mechanism.

On Windows 10, run the shared identity helper followed by the pristine build-host validation before smoke. On Windows 11, run the shared identity helper but do not run the pristine assertion: it would reject the valid Windows 10 record that the smoke script needs to preserve. Instead, after the Windows 10 smoke and control capture below, run the Windows 11 transfer validation. It verifies the same archive checksum, artifact name, and reviewed git commit, permits exactly one exact valid Windows 10 record, and rejects any other metadata shape or acceptance state.

## Windows 10 and Windows 11 acceptance

Use two clean x64 VMs: one Windows 10 and one Windows 11. Block public internet before launching the pilot, while allowing DNS and both configured internal LLM endpoints. Both endpoints must be trusted by the normal Windows trust store. Run the parser and package-fixture commands above on each VM before the smoke command. Use the controlled release acceptance profile above unchanged; its second approved origin is required for the project-override acceptance case.

Run the smoke on Windows 10 first. Copy the updated release JSON, not a newly generated JSON, to the Windows 11 VM before its run so the second successful execution appends the second record. Use the version selected above; this example shows version `1.17.18`.

```powershell
bun run smoke:enterprise:portable -- `
  -Archive .\dist\chai-1.17.18-win-x64.zip `
  -Checksum .\dist\chai-1.17.18-win-x64.zip.sha256 `
  -ReleaseMetadata .\dist\chai-1.17.18-win-x64.release.json `
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
$returnedArtifact = [System.IO.Path]::GetFileName($returnedReleaseMetadata)
[System.IO.File]::WriteAllText(
  $returnedReleaseChecksum,
  "$windows11SourceHash  $returnedArtifact`n",
  [System.Text.UTF8Encoding]::new($false)
)
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $returnedReleaseMetadata).Hash.ToLowerInvariant() -ne $windows11SourceHash) {
  throw "Windows 11 return metadata hash mismatch"
}
```

On the controlled release host, retrieve `\\release-transfer.corp.example\sfmi\<zip-sha256>\<git-commit>\chai-<version>-win-x64.release.windows11-return.json` and its adjacent `.sha256` through that same channel. The final gate below verifies the returned-file hash, then validates its artifact ZIP SHA-256 and git commit through `Read-VerifiedPortableReleaseMetadata` before accepting it.

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
$returnedArtifact = [System.IO.Path]::GetFileName($returnedReleaseMetadata)
$escapedReturnedArtifact = [regex]::Escape($returnedArtifact)
$returnedChecksumRecord = Get-Content -Raw -LiteralPath $returnedReleaseChecksum
$returnedChecksumMatch = [regex]::Match($returnedChecksumRecord, "\A([a-f0-9]{64})  $escapedReturnedArtifact\n\z")
if (-not $returnedChecksumMatch.Success) {
  throw "Windows 11 return checksum format is invalid"
}
$expectedReturnedHash = $returnedChecksumMatch.Groups[1].Value
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
  $executables = @(Get-ChildItem -LiteralPath $signatureRoot -Recurse -File -Filter "CHAI.exe")
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

The external file must identify the artifact, ZIP SHA-256, git commit, release-metadata filename, `release.pristine.json` control-copy hash, model IDs, model-catalog hash, approved model origins, and default model. It must then retain separate Windows 10 and Windows 11 sections. Each section must copy the corresponding fixed-schema record values (`windowsVersion`, `windowsBuild`, `testedAt`, `tester`, and `result`) and cite the checksum output, smoke transcript, retained egress trace, and completed manual checklist. Do not put credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence file.

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
- [ ] A terminal opens through the authenticated loopback PTY WebSocket, runs a local command, reconnects after a project tab switch, and closes without leaving a child process.
- [ ] A project override to the second approved internal origin, `https://llm-dr.corp.example/v1`, completes a basic streamed response. Evidence identifies the override interval and its permitted destination.
- [ ] A project override to the non-allowed internal origin, `https://llm-unapproved.corp.example/v1`, is rejected before connection. Evidence shows no DNS probe or TCP destination for that origin.
- [ ] A project override to the public provider origin, `https://api.openai.com/v1`, is rejected before connection. Evidence shows no DNS probe or TCP destination for that origin.
- [ ] Network evidence covers startup, idle, setup, default chat, approved override, rejected overrides, and shutdown; it shows no public OpenCode traffic. Destinations are limited to the two configured allowed origins and exact loopback, apart from required DNS and separately approved enterprise infrastructure. Retain the smoke output and destination capture externally.
- [ ] TLS uses the normal Windows trust store and there is no TLS/certificate-bypass option or launch flag.
- [ ] Replacing the extracted application folder preserves settings and credentials under `%LOCALAPPDATA%\com.company.sfmi`.
- [ ] `%LOCALAPPDATA%\com.company.opencode.pilot` is not read, migrated, modified, or removed.
- [ ] Deleting the extracted application folder preserves enterprise AppData and the selected project directory.
- [ ] The ZIP and checksum survive an internal-distribution transfer and still match the trusted SHA-256 record.

## Failure handling and rollback

Stop the release flow at the first failed build, verifier, checksum, metadata, parser, smoke, egress, or manual-checklist result. Preserve non-secret diagnostics, process/network evidence, artifact names, hashes, commit ID, VM OS/build, and timestamps in the external evidence location for investigation. Never include credentials, authorization headers, user settings, or full secret-bearing URLs in the evidence.

Do not distribute a partial set, edit a checksum or release JSON to force a match, manually add acceptance records, or rerun smoke against a different ZIP under the same metadata. A smoke failure leaves the previous acceptance records intact; investigate from a new clean extraction and create a fresh release set if the ZIP changes.

To roll back CHAI, distribute the last accepted complete ZIP/checksum/metadata set through the trusted internal channel, verify its hash and metadata compatibility before extraction, and replace only the extracted CHAI application folder. Do not delete `%LOCALAPPDATA%\com.company.sfmi`, `%LOCALAPPDATA%\com.company.opencode.pilot`, or project directories during rollback. CHAI settings and DPAPI-protected credentials must remain available after replacement and after deleting an extracted folder; former Pilot data remains independent and untouched.

## Candidate tag and review

After the two passing records, create one immutable review package from the portable design base through the accepted release commit. A fresh reviewer must inspect package identity, archive verification, checksum and metadata safety, PowerShell destructive boundaries, public egress evidence, and both Windows records. Only after that approval and a clean worktree may the release owner create the annotated candidate tag:

```powershell
git tag -a enterprise-portable-pilot-v1 -m "Company OpenCode portable enterprise pilot v1"
```

The tag must point to the exact commit recorded for both Windows acceptance records.
