import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = new URL("./windows-portable-smoke.ps1", import.meta.url)

function powerShellParserInvocation(scriptPath: string) {
  return `[void][scriptblock]::Create((Get-Content -Raw -LiteralPath '${scriptPath.replaceAll("'", "''")}'))`
}

test("portable smoke script exposes the release contract", async () => {
  const script = await Bun.file(scriptPath).text()

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
  ]) {
    expect(script).toContain(token)
  }

  expect(script).not.toMatch(/Remove-Item[^\r\n]*com\.company\.opencode\.pilot/i)
  expect(script).not.toMatch(/Remove-Item[^\r\n]*SentinelProject/i)
})

test("portable smoke script avoids automatic-variable parameters", async () => {
  const script = await Bun.file(scriptPath).text()

  expect(script).toContain("param([string] $TargetHost)")
  expect(script).toContain("Get-AllowedAddresses -TargetHost $AllowedHost")
  expect(script).not.toMatch(/param\(\[string\] \$Host\)/)
})

test("portable smoke script preserves the required verification and cleanup boundaries", async () => {
  const script = await Bun.file(scriptPath).text()

  for (const token of [
    "Portable archive checksum mismatch",
    'Status -ne "NotSigned"',
    "Resolve-DnsName",
    "127.0.0.1",
    "::1",
    "portable-smoke-sentinel.txt",
    "keep.txt",
    "windowsAcceptance",
    "File]::Replace",
    "finally",
  ]) {
    expect(script).toContain(token)
  }

  expect(script).toMatch(/Remove-Item[^\r\n]*\$extractRoot/i)
  expect(script).not.toMatch(/Remove-Item[^\r\n]*\$appData/i)
  expect(script).toContain('StartsWith("$extractionPath\\",')
  expect(script).not.toContain("Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue")
  expect(script).toContain("Assert-WindowsAcceptanceRecords")
  expect(script).toContain("$existingAcceptance")
  expect(script).toContain('$record["result"]')
})

test("portable smoke script requires a JSON acceptance array before normalization", async () => {
  const script = await Bun.file(scriptPath).text()

  expect(script).toContain("$Metadata.windowsAcceptance -isnot [System.Array]")
  expect(script).toContain("$existingAcceptance = [object[]]$metadata.windowsAcceptance")
  expect(script).not.toContain("$existingAcceptance = @($metadata.windowsAcceptance)")
})

test("portable smoke cleanup completes before acceptance persistence", async () => {
  const script = await Bun.file(scriptPath).text()
  const cleanup = script.indexOf("Remove-Item -LiteralPath $extractRoot -Recurse -Force")
  const acceptance = script.indexOf("$metadata.windowsAcceptance =")

  expect(cleanup).toBeGreaterThan(-1)
  expect(acceptance).toBeGreaterThan(cleanup)
})

test("portable smoke polls descendant egress through shutdown", async () => {
  const script = await Bun.file(scriptPath).text()

  for (const token of [
    "Observe-ProcessTreeConnections",
    "Add-ObservedConnections",
    "$observedRemoteAddresses",
    "Start-Sleep -Milliseconds 250",
    "Get-NetTCPConnection -State Established -ErrorAction Stop",
    "Get-ProcessTreeIds",
    "Stop-ProcessTree",
  ]) {
    expect(script).toContain(token)
  }

  expect(script).not.toContain("Assert-AllowedConnections")
})

