param(
  [Parameter(Mandatory = $true)][string] $Archive,
  [Parameter(Mandatory = $true)][string] $Checksum,
  [Parameter(Mandatory = $true)][string] $ReleaseMetadata,
  [Parameter(Mandatory = $true)][string] $AllowedHost,
  [Parameter(Mandatory = $true)][string] $SentinelProject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-AllowedAddresses {
  param([string] $TargetHost)

  $addresses = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($loopback in @("127.0.0.1", "::1", "::ffff:127.0.0.1")) {
    [void]$addresses.Add($loopback)
  }

  [System.Net.IPAddress] $literalAddress = $null
  if ([System.Net.IPAddress]::TryParse($TargetHost, [ref]$literalAddress)) {
    [void]$addresses.Add($literalAddress.ToString())
    return @($addresses)
  }

  $resolved = 0
  foreach ($type in @("A", "AAAA")) {
    try {
      foreach ($record in @(Resolve-DnsName -Name $TargetHost -Type $type -DnsOnly)) {
        if ([string]::IsNullOrWhiteSpace($record.IPAddress)) { continue }
        [System.Net.IPAddress] $address = $null
        if (-not [System.Net.IPAddress]::TryParse($record.IPAddress, [ref]$address)) { continue }
        [void]$addresses.Add($address.ToString())
        $resolved++
      }
    } catch {
      if ($type -eq "A") { continue }
    }
  }

  if ($resolved -eq 0) { throw "Unable to resolve the allowed host" }
  return @($addresses)
}

function Assert-WindowsAcceptanceRecords {
  param([object[]] $Records)

  $requiredFields = @("result", "testedAt", "tester", "windowsBuild", "windowsVersion")
  foreach ($record in $Records) {
    if ($null -eq $record) { throw "Release metadata Windows acceptance is invalid" }
    $recordFields = if ($record -is [System.Collections.IDictionary]) {
      @($record.Keys | Sort-Object)
    } else {
      @($record.PSObject.Properties.Name | Sort-Object)
    }
    if (($recordFields -join ",") -ne ($requiredFields -join ",")) {
      throw "Release metadata Windows acceptance is invalid"
    }
    foreach ($field in $requiredFields) {
      $value = if ($record -is [System.Collections.IDictionary]) { $record[$field] } else { $record.$field }
      if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
        throw "Release metadata Windows acceptance is invalid"
      }
    }
    $result = if ($record -is [System.Collections.IDictionary]) { $record["result"] } else { $record.result }
    if ($result -ne "pass") { throw "Release metadata Windows acceptance is invalid" }
  }
}

