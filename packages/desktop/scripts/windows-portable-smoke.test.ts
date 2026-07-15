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
