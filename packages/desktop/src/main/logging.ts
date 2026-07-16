import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, dialog, netLog, shell } from "electron"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { homedir, release } from "node:os"
import { ENTERPRISE_ENABLED } from "../enterprise"
import type { EnterpriseReadinessReport } from "./enterprise-readiness"
import {
  createEnterpriseSupportManifest,
  redactEnterpriseSupportMetadata,
  redactEnterpriseSupportText,
} from "./enterprise-support"

const MAX_LOG_AGE_DAYS = ENTERPRISE_ENABLED ? 14 : 7
const MAX_LOG_TOTAL_SIZE = 50 * 1024 * 1024
const TAIL_LINES = 1000
const EXPORT_WINDOW = 24 * 60 * 60 * 1000
const MAX_EXPORT_FILE_SIZE = 50 * 1024 * 1024
const NET_LOG_SIZE = 20 * 1024 * 1024

let root = ""
let run = ""
let netLogPath: string | undefined

let logger: MainLogger
let enterpriseHookInstalled = false
let lastEnterpriseCleanup = 0
let enterpriseSupportContext: () => Promise<{ readiness: EnterpriseReadinessReport; secrets: string[] }> = async () => ({
  readiness: {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overall: "warn",
    checks: [{ id: "readiness", status: "warn", code: "readiness_unavailable", message: "Readiness unavailable" }],
  },
  secrets: [],
})
export const getLogger = () => logger

export function configureEnterpriseSupport(
  context: () => Promise<{ readiness: EnterpriseReadinessReport; secrets: string[] }>,
) {
  enterpriseSupportContext = context
}

