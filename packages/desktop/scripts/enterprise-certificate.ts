import { constants, rmSync } from "node:fs"
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BeforePackContext, Configuration } from "electron-builder"

type Env = Record<string, string | undefined>
type RemoveOptions = { recursive: true; force: true }
type LifecycleEvent = "exit" | "SIGINT" | "SIGTERM"
type Lifecycle = {
  on: (event: LifecycleEvent, listener: () => void) => void
  off: (event: LifecycleEvent, listener: () => void) => void
  exit: (code: number) => never
}
type StageDependencies = {
  remove?: (target: string, options: RemoveOptions) => Promise<void>
  removeSync?: (target: string, options: RemoveOptions) => void
  wait?: (milliseconds: number) => Promise<void>
  waitSync?: (milliseconds: number) => void
  writeCertificate?: (target: string, contents: Uint8Array) => Promise<void>
  lifecycle?: Lifecycle
}

const invalidCertificate = "CSC_LINK must reference an existing readable local PFX certificate file"
const stagingFailed = "Enterprise certificate staging failed"
const cleanupFailed = "Enterprise certificate cleanup failed"
const stageActive = "Enterprise certificate staging is already active"
const invalidSigningConfiguration = "Enterprise signing configuration is invalid"
const removeOptions = { recursive: true, force: true } as const
const syncWaitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
const processLifecycle: Lifecycle = {
  on: (event, listener) => process.on(event, listener),
  off: (event, listener) => process.off(event, listener),
  exit: (code) => process.exit(code),
}

let activeStage: symbol | undefined

export async function stageEnterpriseCertificate(env: Env, dependencies: StageDependencies = {}) {
  const source = env.CSC_LINK?.trim()
  if (!source || !isEnterpriseCertificatePathLocal(source) || path.extname(source).toLowerCase() !== ".pfx") {
    throw new Error(invalidCertificate)
  }
  if (activeStage) throw new Error(stageActive)

  const token = Symbol("enterprise-certificate-stage")
  activeStage = token
  const contents = await readCertificate(source).catch(() => {
    releaseStage(token)
    throw new Error(invalidCertificate)
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-enterprise-signing-")).catch(() => {
    releaseStage(token)
    throw new Error(stagingFailed)
  })
  const certificate = path.join(directory, "certificate.pfx")
  const password = env.CSC_KEY_PASSWORD
  const remove = dependencies.remove ?? ((target, options) => rm(target, options))
  const removeSyncStage = dependencies.removeSync ?? ((target, options) => rmSync(target, options))
  const wait =
    dependencies.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const waitSync = dependencies.waitSync ?? ((milliseconds) => Atomics.wait(syncWaitState, 0, 0, milliseconds))
  const writeCertificate =
    dependencies.writeCertificate ?? ((target, value) => writeFile(target, value, { flag: "wx", mode: 0o600 }))
  const lifecycle = dependencies.lifecycle ?? processLifecycle
  const state: { cleaned: boolean; registered: boolean; restoreSource: boolean; cleaning?: Promise<void> } = {
    cleaned: false,
    registered: false,
    restoreSource: true,
  }

  const finishCleanup = () => {
    if (state.cleaned) return
    const ownsEnvironment = activeStage === token && env.CSC_LINK === certificate
    if (ownsEnvironment) {
      if (state.restoreSource) env.CSC_LINK = source
      if (!state.restoreSource) {
        delete env.CSC_LINK
        if (env.CSC_KEY_PASSWORD === password) delete env.CSC_KEY_PASSWORD
      }
    }
    releaseStage(token)
    state.cleaned = true
    lifecycle.off("exit", onExit)
    lifecycle.off("SIGINT", onSigint)
    lifecycle.off("SIGTERM", onSigterm)
  }
  const cleanup = () => {
    if (state.cleaned) return Promise.resolve()
    if (state.cleaning) return state.cleaning
    const cleaning = removeWithRetry(remove, wait, directory)
      .then(finishCleanup)
      .catch(() => {
        state.cleaning = undefined
        throw new Error(cleanupFailed)
      })
    state.cleaning = cleaning
    return cleaning
  }
  const onExit = () => {
    if (state.cleaned) return
    try {
      removeWithRetrySync(removeSyncStage, waitSync, directory)
      finishCleanup()
    } catch {
      // Ownership and handlers remain active so another exit path can retry cleanup.
    }
  }
  const exitAfterCleanup = (code: number) => {
    void cleanup().then(
      () => lifecycle.exit(code),
      () => lifecycle.exit(1),
    )
  }
  const onSigint = () => exitAfterCleanup(130)
  const onSigterm = () => exitAfterCleanup(143)

  lifecycle.on("exit", onExit)
  lifecycle.on("SIGINT", onSigint)
  lifecycle.on("SIGTERM", onSigterm)
  env.CSC_LINK = certificate

  try {
    if (process.platform !== "win32") await chmod(directory, 0o700)
    await writeCertificate(certificate, contents)
    state.restoreSource = false
  } catch {
    await cleanup().catch(() => undefined)
    throw new Error(stagingFailed)
  }

  return {
    cleanup,
    cscLink: certificate,
    beforePack: (context: BeforePackContext) => {
      if (!state.registered) {
        state.registered = true
        context.packager.info.disposeOnBuildFinish(cleanup)
      }
      guardEnterpriseSigningConfiguration(context, certificate)
    },
  }
}

