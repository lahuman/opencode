import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEnterpriseCredentialStore } from "./enterprise-credentials"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("enterprise credential store", () => {
  test("persists only encrypted bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
      decrypt: (value) => value.toString("utf8").split("").reverse().join(""),
    })

    await store.set({ apiKey: "secret-key", headers: { "X-Company-Token": "secret-header" } })
    const raw = await readFile(file, "utf8")
    expect(raw).not.toContain("secret-key")
    expect(raw).not.toContain("secret-header")
    expect(await store.get()).toEqual({ apiKey: "secret-key", headers: { "X-Company-Token": "secret-header" } })
  })

  test("refuses plaintext fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const store = createEnterpriseCredentialStore({
      file: join(dir, "credentials.bin"),
      encryptionAvailable: () => false,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })

    await expect(store.set({ apiKey: "secret", headers: {} })).rejects.toThrow("secure storage is unavailable")
  })

  test("treats an unreadable encrypted blob as unconfigured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await Bun.write(file, "corrupt")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: () => {
        throw new Error("DPAPI decrypt failed")
      },
    })

    expect(await store.get()).toEqual({ headers: {} })
  })

  test("treats invalid decrypted content as unconfigured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await Bun.write(file, "encrypted")
    const decrypted = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ apiKey: 123, headers: ["secret-header"] }),
    ]
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: () => decrypted.shift() ?? "{}",
    })

    const results = await Promise.all(decrypted.map(() => store.get()))
    expect(results).toEqual([
      { headers: {} },
      { headers: {} },
      { headers: {} },
      { headers: {} },
    ])
  })

  test("keeps only string credential values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await Bun.write(file, "encrypted")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: () => JSON.stringify({ apiKey: false, headers: { valid: "secret", invalid: 123 } }),
    })

    expect(await store.get()).toEqual({ headers: { valid: "secret" } })
  })

  test("clear removes all credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const store = createEnterpriseCredentialStore({
      file: join(dir, "credentials.bin"),
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
    })

    await store.set({ apiKey: "secret", headers: {} })
    await store.clear()
    expect(await store.get()).toEqual({ headers: {} })
  })
})