export function initLogging(input: { persistent?: boolean } = {}) {
  if (input.persistent !== false) {
    initRunDirectory()
    log.transports.file.maxSize = 5 * 1024 * 1024
    log.transports.file.resolvePathFn = (_vars, message) =>
      join(
        run,
        `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
      )
  } else {
    root = ""
    run = ""
    log.transports.file.level = false
  }
  log.initialize({ preload: false, spyRendererConsole: true })
  if (ENTERPRISE_ENABLED && !enterpriseHookInstalled) {
    enterpriseHookInstalled = true
    log.hooks.push((message, _transport, transportName) => {
      if (transportName !== "file") return message
      const secrets = Object.values(process.env).filter((value): value is string => typeof value === "string")
      if (Date.now() - lastEnterpriseCleanup >= 10_000) {
        lastEnterpriseCleanup = Date.now()
        cleanup()
      }
      return {
        ...message,
        scope: "enterprise-support",
        data: message.data.map((item) => sanitizeEnterpriseLogItem(item, secrets)),
      }
    })
  }
  initConsoleTransport()
  if (input.persistent !== false) cleanup()
  return (logger = log)
}

export function initCrashReporter() {
  const dir = join(app.getPath("userData"), "Crashpad")
  mkdirSync(dir, { recursive: true })
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
}

export async function startNetLog() {
  if (netLog.currentlyLogging) return
  netLogPath = join(run, "network.netlog")
  await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: NET_LOG_SIZE })
  write("network", "net log started", { path: netLogPath })
}

export async function exportDebugLogs() {
  if (ENTERPRISE_ENABLED) return exportEnterpriseSupportBundle()
  const restartNetLog = netLog.currentlyLogging
  if (restartNetLog) {
    await netLog.stopLogging().catch((error) => write("network", "failed to stop net log", { error }))
  }

  const output = join(app.getPath("downloads"), `opencode-debug-${stamp()}.zip`)
  try {
    write("main", "exporting debug logs", { output })
    await writeZip(output, [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest(), null, 2)) },
      ...collect(root, "desktop"),
      ...serverLogRoots().flatMap((dir, i) => collect(dir, `server-${i + 1}`)),
      ...collect(app.getPath("crashDumps"), "crashpad"),
    ])
    shell.showItemInFolder(output)
    return output
  } finally {
    if (restartNetLog) {
      await startNetLog().catch((error) => write("network", "failed to restart net log", { error }))
    }
  }
}

async function exportEnterpriseSupportBundle() {
  const context = await enterpriseSupportContext()
  const secrets = [
    ...context.secrets,
    ...Object.values(process.env).filter((value): value is string => typeof value === "string"),
  ]
  const logs = (root ? collect(root, "logs") : [])
    .filter((entry) => entry.path?.endsWith("enterprise-support.log"))
    .map((entry) => ({
      name: entry.name,
      data: Buffer.from(redactEnterpriseSupportText(readFileSync(entry.path!, "utf8"), secrets)),
    }))
  const files = ["manifest.json", ...logs.map((entry) => entry.name)]
  const preview = await dialog.showMessageBox({
    type: "info",
    buttons: ["Save support ZIP", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Review enterprise support bundle",
    detail: `Only the following redacted files will be included:\n\n${files.join("\n")}`,
    noLink: true,
  })
  if (preview.response !== 0) throw new Error("Support bundle export canceled")
  const selected = await dialog.showSaveDialog({
    title: "Save enterprise support bundle",
    defaultPath: join(app.getPath("downloads"), `enterprise-support-${stamp()}.zip`),
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  })
  if (selected.canceled || !selected.filePath) throw new Error("Support bundle export canceled")
  const manifest = createEnterpriseSupportManifest({
    appVersion: app.getVersion(),
    osBuild: `${process.platform} ${release()} ${process.arch}`,
    generatedAt: new Date().toISOString(),
    readiness: context.readiness,
    files,
  })
  await writeZip(selected.filePath, [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    ...logs,
  ])
  shell.showItemInFolder(selected.filePath)
  return selected.filePath
}

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!run) return
  const scoped = log.scope(ENTERPRISE_ENABLED ? "enterprise-support" : safeLogName(name))
  if (extra !== undefined) {
    scoped[level](
      message,
      ENTERPRISE_ENABLED
        ? redactEnterpriseSupportMetadata(
            extra,
            Object.values(process.env).filter((value): value is string => typeof value === "string"),
          )
        : extra,
    )
    return
  }
  scoped[level](message)
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function initRunDirectory() {
  root = join(app.getPath("userData"), "logs")
  run = join(root, stamp())
  mkdirSync(run, { recursive: true })
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (info.mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    } catch {
      continue
    }
  }
  if (!ENTERPRISE_ENABLED) return
  const files = collectAllFiles(dir).sort((a, b) => a.mtimeMs - b.mtimeMs)
  const total = files.reduce((size, file) => size + file.size, 0)
  files
    .reduce(
      (state, file) => {
        if (state.size <= MAX_LOG_TOTAL_SIZE) return state
        rmSync(file.path, { force: true })
        return { size: state.size - file.size }
      },
      { size: total },
    )
}

function collectAllFiles(dir: string): { path: string; size: number; mtimeMs: number }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    try {
      const info = statSync(path)
      if (info.isDirectory()) return collectAllFiles(path)
      return [{ path, size: info.size, mtimeMs: info.mtimeMs }]
    } catch {
      return []
    }
  })
}

function manifest() {
  return {
    generated: new Date().toISOString(),
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
    userData: app.getPath("userData"),
    logs: root,
    currentRun: run,
    crashDumps: app.getPath("crashDumps"),
    serverLogs: serverLogRoots(),
    netLog: netLogPath,
  }
}

function serverLogRoots() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return [...new Set([join(xdgData, "opencode", "log"), join(app.getPath("userData"), "opencode", "log")])]
}

type Entry = { name: string; path?: string; data?: Buffer }

function collect(dir: string, prefix: string): Entry[] {
  if (!existsSync(dir)) return []
  const cutoff = Date.now() - EXPORT_WINDOW
  const result: Entry[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const file = join(current, entry)
      const info = statSync(file)
      if (info.isDirectory()) {
        walk(file)
        continue
      }
      if (info.mtimeMs < cutoff) continue
      if (info.size > MAX_EXPORT_FILE_SIZE) continue
      if (file.endsWith(".heapsnapshot")) continue
      result.push({ name: join(prefix, file.slice(dir.length + 1)).replace(/\\/g, "/"), path: file })
    }
  }
  walk(dir)
  return result
}

async function writeZip(output: string, entries: Entry[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    const data = entry.data ?? readFileSync(entry.path!)
    await writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(data)])))
  }
  const zip = await writer.close()
  writeFileSync(output, Buffer.from(await zip.arrayBuffer()))
}

function initConsoleTransport() {
  const write = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      log.transports.console.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}

function sanitizeEnterpriseLogItem(item: unknown, secrets: string[]) {
  if (typeof item === "string") return redactEnterpriseSupportText(item, secrets)
  try {
    return redactEnterpriseSupportMetadata({ value: item }, secrets).value
  } catch {
    return "[REDACTED]"
  }
}