test("portable smoke continues cleanup after final observation failures", async () => {
  const script = await Bun.file(scriptPath).text()
  const launch = script.slice(script.indexOf("function Test-PortableLaunch"), script.indexOf("$expectedHash"))

  expect(launch).toContain("$cleanupFailure = $null")
  expect(launch).toContain(
    "$stoppedProcessIDs = @(Stop-ProcessTree -RootProcessId $process.Id -KnownProcessIDs $knownProcessIDs)",
  )
  expect(launch).toContain("if ($null -ne $cleanupFailure) { throw $cleanupFailure }")
  expect(launch).toContain("$process.Id + $shutdownProcessIDs + $stoppedProcessIDs")
  expect(launch).toMatch(
    /Observe-ProcessTreeConnections[\s\S]*catch \{[\s\S]*\$cleanupFailure = \$_[\s\S]*Stop-ProcessTree[\s\S]*catch \{/,
  )
  expect(script.indexOf("Remove-Item -LiteralPath $extractRoot -Recurse -Force")).toBeGreaterThan(
    script.indexOf("Test-PortableLaunch -Application $application"),
  )
  expect(script.indexOf("$metadata.windowsAcceptance =")).toBeGreaterThan(
    script.indexOf("Remove-Item -LiteralPath $extractRoot -Recurse -Force"),
  )
})

test("portable smoke stops the known root when CIM process discovery fails", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(stop).toContain("$processIDs = @($RootProcessId)")
  expect(stop).toContain("Get-ProcessTreeIds -RootProcessId $RootProcessId")
  expect(stop).toContain("Stop-Process -Id $RootProcessId -Force -ErrorAction Stop")
  expect(stop).toMatch(
    /Get-ProcessTreeIds[\s\S]*catch \{[\s\S]*Stop-Process -Id \$RootProcessId -Force -ErrorAction Stop/,
  )
})

test("portable smoke rethrows CIM cleanup failures after stopping retained PIDs", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )
  const launch = script.slice(script.indexOf("function Test-PortableLaunch"), script.indexOf("$expectedHash"))

  expect(stop).toContain("$discoveryFailure = $null")
  expect(stop).toContain("$discoveryFailure = $_")
  expect(stop).toMatch(
    /Get-ProcessTreeIds[\s\S]*catch \{[\s\S]*\$discoveryFailure = \$_[\s\S]*Stop-Process -Id \$RootProcessId -Force -ErrorAction Stop[\s\S]*foreach \(\$processID in \$processIDs\)[\s\S]*Get-Process -Id \$processID -ErrorAction SilentlyContinue[\s\S]*if \(\$survivingProcessIDs\.Count -gt 0\)[\s\S]*if \(\$null -ne \$discoveryFailure\) \{ throw \$discoveryFailure \}/,
  )
  expect(launch.indexOf("Stop-ProcessTree -RootProcessId $process.Id -KnownProcessIDs $knownProcessIDs")).toBeLessThan(
    launch.indexOf("if ($null -ne $cleanupFailure) { throw $cleanupFailure }"),
  )
  expect(script.indexOf("$metadata.windowsAcceptance =")).toBeGreaterThan(
    script.indexOf("Remove-Item -LiteralPath $extractRoot -Recurse -Force"),
  )
})

test("portable smoke stops and verifies every discovered process before surfacing cleanup failures", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(stop).toContain("$stopFailures = @{}")
  expect(stop).toContain(
    "$descendantProcessIDs = @($processIDs | Where-Object { $_ -ne $RootProcessId } | Sort-Object -Descending)",
  )
  expect(stop).toContain("foreach ($processID in $descendantProcessIDs)")
  expect(stop).toContain("Stop-Process -Id $RootProcessId -Force -ErrorAction Stop")
  expect(stop).toContain("$stopFailures[$processID] = $_")
  expect(stop).toContain("$stopFailures[$RootProcessId] = $_")
  expect(stop).toContain("$survivingProcessIDs = @()")
  expect(stop).toContain("$survivingProcessIDs += $processID")
  expect(stop).toMatch(
    /foreach \(\$processID in \$descendantProcessIDs\)[\s\S]*Stop-Process[\s\S]*catch \{[\s\S]*\$stopFailures\[\$processID\] = \$_[\s\S]*Stop-Process -Id \$RootProcessId -Force -ErrorAction Stop[\s\S]*foreach \(\$processID in \$processIDs\)[\s\S]*Get-Process -Id \$processID -ErrorAction SilentlyContinue[\s\S]*if \(\$survivingProcessIDs\.Count -gt 0\)[\s\S]*throw/,
  )
})

test("portable smoke rejects scalar and incompatible release metadata before mutation", async () => {
  const script = await Bun.file(scriptPath).text()
  const validation = script.slice(
    script.indexOf("function Assert-EnterpriseReleaseMetadata"),
    script.indexOf("function Get-ProcessTreeIds"),
  )
  const metadataLoad = script.slice(
    script.indexOf("$metadata = Read-EnterpriseReleaseMetadata"),
    script.indexOf("$allowedAddresses"),
  )

  for (const token of [
    "$Metadata -isnot [PSCustomObject]",
    "$schemaVersion -is [string]",
    "$schemaVersion -is [bool]",
    "$schemaVersion -isnot [System.IConvertible]",
    "[decimal]$schemaVersion",
    "[decimal]::Truncate($numericSchemaVersion)",
    "$numericSchemaVersion -ne 1",
    '"appVersion"',
    '"gitCommit"',
    '"defaultsVersion"',
    '"guideVersion"',
    '"modelID"',
    '"windowsAcceptance"',
  ]) {
    expect(validation).toContain(token)
  }

  expect(metadataLoad.indexOf("Assert-EnterpriseReleaseMetadata -Metadata $metadata")).toBeGreaterThan(-1)
  expect(metadataLoad.indexOf("Assert-EnterpriseReleaseMetadata -Metadata $metadata")).toBeLessThan(
    metadataLoad.indexOf("$metadata.sha256"),
  )
  expect(script.indexOf("$metadata.windowsAcceptance =")).toBeGreaterThan(
    script.indexOf("Assert-EnterpriseReleaseMetadata -Metadata $metadata"),
  )
})

test("portable smoke gates raw release JSON to a single top-level object", async () => {
  const script = await Bun.file(scriptPath).text()
  const reader = script.slice(
    script.indexOf("function Read-EnterpriseReleaseMetadata"),
    script.indexOf("function Get-ProcessTreeIds"),
  )

  for (const token of [
    "Get-Content -Raw -LiteralPath $Path",
    "TrimStart([char[]]@([char]0xFEFF)).Trim()",
    '$releaseJson[0] -ne "{"',
    '$releaseJson[$releaseJson.Length - 1] -ne "}"',
    "$releaseJson | ConvertFrom-Json",
    "$metadata -isnot [PSCustomObject]",
  ]) {
    expect(reader).toContain(token)
  }

  expect(reader).not.toContain("-NoEnumerate")
})

test("portable smoke retains every observed process PID for cleanup", async () => {
  const script = await Bun.file(scriptPath).text()
  const launch = script.slice(script.indexOf("function Test-PortableLaunch"), script.indexOf("$expectedHash"))
  const observe = script.slice(
    script.indexOf("function Observe-ProcessTreeConnections"),
    script.indexOf("function Expand-PortableArchive"),
  )
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(launch).toContain("$knownProcessIDs = [System.Collections.Generic.HashSet[int]]::new()")
  expect(launch).toContain("[void]$knownProcessIDs.Add([int]$process.Id)")
  expect(launch).toContain("Observe-ProcessTreeConnections -RootProcessId $process.Id")
  expect(launch).toContain("-KnownProcessIDs $knownProcessIDs")
  expect(launch).toContain("Stop-ProcessTree -RootProcessId $process.Id -KnownProcessIDs $knownProcessIDs")
  expect(observe).toContain("[System.Collections.Generic.HashSet[int]] $KnownProcessIDs")
  expect(observe).toContain("Add-KnownProcessIDs -KnownProcessIDs $KnownProcessIDs -ProcessIDs $processIDs")
  expect(observe).toMatch(/Get-ProcessTreeIds[\s\S]*Add-KnownProcessIDs[\s\S]*Add-ObservedConnections/)
  expect(stop).toContain("[System.Collections.Generic.HashSet[int]] $KnownProcessIDs")
  expect(stop).toContain("foreach ($knownProcessID in $KnownProcessIDs)")
  expect(stop).toContain("[void]$KnownProcessIDs.Add($processID)")
  expect(stop).toMatch(
    /foreach \(\$knownProcessID in \$KnownProcessIDs\)[\s\S]*Get-ProcessTreeIds[\s\S]*catch \{[\s\S]*Stop-Process -Id \$RootProcessId -Force -ErrorAction Stop/,
  )
})

test("desktop package exposes the portable smoke command", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()

  expect(pkg.scripts["smoke:enterprise:portable"]).toBe(
    "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/windows-portable-smoke.ps1",
  )
})

test("PowerShell parser receives the exact resolved smoke script path", () => {
  expect(powerShellParserInvocation("C:\\enterprise pilot\\scripts\\windows-portable-smoke.ps1")).toBe(
    "[void][scriptblock]::Create((Get-Content -Raw -LiteralPath 'C:\\enterprise pilot\\scripts\\windows-portable-smoke.ps1'))",
  )
})

test.if(process.platform === "win32")("portable smoke script parses in PowerShell", async () => {
  const process = Bun.spawn(
    ["powershell", "-NoProfile", "-Command", powerShellParserInvocation(fileURLToPath(scriptPath))],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  )

  expect(await process.exited).toBe(0)
})

test.if(process.platform === "win32")(
  "PowerShell rejects array and scalar release JSON before PS5 enumeration",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const reader = script.slice(
      script.indexOf("function Read-EnterpriseReleaseMetadata"),
      script.indexOf("function Get-ProcessTreeIds"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "read-release.ps1")
    const metadata = {
      schemaVersion: 1,
      appVersion: "1.0.0",
      gitCommit: "commit",
      artifact: "company-opencode-pilot-win-x64.zip",
      sha256: "hash",
      defaultsVersion: "defaults",
      guideVersion: "guide",
      modelID: "model",
      target: { os: "win32", arch: "x64" },
      builtAt: "2026-07-15T00:00:00.000Z",
      authenticode: "NotSigned",
      windowsAcceptance: [],
    }

    try {
      await Bun.write(harness, `${reader}\n$null = Read-EnterpriseReleaseMetadata -Path $args[0]`)
      const valid = join(temp, "valid.json")
      await Bun.write(valid, `\ufeff\n${JSON.stringify(metadata)}\n`)
      const validProcess = Bun.spawn(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, valid],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(await validProcess.exited).toBe(0)

      for (const [name, fixture] of Object.entries({
        "one-element-array": JSON.stringify([metadata]),
        scalar: "1",
        null: "null",
        string: JSON.stringify(JSON.stringify(metadata)),
      })) {
        const file = join(temp, `${name}.json`)
        await Bun.write(file, `\ufeff \n${fixture}\n`)
        const process = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, file], {
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(await process.exited).not.toBe(0)
      }
    } finally {
      await rm(temp, { force: true, recursive: true })
    }
  },
)

test.if(process.platform === "win32")(
  "PowerShell rethrows CIM cleanup failures after stopping retained PIDs",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const stop = script.slice(
      script.indexOf("function Stop-ProcessTree"),
      script.indexOf("function Test-AllowedRemoteAddress"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "stop-process-tree.ps1")

    try {
      await Bun.write(
        harness,
        `$ErrorActionPreference = "Stop"
function Get-ProcessTreeIds { param([int] $RootProcessId) throw "CIM discovery failed" }
function Stop-Process { [CmdletBinding()] param([int] $Id, [switch] $Force) $script:stoppedProcessIDs += $Id }
function Get-Process { [CmdletBinding()] param([int] $Id) }
${stop}
$script:stoppedProcessIDs = @()
$knownProcessIDs = [System.Collections.Generic.HashSet[int]]::new()
[void]$knownProcessIDs.Add(20)
$failure = $null
try { Stop-ProcessTree -RootProcessId 10 -KnownProcessIDs $knownProcessIDs } catch { $failure = $_ }
if ((@($script:stoppedProcessIDs | Sort-Object) -join ",") -ne "10,20") { exit 2 }
if ($null -eq $failure) { exit 3 }
if ($failure.Exception.Message -ne "CIM discovery failed") { exit 4 }`,
      )
      const process = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(await process.exited).toBe(0)
    } finally {
      await rm(temp, { force: true, recursive: true })
    }
  },
)
