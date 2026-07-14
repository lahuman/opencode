import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type EnterpriseCredentials = {
  apiKey?: string
  headers: Record<string, string>
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
            Object.entries(record.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {}
    return { ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}), headers }
  }

  const set = (credentials: EnterpriseCredentials) =>
    mutate(async () => {
      if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
      await write(temp, input.encrypt(JSON.stringify(credentials)))
        .then(() => rename(temp, input.file))
        .finally(() => rm(temp, { force: true }))
    })

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

  return { get, set, clear }
}
