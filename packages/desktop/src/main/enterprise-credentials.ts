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
}

export function createEnterpriseCredentialStore(input: Input) {
  const get = async (): Promise<EnterpriseCredentials> => {
    const encrypted = await readFile(input.file).catch(() => undefined)
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

  const set = async (credentials: EnterpriseCredentials) => {
    if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
    await mkdir(dirname(input.file), { recursive: true })
    const temp = `${input.file}.tmp`
    await writeFile(temp, input.encrypt(JSON.stringify(credentials)), { mode: 0o600 })
    await rename(temp, input.file)
  }

  const clear = () => rm(input.file, { force: true })

  return { get, set, clear }
}
