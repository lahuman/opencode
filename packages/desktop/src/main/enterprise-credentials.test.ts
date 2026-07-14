import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEnterpriseCredentialStore } from "./enterprise-credentials"

const dirs: string[] = []

function encryptPadded(value: string) {
  const payload = Buffer.from(value, "utf8")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  return Buffer.concat([length, payload, Buffer.alloc(4 * 1024 * 1024)])
}

function decryptPadded(value: Buffer) {
  return value.subarray(4, 4 + value.readUInt32BE(0)).toString("utf8")
}

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
    const file = join(dir, "credentials.bin")
    const encrypted: string[] = []
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => false,
      encrypt: (value) => {
        encrypted.push(value)
        return Buffer.from(value)
      },
      decrypt: (value) => value.toString("utf8"),
    })

    await expect(store.set({ apiKey: "secret", headers: {} })).rejects.toThrow("secure storage is unavailable")
    expect(encrypted).toEqual([])
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })

  test("propagates filesystem read failures other than a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const store = createEnterpriseCredentialStore({
      file: dir,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })

    await expect(store.get()).rejects.toThrow()
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

  test("serializes overlapping sets into a complete final record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: encryptPadded,
      decrypt: decryptPadded,
    })

    await Promise.all([
      store.set({ apiKey: "first", headers: { token: "first-header" } }),
      store.set({ apiKey: "second", headers: { token: "second-header" } }),
    ])

    expect(await store.get()).toEqual({ apiKey: "second", headers: { token: "second-header" } })
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })

  test("serializes clear after a pending set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: encryptPadded,
      decrypt: decryptPadded,
    })

    await Promise.all([store.set({ apiKey: "secret", headers: {} }), store.clear()])

    expect(await store.get()).toEqual({ headers: {} })
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })

  test("removes the temp file after a failed rename and permits later mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await mkdir(file)
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
    })

    await expect(store.set({ apiKey: "secret", headers: {} })).rejects.toThrow()
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)

    await rm(file, { recursive: true })
    await store.set({ apiKey: "recovered", headers: {} })
    expect(await store.get()).toEqual({ apiKey: "recovered", headers: {} })
  })

  test("clear removes credentials and a stale temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
    })

    await store.set({ apiKey: "secret", headers: {} })
    await Bun.write(`${file}.tmp`, "stale-encrypted")
    await store.clear()
    expect(await store.get()).toEqual({ headers: {} })
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })
})
