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

function Get-ProcessTreeIds {
  param([int] $RootProcessId)

  $processes = @(Get-CimInstance Win32_Process)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $pending = @($RootProcessId)

  while ($pending.Count -gt 0) {
    $processID = [int]$pending[0]
    $pending = @($pending | Select-Object -Skip 1)
    if (-not $ids.Add($processID)) { continue }
    $pending += @(
      $processes |
        Where-Object { [int]$_.ParentProcessId -eq $processID } |
        ForEach-Object { [int]$_.ProcessId }
    )
  }

  return @($ids)
}

function Stop-ProcessTree {
  param([int] $RootProcessId)

  $processIDs = @($RootProcessId)
  try {
    $discoveredProcessIDs = @(Get-ProcessTreeIds -RootProcessId $RootProcessId | Sort-Object -Descending)
    $processIDs = @($processIDs + $discoveredProcessIDs | Select-Object -Unique)
  } catch {
  }
  foreach ($processID in @($processIDs | Where-Object { $_ -ne $RootProcessId } | Sort-Object -Descending)) {
    try {
      Stop-Process -Id $processID -Force -ErrorAction Stop
    } catch {
    }
  }
  $rootFailure = $null
  try {
    Stop-Process -Id $RootProcessId -Force -ErrorAction Stop
  } catch {
    $rootFailure = $_
  }
  if (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) {
    if ($null -ne $rootFailure) { throw $rootFailure }
    throw "Portable root process did not stop"
  }
  return $processIDs
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
    [int[]] $ProcessIDs,
    [string[]] $AllowedAddresses,
    [System.Collections.Generic.HashSet[string]] $ObservedRemoteAddresses
  )

  if ($ProcessIDs.Count -eq 0) { return }
  foreach ($connection in @(Get-NetTCPConnection -State Established -ErrorAction Stop)) {
    if ($ProcessIDs -notcontains [int]$connection.OwningProcess) { continue }
    [void]$ObservedRemoteAddresses.Add($connection.RemoteAddress)
    if (-not (Test-AllowedRemoteAddress -RemoteAddress $connection.RemoteAddress -AllowedAddresses $AllowedAddresses)) {
      throw "Portable process tree established an unexpected TCP connection"
    }
  }
}

function Observe-ProcessTreeConnections {
  param(
    [int] $RootProcessId,
    [string[]] $AllowedAddresses,
    [System.Collections.Generic.HashSet[string]] $ObservedRemoteAddresses
  )

  $processIDs = @(Get-ProcessTreeIds -RootProcessId $RootProcessId)
  Add-ObservedConnections -ProcessIDs $processIDs -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $ObservedRemoteAddresses
  return $processIDs
}

function Expand-PortableArchive {
  param([string] $Destination)

  New-Item -ItemType Directory -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
  $executables = @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Filter "Company OpenCode Pilot.exe")
  if ($executables.Count -ne 1) { throw "Portable archive must contain exactly one Company OpenCode Pilot.exe" }

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
  $process = $null
  try {
    $process = Start-Process -FilePath $Application.Executable -WorkingDirectory $Application.Directory -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) { throw "Portable executable exited during startup" }
      [void](Observe-ProcessTreeConnections -RootProcessId $process.Id -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses)
      Start-Sleep -Milliseconds 250
    }
    $process.Refresh()
    if ($process.HasExited) { throw "Portable executable exited during startup" }
  } finally {
    if ($null -ne $process) {
      $cleanupFailure = $null
      $shutdownProcessIDs = @()
      $stoppedProcessIDs = @()
      try {
        $shutdownProcessIDs = @(Observe-ProcessTreeConnections -RootProcessId $process.Id -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses)
      } catch {
        $cleanupFailure = $_
      }
      try {
        $stoppedProcessIDs = @(Stop-ProcessTree -RootProcessId $process.Id)
      } catch {
        if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
      }
      try {
        $finalProcessIDs = @($process.Id + $shutdownProcessIDs + $stoppedProcessIDs | Select-Object -Unique)
        Add-ObservedConnections -ProcessIDs $finalProcessIDs -AllowedAddresses $AllowedAddresses -ObservedRemoteAddresses $observedRemoteAddresses
      } catch {
        if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
      }
      if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    }
  }
}

$expectedHash = ((Get-Content -Raw $Checksum).Trim() -split "\s+")[0].ToUpperInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) { throw "Portable archive checksum mismatch" }

$metadata = Get-Content -Raw $ReleaseMetadata | ConvertFrom-Json
if ($metadata.sha256.ToUpperInvariant() -ne $actualHash) { throw "Release metadata checksum mismatch" }
if ($metadata.artifact -ne [System.IO.Path]::GetFileName($Archive)) { throw "Release metadata artifact mismatch" }
if ($metadata.authenticode -ne "NotSigned") { throw "Release metadata signature status mismatch" }
if ($null -eq $metadata.target -or $metadata.target.os -ne "win32" -or $metadata.target.arch -ne "x64") {
  throw "Release metadata target mismatch"
}
if ($null -eq $metadata.windowsAcceptance -or -not ($metadata.windowsAcceptance -is [System.Array])) {
  throw "Release metadata Windows acceptance is invalid"
}
$existingAcceptance = [object[]]$metadata.windowsAcceptance
Assert-WindowsAcceptanceRecords -Records $existingAcceptance

$allowedAddresses = Get-AllowedAddresses -TargetHost $AllowedHost
$extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) "opencode-portable-smoke-$([Guid]::NewGuid().ToString('N'))"
$appData = Join-Path $env:LOCALAPPDATA "com.company.opencode.pilot"
$projectSentinel = Join-Path $SentinelProject "keep.txt"
$appDataSentinel = Join-Path $appData "portable-smoke-sentinel.txt"

try {
  New-Item -ItemType Directory -Path $SentinelProject -Force | Out-Null
  Set-Content -LiteralPath $projectSentinel -Value "portable smoke sentinel" -NoNewline

  $application = Expand-PortableArchive -Destination $extractRoot
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