export function isEnterpriseCertificatePathLocal(source: string, platform = process.platform) {
  if (platform === "win32") {
    return /^[a-z]:[\\/]/i.test(source) && path.win32.isAbsolute(source) && !source.startsWith("\\\\")
  }
  return path.posix.isAbsolute(source) && !source.startsWith("//") && !/^[a-z]:[\\/]/i.test(source)
}

async function readCertificate(source: string) {
  const resolved = path.resolve(source)
  const canonical = await realpath(source)
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const normalizedCanonical = process.platform === "win32" ? canonical.toLowerCase() : canonical
  if (normalized !== normalizedCanonical) throw new Error(invalidCertificate)

  const root = path.parse(resolved).root
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean)
  const entries = await Promise.all(parts.map((_, index) => lstat(path.join(root, ...parts.slice(0, index + 1)))))
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(invalidCertificate)
  const expected = entries.at(-1)
  if (!expected?.isFile()) throw new Error(invalidCertificate)

  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(invalidCertificate)
    }
    const contents = await handle.readFile()
    const afterRead = await handle.stat()
    if (
      afterRead.size !== actual.size ||
      afterRead.mtimeMs !== actual.mtimeMs ||
      afterRead.ctimeMs !== actual.ctimeMs
    ) {
      throw new Error(invalidCertificate)
    }
    return contents
  } finally {
    await handle.close()
  }
}

async function removeWithRetry(
  remove: (target: string, options: RemoveOptions) => Promise<void>,
  wait: (milliseconds: number) => Promise<void>,
  directory: string,
  attempt = 1,
): Promise<void> {
  try {
    await remove(directory, removeOptions)
  } catch (error) {
    if (!isTransientRemovalError(error) || attempt >= 3) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- Native cleanup errors can disclose the staged path.
      throw new Error(cleanupFailed)
    }
    await wait(100)
    await removeWithRetry(remove, wait, directory, attempt + 1)
  }
}

function removeWithRetrySync(
  remove: (target: string, options: RemoveOptions) => void,
  wait: (milliseconds: number) => void,
  directory: string,
  attempt = 1,
): void {
  try {
    remove(directory, removeOptions)
  } catch (error) {
    if (!isTransientRemovalError(error) || attempt >= 3) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- Native cleanup errors can disclose the staged path.
      throw new Error(cleanupFailed)
    }
    wait(100)
    removeWithRetrySync(remove, wait, directory, attempt + 1)
  }
}

function isTransientRemovalError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === "EPERM" || error.code === "EBUSY"
}

function releaseStage(token: symbol) {
  if (activeStage === token) activeStage = undefined
}

function guardEnterpriseSigningConfiguration(context: BeforePackContext, certificate: string) {
  const config = context.packager.config
  const win = context.packager.platformSpecificBuildOptions
  if (!isWindowsConfiguration(win)) throw new Error(invalidSigningConfiguration)
  if (
    config.cscLink !== certificate ||
    config.cscKeyPassword != null ||
    win.cscLink !== certificate ||
    win.cscKeyPassword != null ||
    win.azureSignOptions != null ||
    win.signtoolOptions != null ||
    win.signExecutable === false ||
    win.signAndEditExecutable === false ||
    win.signExts != null ||
    win.forceCodeSigning !== true
  ) {
    throw new Error(invalidSigningConfiguration)
  }
}

function isWindowsConfiguration(value: unknown): value is NonNullable<Configuration["win"]> {
  return Boolean(value && typeof value === "object")
}
