import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEnterpriseCredentialHandlers, createEnterpriseCredentialStore } from "./enterprise-credentials"
import type { EnterpriseCredentials } from "./enterprise-credentials"

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
    const decrypted = ["not json", "null", "[]", JSON.stringify({ apiKey: 123, headers: ["secret-header"] })]
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: () => decrypted.shift() ?? "{}",
    })

    const results = await Promise.all(decrypted.map(() => store.get()))
    expect(results).toEqual([{ headers: {} }, { headers: {} }, { headers: {} }, { headers: {} }])
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
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: Buffer[] = []
    const credentials = [
      { apiKey: "first", headers: { token: "first-header" } },
      { apiKey: "second", headers: { token: "second-header" } },
    ]
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
      decrypt: (value) => value.toString("utf8").split("").reverse().join(""),
      write: async (path, value) => {
        writes.push(value)
        if (writes.length === 1) {
          entered.resolve()
          await release.promise
        }
        await writeFile(path, value, { mode: 0o600 })
      },
    })

    const first = store.set(credentials[0])
    expect(await Promise.race([entered.promise.then(() => true), first.then(() => false)])).toBe(true)
    const second = store.set(credentials[1])
    await Promise.resolve()
    expect(writes).toHaveLength(1)

    release.resolve()
    await Promise.all([first, second])

    expect(writes.map((value) => value.toString("utf8").split("").reverse().join(""))).toEqual(
      credentials.map((value) => JSON.stringify(value)),
    )
    expect(await store.get()).toEqual(credentials[1])
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })

  test("serializes clear after a pending set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
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

  test("credential handlers preserve omitted values and return no secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })
    const handlers = createEnterpriseCredentialHandlers(true, store)
    await store.set({ apiKey: "original-key", headers: { "X-Original": "original-header" } })

    const apiKeyResult = await handlers.set({ apiKey: "replacement-key" })
    expect(apiKeyResult).toEqual({ restartRequired: true })
    expect(JSON.stringify(apiKeyResult)).not.toContain("replacement-key")
    expect(await store.get()).toEqual({
      apiKey: "replacement-key",
      headers: { "X-Original": "original-header" },
    })

    const headerResult = await handlers.set({ headers: { "X-Replacement": "replacement-header" } })
    expect(headerResult).toEqual({ restartRequired: true })
    expect(JSON.stringify(headerResult)).not.toContain("replacement-header")
    expect(await store.get()).toEqual({
      apiKey: "replacement-key",
      headers: { "X-Replacement": "replacement-header" },
    })

    await handlers.set({ headers: {} })
    expect(await store.get()).toEqual({
      apiKey: "replacement-key",
      headers: { "X-Replacement": "replacement-header" },
    })
  })

  test("credential handlers atomically merge concurrent partial updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    await writeFile(file, JSON.stringify({ headers: {} }), { mode: 0o600 })
    const writeEntered = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const secondStaleRead = Promise.withResolvers<void>()
    const secondAtomicUpdate = Promise.withResolvers<void>()
    let decryptions = 0
    let writes = 0
    let updates = 0
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => {
        decryptions++
        if (decryptions === 2) secondStaleRead.resolve()
        return value.toString("utf8")
      },
      write: async (path, value) => {
        writes++
        if (writes === 1) {
          writeEntered.resolve()
          await releaseWrite.promise
        }
        await writeFile(path, value, { mode: 0o600 })
      },
    })
    const trackedStore = {
      ...store,
      update: (transform: (current: EnterpriseCredentials) => EnterpriseCredentials) => {
        updates++
        if (updates === 2) secondAtomicUpdate.resolve()
        return (
          store as typeof store & {
            update: (transform: (current: EnterpriseCredentials) => EnterpriseCredentials) => Promise<void>
          }
        ).update(transform)
      },
    }
    const handlers = createEnterpriseCredentialHandlers(true, trackedStore)

    const apiKeyUpdate = handlers.set({ apiKey: "replacement-key" })
    await writeEntered.promise
    const headersUpdate = handlers.set({ headers: { Authorization: "replacement-header" } })
    await Promise.race([secondStaleRead.promise, secondAtomicUpdate.promise])
    releaseWrite.resolve()
    await Promise.all([apiKeyUpdate, headersUpdate])

    expect(await store.get()).toEqual({
      apiKey: "replacement-key",
      headers: { Authorization: "replacement-header" },
    })
    expect(updates).toBe(2)
  })

  test("credential clear is ordered after a pending partial update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const writeEntered = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
      write: async (path, value) => {
        writeEntered.resolve()
        await releaseWrite.promise
        await writeFile(path, value, { mode: 0o600 })
      },
    })
    const handlers = createEnterpriseCredentialHandlers(true, store)

    const update = handlers.set({ apiKey: "secret-key" })
    await writeEntered.promise
    const clear = handlers.clear()
    releaseWrite.resolve()
    await Promise.all([update, clear])

    expect(await store.get()).toEqual({ headers: {} })
    expect(await Bun.file(file).exists()).toBe(false)
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  })

  test("credential handlers expose status and explicit clear without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })
    const handlers = createEnterpriseCredentialHandlers(true, store)
    await store.set({ apiKey: "secret-key", headers: { Authorization: "secret-header" } })

    const status = await handlers.status()
    expect(status).toEqual({ configured: true })
    expect(JSON.stringify(status)).not.toContain("secret")
    expect(await handlers.clear()).toEqual({ restartRequired: true })
    expect(await store.get()).toEqual({ headers: {} })
    expect(await handlers.status()).toEqual({ configured: false })
  })

  test("credential handlers are disabled no-ops in ordinary builds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enterprise-credentials-"))
    dirs.push(dir)
    const file = join(dir, "credentials.bin")
    const store = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })
    const handlers = createEnterpriseCredentialHandlers(false, store)

    expect(await handlers.status()).toEqual({ configured: false })
    expect(await handlers.set({ apiKey: "secret-key" })).toEqual({ restartRequired: true })
    expect(await handlers.clear()).toEqual({ restartRequired: true })
    expect(await Bun.file(file).exists()).toBe(false)
  })
})