function Assert-EnterpriseReleaseMetadata {
  param([object] $Metadata)

  if ($Metadata -isnot [PSCustomObject]) { throw "Release metadata shape is invalid" }

  $requiredFields = @(
    "appVersion", "artifact", "authenticode", "builtAt", "defaultModelID", "defaultsVersion", "gitCommit", "guideVersion",
    "modelCatalogSHA256", "modelIDs", "sbom", "schemaVersion", "sha256", "target", "thirdPartyLicenses", "windowsAcceptance"
  )
  $metadataFields = @($Metadata.PSObject.Properties.Name | Sort-Object)
  if (($metadataFields -join ",") -ne ($requiredFields -join ",")) { throw "Release metadata shape is invalid" }

  foreach ($field in @("appVersion", "artifact", "authenticode", "builtAt", "defaultModelID", "defaultsVersion", "gitCommit", "guideVersion", "modelCatalogSHA256", "sha256")) {
    if ($Metadata.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($Metadata.$field)) {
      throw "Release metadata shape is invalid"
    }
  }
  if ($Metadata.modelCatalogSHA256 -notmatch "\A[0-9a-f]{64}\z") { throw "Release metadata model catalog is invalid" }
  if ($Metadata.modelIDs -isnot [System.Array] -or $Metadata.modelIDs.Count -eq 0) {
    throw "Release metadata model catalog is invalid"
  }
  $modelIDs = @($Metadata.modelIDs)
  if (@($modelIDs | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) {
    throw "Release metadata model catalog is invalid"
  }
  $modelIDSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  if (@($modelIDs | Where-Object { -not $modelIDSet.Add($_) }).Count -ne 0) {
    throw "Release metadata model catalog is invalid"
  }
  $sortedModelIDs = [string[]]$modelIDs.Clone()
  [Array]::Sort($sortedModelIDs, [System.StringComparer]::Ordinal)
  if (($modelIDs -join "`0") -cne ($sortedModelIDs -join "`0")) { throw "Release metadata model catalog is invalid" }
  if (-not $modelIDSet.Contains($Metadata.defaultModelID)) { throw "Release metadata model catalog is invalid" }

  $schemaVersion = $Metadata.schemaVersion
  if ($null -eq $schemaVersion -or $schemaVersion -is [string] -or $schemaVersion -is [bool] -or $schemaVersion -isnot [System.IConvertible]) {
    throw "Release metadata schema version is invalid"
  }
  try {
    $numericSchemaVersion = [decimal]$schemaVersion
  } catch {
    throw "Release metadata schema version is invalid"
  }
  if ([decimal]::Truncate($numericSchemaVersion) -ne $numericSchemaVersion -or $numericSchemaVersion -ne 3) {
    throw "Release metadata schema version is invalid"
  }

  if ($Metadata.target -isnot [PSCustomObject]) { throw "Release metadata target mismatch" }
  $targetFields = @($Metadata.target.PSObject.Properties.Name | Sort-Object)
  if (($targetFields -join ",") -ne "arch,os") { throw "Release metadata target mismatch" }
  foreach ($field in @("arch", "os")) {
    if ($Metadata.target.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($Metadata.target.$field)) {
      throw "Release metadata target mismatch"
    }
  }

  if ($Metadata.windowsAcceptance -isnot [System.Array]) { throw "Release metadata Windows acceptance is invalid" }
  Assert-WindowsAcceptanceRecords -Records ([object[]]$Metadata.windowsAcceptance)

  foreach ($artifact in @($Metadata.sbom, $Metadata.thirdPartyLicenses)) {
    if ($artifact -isnot [PSCustomObject]) { throw "Release supplemental artifact is invalid" }
    $artifactFields = @($artifact.PSObject.Properties.Name | Sort-Object)
    if (($artifactFields -join ",") -ne "file,sha256") { throw "Release supplemental artifact is invalid" }
    if ($artifact.file -isnot [string] -or [string]::IsNullOrWhiteSpace($artifact.file)) {
      throw "Release supplemental artifact is invalid"
    }
    if ([System.IO.Path]::GetFileName($artifact.file) -ne $artifact.file) { throw "Release supplemental artifact is invalid" }
    if ($artifact.sha256 -isnot [string] -or $artifact.sha256 -notmatch "\A[0-9a-f]{64}\z") {
      throw "Release supplemental artifact is invalid"
    }
  }
}

function Assert-EnterpriseCatalogIdentity {
  param(
    [Parameter(Mandatory = $true)] [object] $Metadata,
    [Parameter(Mandatory = $true)] [string] $ApplicationDirectory
  )

  $manifestPath = Join-Path $ApplicationDirectory "resources/enterprise/enterprise-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Enterprise manifest is missing"
  }
  try {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  } catch {
    throw "Enterprise manifest is invalid"
  }
  if ($manifest -isnot [PSCustomObject] -or $manifest.schemaVersion -ne 2 -or $manifest.modelIDs -isnot [System.Array]) {
    throw "Enterprise manifest is invalid"
  }
  if (
    $manifest.defaultModelID -cne $Metadata.defaultModelID -or
    $manifest.modelCatalogSHA256 -cne $Metadata.modelCatalogSHA256 -or
    ($manifest.modelIDs -join "`0") -cne ($Metadata.modelIDs -join "`0")
  ) {
    throw "Release metadata model catalog mismatch"
  }
}

function Read-EnterpriseReleaseMetadata {
  param([string] $Path)

  $releaseJson = (Get-Content -Raw -LiteralPath $Path).Trim()
  $releaseJson = $releaseJson.TrimStart([char[]]@([char]0xFEFF)).Trim()
  if ($releaseJson.Length -lt 2 -or $releaseJson[0] -ne "{" -or $releaseJson[$releaseJson.Length - 1] -ne "}") {
    throw "Release metadata must be a JSON object"
  }
  $metadata = $releaseJson | ConvertFrom-Json
  if ($metadata -isnot [PSCustomObject]) { throw "Release metadata must be a JSON object" }
  return $metadata
}

