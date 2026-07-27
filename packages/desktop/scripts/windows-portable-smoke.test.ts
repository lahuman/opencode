import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = new URL("./windows-portable-smoke.ps1", import.meta.url)
const generatorPath = new URL("./enterprise-release.ts", import.meta.url)
const runbookPath = new URL("../../../docs/enterprise/windows-portable-kernexa-release.md", import.meta.url)

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
    "Get-ProcessTreeIdentities",
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
    "$stoppedProcessIdentities = @(Stop-ProcessTree -RootProcessIdentity $rootProcessIdentity -KnownProcessIdentities $knownProcessIdentities)",
  )
  expect(launch).toContain("if ($null -ne $cleanupFailure) { throw $cleanupFailure }")
  expect(launch).toContain("Add-ObservedConnections -ProcessIdentities")
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

test("portable smoke fails closed when CIM process discovery cannot verify an identity", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(stop).toContain("Get-ProcessTreeIdentities -RootProcessIdentities")
  expect(stop).toContain("$cleanupFailure = $null")
  expect(stop).toContain("if ($null -ne $cleanupFailure) { throw $cleanupFailure }")
  expect(stop).toContain("Test-ProcessIdentity")
  expect(stop).toMatch(/Get-ProcessTreeIdentities[\s\S]*catch \{[\s\S]*\$cleanupFailure = \$_/)
})

test("portable smoke preserves cleanup failures after identity-safe teardown", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )
  const launch = script.slice(script.indexOf("function Test-PortableLaunch"), script.indexOf("$expectedHash"))

  expect(stop).toContain("$cleanupFailure = $null")
  expect(stop).toContain("$cleanupFailure = $_")
  expect(stop).toMatch(
    /Get-ProcessTreeIdentities[\s\S]*catch \{[\s\S]*\$cleanupFailure = \$_[\s\S]*if \(\$null -eq \$processIdentities\)[\s\S]*Start-Sleep[\s\S]*if \(\$null -ne \$cleanupFailure\) \{ throw \$cleanupFailure \}/,
  )
  expect(
    launch.indexOf(
      "Stop-ProcessTree -RootProcessIdentity $rootProcessIdentity -KnownProcessIdentities $knownProcessIdentities",
    ),
  ).toBeLessThan(launch.indexOf("if ($null -ne $cleanupFailure) { throw $cleanupFailure }"))
  expect(script.indexOf("$metadata.windowsAcceptance =")).toBeGreaterThan(
    script.indexOf("Remove-Item -LiteralPath $extractRoot -Recurse -Force"),
  )
})

