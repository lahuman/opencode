import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { isEnterpriseCertificatePathLocal, stageEnterpriseCertificate } from "./enterprise-certificate"

const invalidCertificate = "CSC_LINK must reference an existing readable local PFX certificate file"
const stagingFailed = "Enterprise certificate staging failed"
const cleanupFailed = "Enterprise certificate cleanup failed"

test("rejects Windows UNC, device, rooted, and drive-relative certificate paths", () => {
  for (const source of [
    String.raw`\\server\share\certificate.pfx`,
    String.raw`\\?\C:\certificate.pfx`,
    String.raw`\\.\C:\certificate.pfx`,
    String.raw`\certificate.pfx`,
    String.raw`C:certificate.pfx`,
  ]) {
    expect(isEnterpriseCertificatePathLocal(source, "win32")).toBeFalse()
  }

  expect(isEnterpriseCertificatePathLocal(String.raw`C:\certificates\certificate.pfx`, "win32")).toBeTrue()
})

test("rejects certificate files and parent directories reached through symlinks", async () => {
  await withCertificate(async (certificate, directory) => {
    const linkedFile = path.join(directory, "linked-certificate.pfx")
    await symlink(certificate, linkedFile)
    expect(await stageError(linkedFile)).toBe(invalidCertificate)

    const linkedDirectory = path.join(path.dirname(directory), `${path.basename(directory)}-link`)
    await symlink(directory, linkedDirectory)
    try {
      expect(await stageError(path.join(linkedDirectory, path.basename(certificate)))).toBe(invalidCertificate)
    } finally {
      await rm(linkedDirectory, { force: true })
    }
  })
})

test("retries transient cleanup failures before clearing owned signing state", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const state = { attempts: 0 }
    const staged = await stageEnterpriseCertificate(env, {
      async remove(target, options) {
        state.attempts++
        if (state.attempts < 3) throw filesystemError("EPERM")
        await rm(target, options)
      },
      wait: () => Promise.resolve(),
    })

    await staged.cleanup()

    expect(state.attempts).toBe(3)
    expect(env.CSC_LINK).toBeUndefined()
    expect(env.CSC_KEY_PASSWORD).toBeUndefined()
    expect(await Bun.file(staged.cscLink).exists()).toBeFalse()
  })
})

test("keeps cleanup retryable and state owned after persistent transient failures", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const state = { attempts: 0, failing: true }
    const staged = await stageEnterpriseCertificate(env, {
      async remove(target, options) {
        state.attempts++
        if (state.failing) throw filesystemError("EBUSY")
        await rm(target, options)
      },
      wait: () => Promise.resolve(),
    })

    await expect(staged.cleanup()).rejects.toThrow(cleanupFailed)
    expect(state.attempts).toBe(3)
    expect(env.CSC_LINK).toBe(staged.cscLink)
    expect(env.CSC_KEY_PASSWORD).toBe("operator-password")
    expect(await Bun.file(staged.cscLink).exists()).toBeTrue()

    state.failing = false
    await staged.cleanup()
    expect(state.attempts).toBe(4)
    expect(env.CSC_LINK).toBeUndefined()
    expect(env.CSC_KEY_PASSWORD).toBeUndefined()
  })
})

test("retries synchronous transient exit cleanup before releasing ownership", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const lifecycle = createLifecycle()
    const state = { attempts: 0 }
    const staged = await stageEnterpriseCertificate(env, {
      lifecycle,
      removeSync(target, options) {
        state.attempts++
        if (state.attempts < 3) throw filesystemError("EPERM")
        rmSync(target, options)
      },
      waitSync: () => undefined,
    })

    try {
      lifecycle.emit("exit")

      expect(state.attempts).toBe(3)
      expect(lifecycle.size).toBe(0)
      expect(env.CSC_LINK).toBeUndefined()
      expect(env.CSC_KEY_PASSWORD).toBeUndefined()
      expect(await Bun.file(staged.cscLink).exists()).toBeFalse()
    } finally {
      await staged.cleanup().catch(() => undefined)
    }
  })
})

test("keeps synchronous exit cleanup owned and retryable after persistent failures", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const lifecycle = createLifecycle()
    const state = { attempts: 0, failing: true }
    const staged = await stageEnterpriseCertificate(env, {
      lifecycle,
      removeSync(target, options) {
        state.attempts++
        if (state.failing) throw filesystemError("EBUSY")
        rmSync(target, options)
      },
      waitSync: () => undefined,
    })

    try {
      lifecycle.emit("exit")
      expect(state.attempts).toBe(3)
      expect(lifecycle.size).toBe(3)
      expect(env.CSC_LINK).toBe(staged.cscLink)
      expect(await Bun.file(staged.cscLink).exists()).toBeTrue()
      expect((await captureStage(signingEnv(certificate))).error).toBe(
        "Enterprise certificate staging is already active",
      )

      state.failing = false
      lifecycle.emit("exit")
      expect(state.attempts).toBe(4)
      expect(lifecycle.size).toBe(0)
      expect(env.CSC_LINK).toBeUndefined()
      expect(await Bun.file(staged.cscLink).exists()).toBeFalse()
    } finally {
      state.failing = false
      await staged.cleanup().catch(() => undefined)
    }
  })
})

