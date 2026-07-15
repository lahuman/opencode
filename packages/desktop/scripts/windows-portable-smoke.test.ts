import { expect, test } from "bun:test"
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

  expect(script).toContain("-not ($metadata.windowsAcceptance -is [System.Array])")
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
  expect(launch).toContain("$stoppedProcessIDs = @(Stop-ProcessTree -RootProcessId $process.Id)")
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