function Read-PortableChecksum {
  param(
    [string] $Path,
    [string] $Archive
  )

  $archiveName = [System.IO.Path]::GetFileName($Archive)
  $escapedArchiveName = [regex]::Escape($archiveName)
  $checksumRecord = Get-Content -Raw -LiteralPath $Path
  $checksumMatch = [regex]::Match($checksumRecord, "\A([0-9a-f]{64})  $escapedArchiveName\n\z")
  if (-not $checksumMatch.Success) { throw "Portable archive checksum record is invalid" }
  return $checksumMatch.Groups[1].Value
}

function Get-ProcessCreationTime {
  param([object] $CreationDate)

  if ($CreationDate -is [DateTime]) { return $CreationDate.ToUniversalTime().ToString("o") }
  if ($CreationDate -isnot [string]) { throw "Portable process creation time is unavailable" }

  [DateTime] $parsed = [DateTime]::MinValue
  if ([DateTime]::TryParse($CreationDate, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
    return $parsed.ToUniversalTime().ToString("o")
  }
  return [System.Management.ManagementDateTimeConverter]::ToDateTime($CreationDate).ToUniversalTime().ToString("o")
}

function ConvertFrom-ProcessCreationTime {
  param([string] $CreationTime)

  [DateTime] $parsed = [DateTime]::MinValue
  if (-not [DateTime]::TryParseExact(
    $CreationTime,
    "o",
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )) {
    throw "Portable process creation identity is invalid"
  }
  return $parsed.ToUniversalTime()
}

function New-ProcessIdentity {
  param([object] $Process)

  if ($null -eq $Process -or $null -eq $Process.ProcessId -or $null -eq $Process.CreationDate) {
    throw "Portable process identity is unavailable"
  }
  return [PSCustomObject]@{
    ProcessId = [int]$Process.ProcessId
    CreationTime = Get-ProcessCreationTime -CreationDate $Process.CreationDate
  }
}

function Get-ProcessIdentityKey {
  param([PSCustomObject] $ProcessIdentity)

  return "$($ProcessIdentity.ProcessId):$($ProcessIdentity.CreationTime)"
}

function Test-ProcessIdentity {
  param(
    [PSCustomObject] $ProcessIdentity,
    [object] $Process
  )

  if ($null -eq $Process -or [int]$Process.ProcessId -ne $ProcessIdentity.ProcessId) { return $false }
  return (Get-ProcessCreationTime -CreationDate $Process.CreationDate) -eq $ProcessIdentity.CreationTime
}

function Get-CimProcess {
  param([int] $ProcessId)

  $processes = @(Get-CimInstance Win32_Process | Where-Object { [int]$_.ProcessId -eq $ProcessId })
  if ($processes.Count -eq 0) { return $null }
  if ($processes.Count -ne 1) { throw "Portable process identity is ambiguous" }
  return $processes[0]
}

function Get-ProcessIdentity {
  param([int] $ProcessId)

  $process = Get-CimProcess -ProcessId $ProcessId
  if ($null -eq $process) { return $null }
  return New-ProcessIdentity -Process $process
}

function Get-ProcessTreeIdentities {
  param([PSCustomObject[]] $RootProcessIdentities)

  $processes = @(Get-CimInstance Win32_Process)
  $identities = [System.Collections.Generic.Dictionary[string, object]]::new()
  $pending = @()
  foreach ($process in $processes) {
    if (-not @($RootProcessIdentities | Where-Object { Test-ProcessIdentity -ProcessIdentity $_ -Process $process })) { continue }
    $identity = New-ProcessIdentity -Process $process
    $key = Get-ProcessIdentityKey -ProcessIdentity $identity
    if ($identities.ContainsKey($key)) { continue }
    $identities[$key] = $identity
    $pending += $identity
  }

  while ($pending.Count -gt 0) {
    $parent = $pending[0]
    $pending = @($pending | Select-Object -Skip 1)
    foreach ($process in @($processes | Where-Object { [int]$_.ParentProcessId -eq $parent.ProcessId })) {
      $identity = New-ProcessIdentity -Process $process
      $childCreationTime = ConvertFrom-ProcessCreationTime -CreationTime $identity.CreationTime
      $parentCreationTime = ConvertFrom-ProcessCreationTime -CreationTime $parent.CreationTime
      if ($childCreationTime -le $parentCreationTime) { continue }
      $key = Get-ProcessIdentityKey -ProcessIdentity $identity
      if ($identities.ContainsKey($key)) { continue }
      $identities[$key] = $identity
      $pending += $identity
    }
  }

  return @($identities.Values)
}

function Add-KnownProcessIdentities {
  param(
    [System.Collections.Generic.Dictionary[string, object]] $KnownProcessIdentities,
    [PSCustomObject[]] $ProcessIdentities
  )

  foreach ($processIdentity in $ProcessIdentities) {
    $KnownProcessIdentities[(Get-ProcessIdentityKey -ProcessIdentity $processIdentity)] = $processIdentity
  }
}

function Stop-ProcessTree {
  param(
    [PSCustomObject] $RootProcessIdentity,
    [System.Collections.Generic.Dictionary[string, object]] $KnownProcessIdentities
  )

  Add-KnownProcessIdentities -KnownProcessIdentities $KnownProcessIdentities -ProcessIdentities @($RootProcessIdentity)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $cleanupFailure = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $processIdentities = $null
    try {
      $processIdentities = @(Get-ProcessTreeIdentities -RootProcessIdentities @($KnownProcessIdentities.Values))
      Add-KnownProcessIdentities -KnownProcessIdentities $KnownProcessIdentities -ProcessIdentities $processIdentities
    } catch {
      if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
    }

    if ($null -eq $processIdentities) {
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($processIdentities.Count -eq 0) {
      if ($null -ne $cleanupFailure) { throw $cleanupFailure }
      return @($KnownProcessIdentities.Values)
    }

    foreach ($processIdentity in @($processIdentities | Sort-Object ProcessId -Descending)) {
      try {
        $currentProcess = Get-CimProcess -ProcessId $processIdentity.ProcessId
        if ($null -eq $currentProcess -or -not (Test-ProcessIdentity -ProcessIdentity $processIdentity -Process $currentProcess)) { continue }
        Stop-Process -Id $processIdentity.ProcessId -Force -ErrorAction Stop
      } catch {
        if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  if ($null -ne $cleanupFailure) { throw $cleanupFailure }
  throw "Portable process tree did not stop before the cleanup deadline"
}

function Test-AllowedRemoteAddress {
  param(
    [string] $RemoteAddress,
    [string[]] $AllowedAddresses
  )

  [System.Net.IPAddress] $address = $null
  if (-not [System.Net.IPAddress]::TryParse($RemoteAddress, [ref]$address)) { return $false }
  if ($address.Equals([System.Net.IPAddress]::Loopback)) { return $true }
  if ($address.IsIPv4MappedToIPv6 -and $address.MapToIPv4().Equals([System.Net.IPAddress]::Loopback)) { return $true }
  return $AllowedAddresses -contains $address.ToString()
}

function Add-ObservedConnections {
  param(
    [PSCustomObject[]] $ProcessIdentities,
    [string[]] $AllowedAddresses,
    [System.Collections.Generic.HashSet[string]] $ObservedRemoteAddresses
  )

  if ($ProcessIdentities.Count -eq 0) { return }
  $processes = @(Get-CimInstance Win32_Process)
  $processIDs = @(
    foreach ($processIdentity in $ProcessIdentities) {
      if (@($processes | Where-Object { Test-ProcessIdentity -ProcessIdentity $processIdentity -Process $_ })) {
        $processIdentity.ProcessId
      }
    }
  )
  if ($processIDs.Count -eq 0) { return }
  foreach ($connection in @(Get-NetTCPConnection -State Established -ErrorAction Stop)) {
    if ($processIDs -notcontains [int]$connection.OwningProcess) { continue }
    [void]$ObservedRemoteAddresses.Add($connection.RemoteAddress)
    if (-not (Test-AllowedRemoteAddress -RemoteAddress $connection.RemoteAddress -AllowedAddresses $AllowedAddresses)) {
      throw "Portable process tree established an unexpected TCP connection"
    }
  }
}

function Observe-ProcessTreeConnections {
  param(
    [PSCustomObject] $RootProcessIdentity,
    [string[]] $AllowedAddresses,
    [System.Collections.Generic.HashSet[string]] $ObservedRemoteAddresses,
    [System.Collections.Generic.Dictionary[string, object]] $KnownProcessIdentities
  )

  $processIdentities = @(Get-ProcessTreeIdentities -RootProcessIdentities @($RootProcessIdentity))
  if ($processIdentities.Count -eq 0) { throw "Portable root process identity is no longer observable" }
  Add-KnownProcessIdentities -KnownProcessIdentities $KnownProcessIdentities -ProcessIdentities $processIdentities
  Add-ObservedConnections -ProcessIdentities $processIdentities -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $ObservedRemoteAddresses
  return $processIdentities
}

function Assert-PortablePayload {
  param(
    [string] $ApplicationDirectory,
    [string] $RelativePath
  )

  $item = Get-Item -LiteralPath (Join-Path $ApplicationDirectory $RelativePath) -ErrorAction SilentlyContinue
  if ($null -eq $item -or -not $item.PSIsContainer) {
    if ($null -eq $item) { throw "Portable archive is missing required resource: $RelativePath" }
    return $item
  }
  throw "Portable archive is missing required resource: $RelativePath"
}

function Expand-PortableArchive {
  param([string] $Destination)

  New-Item -ItemType Directory -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
  $executables = @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Filter "Company OpenCode Pilot.exe")
  if ($executables.Count -ne 1) { throw "Portable archive must contain exactly one Company OpenCode Pilot.exe" }
  if ($executables[0].Length -eq 0) { throw "Portable executable is empty" }
  foreach ($resource in @(
    "resources/app.asar",
    "resources/enterprise/opencode.jsonc",
    "resources/enterprise/company-guide.md",
    "resources/enterprise/models.json",
    "resources/enterprise/enterprise-manifest.json",
    "resources/enterprise/skill-packs.json",
    "resources/enterprise/skill-packs/ponytail/LICENSE",
    "resources/enterprise/skill-packs/caveman/LICENSE",
    "resources/enterprise/skill-packs/superpowers/LICENSE",
    "resources/licenses/OpenCode-LICENSE"
  )) {
    [void](Assert-PortablePayload -ApplicationDirectory $executables[0].DirectoryName -RelativePath $resource)
  }

  $signature = Get-AuthenticodeSignature -FilePath $executables[0].FullName
  if ($signature.Status -ne "NotSigned") { throw "Portable executable must be unsigned" }

  return [PSCustomObject]@{
    Executable = $executables[0].FullName
    Directory = $executables[0].DirectoryName
  }
}

function Test-PortableLaunch {
  param(
    [PSCustomObject] $Application,
    [string[]] $AllowedAddresses
  )

  $observedRemoteAddresses = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $knownProcessIdentities = [System.Collections.Generic.Dictionary[string, object]]::new()
  $process = $null
  $rootProcessIdentity = $null
  try {
    $process = Start-Process -FilePath $Application.Executable -WorkingDirectory $Application.Directory -PassThru
    $rootProcessIdentity = Get-ProcessIdentity -ProcessId $process.Id
    if ($null -eq $rootProcessIdentity) { throw "Portable root process identity is unavailable" }
    Add-KnownProcessIdentities -KnownProcessIdentities $knownProcessIdentities -ProcessIdentities @($rootProcessIdentity)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) { throw "Portable executable exited during startup" }
      [void](Observe-ProcessTreeConnections -RootProcessIdentity $rootProcessIdentity -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses -KnownProcessIdentities $knownProcessIdentities)
      Start-Sleep -Milliseconds 250
    }
    $process.Refresh()
    if ($process.HasExited) { throw "Portable executable exited during startup" }
  } finally {
    if ($null -ne $process) {
      $cleanupFailure = $null
      $shutdownProcessIdentities = @()
      $stoppedProcessIdentities = @()
      try {
        $shutdownProcessIdentities = @(Observe-ProcessTreeConnections -RootProcessIdentity $rootProcessIdentity -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses -KnownProcessIdentities $knownProcessIdentities)
      } catch {
        $cleanupFailure = $_
      }
      try {
        $stoppedProcessIdentities = @(Stop-ProcessTree -RootProcessIdentity $rootProcessIdentity -KnownProcessIdentities $knownProcessIdentities)
      } catch {
        if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
      }
      try {
        Add-ObservedConnections -ProcessIdentities @($shutdownProcessIdentities; $stoppedProcessIdentities; $knownProcessIdentities.Values) -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses
      } catch {
        if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
      }
      if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    }
  }
}

$expectedHash = Read-PortableChecksum -Path $Checksum -Archive $Archive
$actualHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw "Portable archive checksum mismatch" }