test("cleans a partial staging write with transient removal retries before releasing ownership", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const lifecycle = createLifecycle()
    const state = { attempts: 0 }
    let partial = ""
    const result = await captureStage(env, {
      lifecycle,
      async remove(target, options) {
        state.attempts++
        if (state.attempts < 3) throw filesystemError("EPERM")
        await rm(target, options)
      },
      wait: () => Promise.resolve(),
      async writeCertificate(target, contents) {
        partial = target
        expect(lifecycle.size).toBe(3)
        expect(env.CSC_LINK).toBe(target)
        await writeFile(target, contents.subarray(0, 1), { flag: "wx", mode: 0o600 })
        throw new Error("injected partial write failure")
      },
    })

    try {
      expect(result.error).toBe(stagingFailed)
      expect(state.attempts).toBe(3)
      expect(lifecycle.size).toBe(0)
      expect(env.CSC_LINK).toBe(certificate)
      expect(env.CSC_KEY_PASSWORD).toBe("operator-password")
      expect(await Bun.file(partial).exists()).toBeFalse()
    } finally {
      await result.stage?.cleanup().catch(() => undefined)
    }
  })
})

test("retains partial-write cleanup ownership until persistent removal later succeeds", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const lifecycle = createLifecycle()
    const state = { attempts: 0, failing: true }
    let partial = ""
    const result = await captureStage(env, {
      lifecycle,
      async remove(target, options) {
        state.attempts++
        if (state.failing) throw filesystemError("EBUSY")
        await rm(target, options)
      },
      removeSync(target, options) {
        if (state.failing) throw filesystemError("EBUSY")
        rmSync(target, options)
      },
      wait: () => Promise.resolve(),
      waitSync: () => undefined,
      async writeCertificate(target, contents) {
        partial = target
        await writeFile(target, contents.subarray(0, 1), { flag: "wx", mode: 0o600 })
        throw new Error("injected partial write failure")
      },
    })

    try {
      expect(result.error).toBe(stagingFailed)
      expect(state.attempts).toBe(3)
      expect(lifecycle.size).toBe(3)
      expect(env.CSC_LINK).toBe(partial)
      expect(await Bun.file(partial).exists()).toBeTrue()
      expect((await captureStage(signingEnv(certificate))).error).toBe(
        "Enterprise certificate staging is already active",
      )

      state.failing = false
      lifecycle.emit("exit")
      expect(lifecycle.size).toBe(0)
      expect(env.CSC_LINK).toBe(certificate)
      expect(env.CSC_KEY_PASSWORD).toBe("operator-password")
      expect(await Bun.file(partial).exists()).toBeFalse()
    } finally {
      state.failing = false
      lifecycle.emit("exit")
      await result.stage?.cleanup().catch(() => undefined)
    }
  })
})

test("uses runtime-neutral cleanup defaults when loaded by electron-builder under Node", () => {
  const result = Bun.spawnSync(["node", "test/enterprise-certificate-node-entrypoint.cjs"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      USERPROFILE: process.env.USERPROFILE,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)

  expect(result.exitCode).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ attempts: 2, cleaned: true })
})

test("does not retry non-transient cleanup failures and remains retryable", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const state = { attempts: 0, failing: true }
    const staged = await stageEnterpriseCertificate(env, {
      async remove(target, options) {
        state.attempts++
        if (state.failing) throw filesystemError("EACCES")
        await rm(target, options)
      },
      wait: () => Promise.resolve(),
    })

    await expect(staged.cleanup()).rejects.toThrow(cleanupFailed)
    expect(state.attempts).toBe(1)
    expect(env.CSC_LINK).toBe(staged.cscLink)

    state.failing = false
    await staged.cleanup()
    expect(state.attempts).toBe(2)
  })
})

test("cleanup never clears signing state it no longer owns", async () => {
  await withCertificate(async (certificate) => {
    const env = signingEnv(certificate)
    const staged = await stageEnterpriseCertificate(env)
    env.CSC_LINK = "replacement-link"
    env.CSC_KEY_PASSWORD = "replacement-password"

    await staged.cleanup()

    expect(env.CSC_LINK).toBe("replacement-link")
    expect(env.CSC_KEY_PASSWORD).toBe("replacement-password")
  })
})

test("rejects overlapping stages until confirmed cleanup releases ownership", async () => {
  await withCertificate(async (first) => {
    await withCertificate(async (second) => {
      const staged = await stageEnterpriseCertificate(signingEnv(first))
      const overlapping = await captureStage(signingEnv(second))

      expect(overlapping.error).toBe("Enterprise certificate staging is already active")
      expect(overlapping.stage).toBeUndefined()

      await staged.cleanup()
      const next = await stageEnterpriseCertificate(signingEnv(second))
      await next.cleanup()
    })
  })
})

function signingEnv(certificate: string) {
  return { CSC_LINK: certificate, CSC_KEY_PASSWORD: "operator-password" }
}

async function stageError(certificate: string) {
  const result = await captureStage(signingEnv(certificate))
  if (result.stage) await result.stage.cleanup()
  return result.error
}

async function captureStage(
  env: Record<string, string | undefined>,
  dependencies?: Parameters<typeof stageEnterpriseCertificate>[1],
) {
  try {
    return { stage: await stageEnterpriseCertificate(env, dependencies), error: undefined }
  } catch (error) {
    return { stage: undefined, error: error instanceof Error ? error.message : undefined }
  }
}

function createLifecycle() {
  type Event = "exit" | "SIGINT" | "SIGTERM"
  const listeners = new Map<Event, () => void>()
  return {
    on(event: Event, listener: () => void) {
      listeners.set(event, listener)
    },
    off(event: Event, listener: () => void) {
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    exit(code: number): never {
      throw new Error(`Unexpected injected exit ${code}`)
    },
    emit(event: Event) {
      listeners.get(event)?.()
    },
    get size() {
      return listeners.size
    },
  }
}

function filesystemError(code: string) {
  return Object.assign(new Error("injected deletion failure"), { code })
}

async function withCertificate<T>(run: (certificate: string, directory: string) => T | Promise<T>) {
  const directory = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "enterprise-certificate-")))
  const certificate = path.join(directory, "source.pfx")
  await Bun.write(certificate, "certificate contents")
  try {
    return await run(certificate, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