test("portable smoke stops only CIM-verified identities before surfacing cleanup failures", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(stop).toContain("foreach ($processIdentity in @($processIdentities | Sort-Object ProcessId -Descending))")
  expect(stop).toContain("$currentProcess = Get-CimProcess -ProcessId $processIdentity.ProcessId")
  expect(stop).toContain("Test-ProcessIdentity -ProcessIdentity $processIdentity -Process $currentProcess")
  expect(stop).toContain("Stop-Process -Id $processIdentity.ProcessId -Force -ErrorAction Stop")
  expect(stop).toContain("$cleanupFailure = $_")
  expect(stop).toMatch(
    /Get-CimProcess[\s\S]*Test-ProcessIdentity[\s\S]*Stop-Process[\s\S]*catch \{[\s\S]*\$cleanupFailure = \$_/,
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
    "$numericSchemaVersion -ne 3",
    '"appVersion"',
    '"gitCommit"',
    '"defaultsVersion"',
    '"guideVersion"',
    '"defaultModelID"',
    '"modelIDs"',
    '"modelCatalogSHA256"',
    '"windowsAcceptance"',
    '"sbom"',
    '"thirdPartyLicenses"',
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

test.if(process.platform === "win32")(
  "PowerShell enforces the exact release model/default pair",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const validation = script.slice(
      script.indexOf("function Assert-WindowsAcceptanceRecords"),
      script.indexOf("function Assert-EnterpriseCatalogIdentity"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-release-pair-"))
    const harness = join(temp, "validate-release.ps1")
    const metadataPath = join(temp, "release.json")
    const metadata = {
      schemaVersion: 3,
      appVersion: "1.0.0",
      gitCommit: "0123456789abcdef",
      artifact: "kernexa-1.0.0-win-x64.zip",
      sha256: "a".repeat(64),
      defaultsVersion: "defaults-1",
      guideVersion: "kernexa-1",
      defaultModelID: "code",
      modelIDs: ["code", "reasoning"],
      modelCatalogSHA256: "b".repeat(64),
      target: { os: "win32", arch: "x64" },
      builtAt: "2026-07-15T00:00:00.000Z",
      authenticode: "NotSigned",
      windowsAcceptance: [],
      sbom: { file: "kernexa-1.0.0-win-x64.sbom.cdx.json", sha256: "c".repeat(64) },
      thirdPartyLicenses: {
        file: "kernexa-1.0.0-win-x64.third-party-licenses.txt",
        sha256: "d".repeat(64),
      },
    }

    try {
      await Bun.write(
        harness,
        `${validation}\n$metadata = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json\nAssert-EnterpriseReleaseMetadata -Metadata $metadata`,
      )
      const verify = async (value: typeof metadata) => {
        await Bun.write(metadataPath, JSON.stringify(value))
        const process = Bun.spawn(
          ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, metadataPath],
          { stdout: "pipe", stderr: "pipe" },
        )
        return { code: await process.exited, stderr: await new Response(process.stderr).text() }
      }

      expect(await verify(metadata)).toEqual({ code: 0, stderr: "" })
      expect(await verify({ ...metadata, defaultModelID: "", modelIDs: [] })).toEqual({ code: 0, stderr: "" })
      expect((await verify({ ...metadata, defaultModelID: "ghost", modelIDs: [] })).code).not.toBe(0)
      expect((await verify({ ...metadata, defaultModelID: "", modelIDs: ["code"] })).code).not.toBe(0)
      expect((await verify({ ...metadata, defaultModelID: "ghost", modelIDs: ["code"] })).code).not.toBe(0)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)

test("portable smoke compares release catalog identity with the extracted manifest", async () => {
  const script = await Bun.file(scriptPath).text()
  const validation = script.slice(
    script.indexOf("function Assert-EnterpriseCatalogIdentity"),
    script.indexOf("function Read-EnterpriseReleaseMetadata"),
  )

  for (const token of [
    "enterprise-manifest.json",
    "$manifest.defaultModelID -cne $Metadata.defaultModelID",
    "$manifest.modelCatalogSHA256 -cne $Metadata.modelCatalogSHA256",
    '$manifest.modelIDs -join "`0"',
    '$Metadata.modelIDs -join "`0"',
  ]) {
    expect(validation).toContain(token)
  }
  expect(script).toContain("[System.StringComparer]::Ordinal")
  expect(script).toContain("Assert-EnterpriseCatalogIdentity -Metadata $metadata -ApplicationDirectory $application.Directory")
  expect(script.indexOf("Assert-EnterpriseCatalogIdentity -Metadata $metadata")).toBeLessThan(
    script.indexOf("Test-PortableLaunch -Application $application"),
  )
})

test.if(process.platform === "win32")(
  "PowerShell rejects release catalog identities that differ from the extracted manifest",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const validation = script.slice(
      script.indexOf("function Assert-EnterpriseCatalogIdentity"),
      script.indexOf("function Read-EnterpriseReleaseMetadata"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-catalog-"))
    const application = join(temp, "application")
    const manifest = {
      schemaVersion: 3,
      defaultModelID: "code",
      modelIDs: ["code", "reasoning"],
      modelCatalogSHA256: "a".repeat(64),
    }
    const metadata = {
      defaultModelID: manifest.defaultModelID,
      modelIDs: manifest.modelIDs,
      modelCatalogSHA256: manifest.modelCatalogSHA256,
    }
    const harness = join(temp, "catalog.ps1")
    const metadataPath = join(temp, "release.json")

    try {
      await mkdir(join(application, "resources", "enterprise"), { recursive: true })
      await Bun.write(
        join(application, "resources", "enterprise", "enterprise-manifest.json"),
        JSON.stringify(manifest),
      )
      await Bun.write(
        harness,
        `${validation}\n$metadata = Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json\nAssert-EnterpriseCatalogIdentity -Metadata $metadata -ApplicationDirectory $args[1]`,
      )
      const verify = async (value: typeof metadata) => {
        await Bun.write(metadataPath, JSON.stringify(value))
        const process = Bun.spawn(
          ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, metadataPath, application],
          { stdout: "pipe", stderr: "pipe" },
        )
        return { code: await process.exited, stderr: await new Response(process.stderr).text() }
      }

      expect(await verify(metadata)).toEqual({ code: 0, stderr: "" })
      expect((await verify({ ...metadata, defaultModelID: "reasoning" })).code).not.toBe(0)
      expect((await verify({ ...metadata, modelIDs: ["code", "other"] })).code).not.toBe(0)
      expect((await verify({ ...metadata, modelCatalogSHA256: "b".repeat(64) })).code).not.toBe(0)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)

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

test("portable smoke accepts only the deterministic standalone checksum record", async () => {
  const script = await Bun.file(scriptPath).text()
  const checksum = script.slice(
    script.indexOf("function Read-PortableChecksum"),
    script.indexOf("function Get-ProcessCreationTime"),
  )

  expect(checksum).toContain("[System.IO.Path]::GetFileName($Archive)")
  expect(checksum).toContain("[regex]::Escape($archiveName)")
  expect(checksum).toContain('"\\A([0-9a-f]{64})  $escapedArchiveName\\n\\z"')
  expect(checksum).not.toContain("\\r?")
  expect(checksum).toContain("$checksumMatch.Groups[1].Value")
  expect(checksum).not.toContain("-split")
  expect(checksum).not.toContain("ToUpperInvariant")
})

test("portable smoke accepts child edges only when the child was created after the matched parent", async () => {
  const script = await Bun.file(scriptPath).text()
  const discovery = script.slice(
    script.indexOf("function Get-ProcessCreationTime"),
    script.indexOf("function Add-KnownProcessIdentities"),
  )

  expect(discovery).toContain("function ConvertFrom-ProcessCreationTime")
  expect(discovery).toContain("[DateTime]::TryParseExact")
  expect(discovery).toContain("[System.Globalization.DateTimeStyles]::RoundtripKind")
  expect(discovery).toContain(
    "$childCreationTime = ConvertFrom-ProcessCreationTime -CreationTime $identity.CreationTime",
  )
  expect(discovery).toContain(
    "$parentCreationTime = ConvertFrom-ProcessCreationTime -CreationTime $parent.CreationTime",
  )
  expect(discovery).toContain("if ($childCreationTime -le $parentCreationTime) { continue }")
})

test("runbook checksum consumers match the generator's exact LF-terminated bytes", async () => {
  const generator = await Bun.file(generatorPath).text()
  const runbook = await Bun.file(runbookPath).text()

  expect(runbook).toContain("# Kernexa: Windows Portable ZIP Release")
  expect(runbook).toContain("kernexa-<version>-win-x64.zip")
  expect(runbook).toContain('Filter "Kernexa.exe"')
  expect(runbook).toContain("%LOCALAPPDATA%\\com.company.kernexa")
  expect(runbook).toContain("%LOCALAPPDATA%\\com.company.opencode.pilot")
  expect(generator).toContain("Bun.write(`${input.archive}.sha256`, `${sha256}  ${artifact}\\n`)")
  expect(runbook).not.toMatch(/\$\w*[Cc]hecksumRecord\s*=\s*\(Get-Content[^\r\n]+\)\.Trim\(\)/)
  expect(runbook.match(/\[regex\]::Match\([^\r\n]+\\n\\z/g)?.length).toBe(2)
  expect(runbook).not.toContain("\\r?\\n\\z")
  expect(runbook).toContain("one LF byte (`0x0A`)")
  expect(runbook).toContain("[System.IO.File]::WriteAllText(")
  expect(runbook).toContain('"$windows11SourceHash  $returnedArtifact`n"')
})

test("portable smoke validates every required extracted payload and a nonempty executable", async () => {
  const script = await Bun.file(scriptPath).text()
  const archive = script.slice(
    script.indexOf("function Assert-PortablePayload"),
    script.indexOf("function Test-PortableLaunch"),
  )

  for (const resource of [
    "resources/app.asar",
    "resources/enterprise/opencode.jsonc",
    "resources/enterprise/company-guide.md",
    "resources/enterprise/models.json",
    "resources/enterprise/enterprise-manifest.json",
    "resources/enterprise/ripgrep/rg.exe",
    "resources/enterprise/ripgrep/LICENSE-MIT",
    "resources/enterprise/ripgrep/UNLICENSE",
    "resources/licenses/OpenCode-LICENSE",
  ]) {
    expect(archive).toContain(`"${resource}"`)
  }

  expect(archive).toContain("function Assert-PortablePayload")
  expect(archive).toContain("Portable executable is empty")
  expect(archive).toContain("Portable archive is missing required resource")
  expect(archive).toContain("$executables[0].Length -eq 0")
  expect(archive).toContain('Status -ne "NotSigned"')
})

test("portable smoke executes bundled ripgrep and enumerates an enterprise skill", async () => {
  const script = await Bun.file(scriptPath).text()
  expect(script).toContain("function Test-BundledRipgrep")
  expect(script).toContain('"--version"')
  expect(script).toContain('"--glob=!**/SKILL.md"')
  expect(script).toContain('"agents/openai.yaml"')
  expect(script).toContain("Test-BundledRipgrep -ApplicationDirectory $application.Directory")
})

test("portable smoke retains process identities with PID and creation time for observation and cleanup", async () => {
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

  expect(launch).toContain("$knownProcessIdentities = [System.Collections.Generic.Dictionary[string, object]]::new()")
  expect(observe).toContain("[System.Collections.Generic.Dictionary[string, object]] $KnownProcessIdentities")
  expect(stop).toContain("[System.Collections.Generic.Dictionary[string, object]] $KnownProcessIdentities")
  expect(script).toContain("CreationTime")
  expect(script).toContain("Get-ProcessIdentityKey")

  expect(launch).toContain("Get-ProcessIdentity -ProcessId $process.Id")
  expect(launch).toContain("-RootProcessIdentity $rootProcessIdentity")
  expect(observe).toContain("Get-ProcessTreeIdentities")
  expect(observe).toContain("Add-KnownProcessIdentities")
  expect(stop).toContain("Get-ProcessTreeIdentities")
  expect(stop).toContain("Test-ProcessIdentity")
  expect(stop).not.toContain("[System.Collections.Generic.HashSet[int]]")
  expect(stop).not.toContain("Stop-Process -Id $RootProcessId")
})

test("portable smoke repeatedly rediscovers owned descendants with a bounded cleanup timeout", async () => {
  const script = await Bun.file(scriptPath).text()
  const stop = script.slice(
    script.indexOf("function Stop-ProcessTree"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )

  expect(stop).toContain("$deadline = [DateTime]::UtcNow.AddSeconds(10)")
  expect(stop).toContain("while ([DateTime]::UtcNow -lt $deadline)")
  expect(stop).toContain("Get-ProcessTreeIdentities")
  expect(stop).toContain("Start-Sleep -Milliseconds 100")
  expect(stop).toContain("Portable process tree did not stop before the cleanup deadline")
  expect(stop).toMatch(
    /while \(\[DateTime\]::UtcNow -lt \$deadline\)[\s\S]*Get-ProcessTreeIdentities[\s\S]*Stop-Process[\s\S]*Start-Sleep/,
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
      script.indexOf("function Read-PortableChecksum"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "read-release.ps1")
    const metadata = {
      schemaVersion: 3,
      appVersion: "1.0.0",
      gitCommit: "commit",
      artifact: "kernexa-win-x64.zip",
      sha256: "hash",
      defaultsVersion: "defaults",
      guideVersion: "guide",
      defaultModelID: "model",
      modelIDs: ["model"],
      modelCatalogSHA256: "c".repeat(64),
      target: { os: "win32", arch: "x64" },
      builtAt: "2026-07-15T00:00:00.000Z",
      authenticode: "NotSigned",
      windowsAcceptance: [],
      sbom: { file: "kernexa-win-x64.sbom.cdx.json", sha256: "a".repeat(64) },
      thirdPartyLicenses: {
        file: "kernexa-win-x64.third-party-licenses.txt",
        sha256: "b".repeat(64),
      },
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
  15_000,
)

test.if(process.platform === "win32")(
  "PowerShell checksum fixtures reject any record outside the exact artifact schema",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "read-checksum.ps1")
    const checksum = script.slice(
      script.indexOf("function Read-PortableChecksum"),
      script.indexOf("function Get-ProcessCreationTime"),
    )
    const hash = "a".repeat(64)

    try {
      await Bun.write(harness, `${checksum}\n$null = Read-PortableChecksum -Path $args[0] -Archive $args[1]`)
      const archive = join(temp, "Kernexa.zip")
      for (const [name, fixture, expected] of [
        ["valid", `${hash}  Kernexa.zip\n`, 0],
        ["missing-line-end", `${hash}  Kernexa.zip`, 1],
        ["crlf-line-end", `${hash}  Kernexa.zip\r\n`, 1],
        ["uppercase", `${hash.toUpperCase()}  Kernexa.zip\n`, 1],
        ["wrong-name", `${hash}  other.zip\n`, 1],
        ["extra-record", `${hash}  Kernexa.zip\n${hash}  Kernexa.zip\n`, 1],
        ["extra-line-end", `${hash}  Kernexa.zip\n\n`, 1],
      ] as const) {
        const checksumPath = join(temp, `${name}.sha256`)
        await Bun.write(checksumPath, fixture)
        const process = Bun.spawn(
          ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, checksumPath, archive],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect(await process.exited).toBe(expected)
      }
    } finally {
      await rm(temp, { force: true, recursive: true })
    }
  },
  15_000,
)

test.if(process.platform === "win32")(
  "PowerShell cleanup stops only children created after their matched parent",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const processFunctions = script.slice(
      script.indexOf("function Get-ProcessCreationTime"),
      script.indexOf("function Test-AllowedRemoteAddress"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "stop-ordered-process-tree.ps1")

    try {
      await Bun.write(
        harness,
        `$ErrorActionPreference = "Stop"
$script:processes = @(
  [PSCustomObject]@{ ProcessId = 10; ParentProcessId = 0; CreationDate = [DateTime]"2026-07-15T00:00:10Z" },
  [PSCustomObject]@{ ProcessId = 20; ParentProcessId = 10; CreationDate = [DateTime]"2026-07-15T00:00:05Z" },
  [PSCustomObject]@{ ProcessId = 30; ParentProcessId = 10; CreationDate = [DateTime]"2026-07-15T00:00:15Z" }
)
function Get-CimInstance { [CmdletBinding()] param([string] $ClassName) return @($script:processes) }
function Stop-Process {
  [CmdletBinding()]
  param([int] $Id, [switch] $Force)
  $script:stopped += $Id
  $script:processes = @($script:processes | Where-Object { [int]$_.ProcessId -ne $Id })
}
function Start-Sleep { [CmdletBinding()] param([int] $Milliseconds) }
${processFunctions}
$script:stopped = @()
$knownProcessIdentities = [System.Collections.Generic.Dictionary[string, object]]::new()
$root = New-ProcessIdentity -Process $script:processes[0]
[void](Stop-ProcessTree -RootProcessIdentity $root -KnownProcessIdentities $knownProcessIdentities)
if ($script:stopped -contains 20) { exit 2 }
if ((@($script:stopped | Sort-Object) -join ",") -ne "10,30") { exit 3 }`,
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
  15_000,
)

test.if(process.platform === "win32")("PowerShell cleanup fixture does not stop a reused retained PID", async () => {
  const script = await Bun.file(scriptPath).text()
  const processFunctions = script.slice(
    script.indexOf("function Get-ProcessCreationTime"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )
  const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
  const harness = join(temp, "stop-process-tree.ps1")

  try {
    await Bun.write(
      harness,
      `$ErrorActionPreference = "Stop"
function Get-CimInstance {
  [CmdletBinding()]
  param([string] $ClassName)
  return [PSCustomObject]@{ ProcessId = 20; ParentProcessId = 0; CreationDate = [DateTime]"2026-07-15T00:00:20Z" }
}
function Stop-Process { [CmdletBinding()] param([int] $Id, [switch] $Force) exit 2 }
${processFunctions}
$knownProcessIdentities = [System.Collections.Generic.Dictionary[string, object]]::new()
$root = [PSCustomObject]@{ ProcessId = 10; CreationTime = "2026-07-15T00:00:10.0000000Z" }
$retained = [PSCustomObject]@{ ProcessId = 20; CreationTime = "2026-07-15T00:00:15.0000000Z" }
Add-KnownProcessIdentities -KnownProcessIdentities $knownProcessIdentities -ProcessIdentities @($root, $retained)
Stop-ProcessTree -RootProcessIdentity $root -KnownProcessIdentities $knownProcessIdentities`,
    )
    const process = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await process.exited).toBe(0)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test("portable smoke normalizes artifact paths before using .NET file APIs", async () => {
  const script = await Bun.file(scriptPath).text()
  const verification = script.indexOf("$expectedHash = Read-PortableChecksum")

  for (const name of ["Archive", "Checksum", "ReleaseMetadata", "SentinelProject"]) {
    const normalization = script.indexOf(`$${name} = [System.IO.Path]::GetFullPath($${name})`)
    expect(normalization).toBeGreaterThan(0)
    expect(normalization).toBeLessThan(verification)
  }
})

test("portable smoke uses a valid backup path for atomic acceptance metadata replacement", async () => {
  const script = await Bun.file(scriptPath).text()
  expect(script).toContain("[System.IO.File]::Replace($metadataTemporary, $ReleaseMetadata, $metadataBackup)")
  expect(script).not.toContain("[System.IO.File]::Replace($metadataTemporary, $ReleaseMetadata, $null)")
  expect(script).toContain("Remove-Item -LiteralPath $metadataBackup -Force")
})

test.if(process.platform === "win32")("PowerShell cleanup tolerates a process exiting during Stop-Process", async () => {
  const script = await Bun.file(scriptPath).text()
  const processFunctions = script.slice(
    script.indexOf("function Get-ProcessCreationTime"),
    script.indexOf("function Test-AllowedRemoteAddress"),
  )
  const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
  const harness = join(temp, "stop-exited-process.ps1")

  try {
    await Bun.write(
      harness,
      `$ErrorActionPreference = "Stop"
$script:processes = @(
  [PSCustomObject]@{ ProcessId = 10; ParentProcessId = 0; CreationDate = [DateTime]"2026-07-15T00:00:10Z" }
)
function Get-CimInstance { [CmdletBinding()] param([string] $ClassName) return @($script:processes) }
function Stop-Process {
  [CmdletBinding()]
  param([int] $Id, [switch] $Force)
  $script:processes = @()
  throw "process already exited"
}
function Start-Sleep { [CmdletBinding()] param([int] $Milliseconds) }
${processFunctions}
$knownProcessIdentities = [System.Collections.Generic.Dictionary[string, object]]::new()
$root = New-ProcessIdentity -Process $script:processes[0]
[void](Stop-ProcessTree -RootProcessIdentity $root -KnownProcessIdentities $knownProcessIdentities)`,
    )
    const process = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await process.exited).toBe(0)
  } finally {
    await rm(temp, { force: true, recursive: true })
  }
})

test.if(process.platform === "win32")(
  "PowerShell extracted-resource fixtures require each named payload to be a file",
  async () => {
    const script = await Bun.file(scriptPath).text()
    const payload = script.slice(
      script.indexOf("function Assert-PortablePayload"),
      script.indexOf("function Expand-PortableArchive"),
    )
    const temp = await mkdtemp(join(tmpdir(), "opencode-portable-smoke-"))
    const harness = join(temp, "assert-payload.ps1")

    try {
      await Bun.write(
        harness,
        `${payload}\n$null = Assert-PortablePayload -ApplicationDirectory $args[0] -RelativePath $args[1]`,
      )
      for (const resource of [
        "resources/app.asar",
        "resources/enterprise/opencode.jsonc",
        "resources/enterprise/company-guide.md",
        "resources/enterprise/models.json",
        "resources/enterprise/enterprise-manifest.json",
        "resources/licenses/OpenCode-LICENSE",
      ]) {
        const file = join(temp, resource)
        await mkdir(dirname(file), { recursive: true })
        await Bun.write(file, "payload")
        const valid = Bun.spawn(
          ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, temp, resource],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        expect(await valid.exited).toBe(0)
        await rm(file)
        const missing = Bun.spawn(
          ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness, temp, resource],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        expect(await missing.exited).not.toBe(0)
      }
    } finally {
      await rm(temp, { force: true, recursive: true })
    }
  },
  15_000,
)