$metadata = Read-EnterpriseReleaseMetadata -Path $ReleaseMetadata
Assert-EnterpriseReleaseMetadata -Metadata $metadata
if ($metadata.sha256.ToLowerInvariant() -ne $actualHash) { throw "Release metadata checksum mismatch" }
if ($metadata.artifact -ne [System.IO.Path]::GetFileName($Archive)) { throw "Release metadata artifact mismatch" }
if ($metadata.authenticode -ne "NotSigned") { throw "Release metadata signature status mismatch" }
if ($null -eq $metadata.target -or $metadata.target.os -ne "win32" -or $metadata.target.arch -ne "x64") {
  throw "Release metadata target mismatch"
}
foreach ($supplemental in @($metadata.sbom, $metadata.thirdPartyLicenses)) {
  $supplementalPath = Join-Path ([System.IO.Path]::GetDirectoryName($ReleaseMetadata)) $supplemental.file
  if (-not (Test-Path -LiteralPath $supplementalPath -PathType Leaf)) { throw "Release supplemental artifact is missing" }
  $supplementalHash = (Get-FileHash -Algorithm SHA256 $supplementalPath).Hash.ToLowerInvariant()
  if ($supplementalHash -ne $supplemental.sha256) { throw "Release supplemental artifact checksum mismatch" }
}
$existingAcceptance = [object[]]$metadata.windowsAcceptance

