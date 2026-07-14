import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type EnterpriseCredentials = {
  apiKey?: string
  headers: Record<string, string>
}

type Store = ReturnType<typeof createEnterpriseCredentialStore>

export function enterpriseSidecarEnvironment(): Record<string, string> {
  return {
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  }
}

export function createEnterpriseCredentialHandlers(enabled: boolean, store: Store) {
  const status = async () => {
    if (!enabled) return { configured: false }
    const credentials = await store.get()
    return { configured: Boolean(credentials.apiKey || Object.keys(credentials.headers).length) }
  }

  const set = async (input: { apiKey?: string; headers?: Record<string, string> }) => {
    if (!enabled) return { restartRequired: true as const }
    await store.update((current) => ({
      apiKey: input.apiKey === undefined ? current.apiKey : input.apiKey,
      headers: input.headers && Object.keys(input.headers).length ? input.headers : current.headers,
    }))
    return { restartRequired: true as const }
  }

  const clear = async () => {
    if (enabled) await store.clear()
    return { restartRequired: true as const }
  }

  return { status, set, clear }
}

type Input = {
  file: string
  encryptionAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
  write?: (file: string, value: Buffer) => Promise<void>
}

export function createEnterpriseCredentialStore(input: Input) {
  const temp = `${input.file}.tmp`
  const write =
    input.write ??
    (async (file: string, value: Buffer) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, value, { mode: 0o600 })
    })
  let mutations = Promise.resolve()

  const mutate = (operation: () => Promise<void>) => {
    const result = mutations.then(operation)
    mutations = result.catch(() => undefined)
    return result
  }

  const get = async (): Promise<EnterpriseCredentials> => {
    const encrypted = await readFile(input.file).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!encrypted) return { headers: {} }

    const value: unknown = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (!value || typeof value !== "object" || Array.isArray(value)) return { headers: {} }

    const record = value as Record<string, unknown>
    const headers =
      record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
        ? Object.fromEntries(
            Object.entries(record.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {}
    return { ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}), headers }
  }

  const persist = async (credentials: EnterpriseCredentials) => {
    if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
    await write(temp, input.encrypt(JSON.stringify(credentials)))
      .then(() => rename(temp, input.file))
      .finally(() => rm(temp, { force: true }))
  }

  const set = (credentials: EnterpriseCredentials) => mutate(() => persist(credentials))

  const update = (transform: (current: EnterpriseCredentials) => EnterpriseCredentials) =>
    mutate(async () => persist(transform(await get())))

  const clear = () =>
    mutate(async () => {
      const errors: unknown[] = []
      await Promise.all(
        [input.file, temp].map((file) =>
          rm(file, { force: true }).catch((error: unknown) => {
            errors.push(error)
          }),
        ),
      )
      if (errors.length) throw errors[0]
    })

  return { get, set, update, clear }
}
