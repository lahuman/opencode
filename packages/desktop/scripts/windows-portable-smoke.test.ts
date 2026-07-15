import { expect, test } from "bun:test"

const scriptPath = new URL("./windows-portable-smoke.ps1", import.meta.url)

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
})

test("desktop package exposes the portable smoke command", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()

  expect(pkg.scripts["smoke:enterprise:portable"]).toBe(
    "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/windows-portable-smoke.ps1",
  )
})

test.if(process.platform === "win32")("portable smoke script parses in PowerShell", async () => {
  const process = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "[void][scriptblock]::Create((Get-Content -Raw .\\scripts\\windows-portable-smoke.ps1))",
    ],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  )

  expect(await process.exited).toBe(0)
})