$allowedAddresses = Get-AllowedAddresses -TargetHost $AllowedHost
$extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) "opencode-portable-smoke-$([Guid]::NewGuid().ToString('N'))"
$appData = Join-Path $env:LOCALAPPDATA "com.company.opencode.pilot"
$projectSentinel = Join-Path $SentinelProject "keep.txt"
$appDataSentinel = Join-Path $appData "portable-smoke-sentinel.txt"

try {
  New-Item -ItemType Directory -Path $SentinelProject -Force | Out-Null
  Set-Content -LiteralPath $projectSentinel -Value "portable smoke sentinel" -NoNewline

  $application = Expand-PortableArchive -Destination $extractRoot
  Assert-EnterpriseCatalogIdentity -Metadata $metadata -ApplicationDirectory $application.Directory
  Test-PortableLaunch -Application $application -AllowedAddresses $allowedAddresses

  if (-not (Test-Path -LiteralPath $appData -PathType Container)) {
    throw "Portable executable did not create enterprise AppData"
  }
  Set-Content -LiteralPath $appDataSentinel -Value "portable smoke sentinel" -NoNewline

  $extractionPath = [System.IO.Path]::GetFullPath($extractRoot).TrimEnd("\")
  $applicationPath = [System.IO.Path]::GetFullPath($application.Directory).TrimEnd("\")
  if (-not $applicationPath.StartsWith("$extractionPath\", [System.StringComparison]::OrdinalIgnoreCase) -and $applicationPath -ne $extractionPath) {
    throw "Portable application directory escaped the temporary extraction root"
  }
  Remove-Item -LiteralPath $application.Directory -Recurse -Force

  $application = Expand-PortableArchive -Destination $extractRoot
  Test-PortableLaunch -Application $application -AllowedAddresses $allowedAddresses

  if (-not (Test-Path -LiteralPath $projectSentinel -PathType Leaf)) {
    throw "Portable replacement removed the project sentinel"
  }
  if (-not (Test-Path -LiteralPath $appDataSentinel -PathType Leaf)) {
    throw "Portable replacement removed the AppData sentinel"
  }

  $record = [ordered]@{
    windowsVersion = (Get-CimInstance Win32_OperatingSystem).Caption
    windowsBuild = [Environment]::OSVersion.Version.ToString()
    testedAt = [DateTime]::UtcNow.ToString("o")
    tester = $env:USERNAME
    result = "pass"
  }
  Assert-WindowsAcceptanceRecords -Records @($record)
} finally {
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
}

$metadata.windowsAcceptance = @($existingAcceptance) + $record
$metadataTemporary = "$ReleaseMetadata.$([Guid]::NewGuid().ToString('N')).tmp"
try {
  [System.IO.File]::WriteAllText(
    $metadataTemporary,
    (($metadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::Replace($metadataTemporary, $ReleaseMetadata, $null)
  $metadataTemporary = $null
} finally {
  if ($null -ne $metadataTemporary -and (Test-Path -LiteralPath $metadataTemporary)) {
    Remove-Item -LiteralPath $metadataTemporary -Force
  }
}
