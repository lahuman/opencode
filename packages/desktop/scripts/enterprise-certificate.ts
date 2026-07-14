import { constants, rmSync } from "node:fs"
import { access, chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BeforePackContext } from "electron-builder"

type Env = Record<string, string | undefined>

const invalidCertificate = "CSC_LINK must reference an existing readable local PFX certificate file"
const stagingFailed = "Enterprise certificate staging failed"

export async function stageEnterpriseCertificate(env: Env) {
  const source = env.CSC_LINK?.trim()
  if (!source || !path.isAbsolute(source) || path.extname(source).toLowerCase() !== ".pfx") {
    throw new Error(invalidCertificate)
  }

  const readable = await access(source, constants.R_OK).then(
    () => true,
    () => false,
  )
  const file = await stat(source).then(
    (value) => value.isFile(),
    () => false,
  )
  if (!readable || !file) throw new Error(invalidCertificate)

  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-enterprise-signing-")).catch(() => {
    throw new Error(stagingFailed)
  })
  const certificate = path.join(directory, "certificate.pfx")
  try {
    if (process.platform !== "win32") await chmod(directory, 0o700)
    await copyFile(source, certificate)
    if (process.platform !== "win32") await chmod(certificate, 0o600)
  } catch {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(stagingFailed)
  }

  const state = { cleaned: false, registered: false }
  const cleanup = () => {
    if (state.cleaned) return
    state.cleaned = true
    process.off("exit", cleanup)
    if (env.CSC_LINK === certificate) delete env.CSC_LINK
    delete env.CSC_KEY_PASSWORD
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Process-exit cleanup cannot recover or report without risking path disclosure.
    }
  }
  process.once("exit", cleanup)
  env.CSC_LINK = certificate

  return {
    cleanup: () => Promise.resolve(cleanup()),
    beforePack: (context: BeforePackContext) => {
      if (state.registered) return
      state.registered = true
      context.packager.info.disposeOnBuildFinish(() => Promise.resolve(cleanup()))
    },
  }
}
