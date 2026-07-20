import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type EnterpriseCredential = {
  apiKey?: string
  headers: Record<string, string>
}

export type EnterpriseCredentials = {
  schemaVersion: 2
  models: Record<string, EnterpriseCredential>
}

export type EnterpriseProviderCredentials = {
  schemaVersion: 3
  providers: Record<string, EnterpriseCredential>
}

export type EnterpriseLegacyProviderCredentials =
  | { kind: "v1"; credentials: EnterpriseCredential }
  | { kind: "v2"; credentials: EnterpriseCredentials }

export type EnterpriseCredentialCatalog = {
  defaultModelID: string
  models: {
    id: string
    name: string
    baseURL: string
    credentialStatus: {
      configured: boolean
      errorCode?: "credential_decryption_failed" | "credential_encryption_unavailable"
    }
  }[]
}

type Store = ReturnType<typeof createEnterpriseCredentialStore>

export function enterpriseSidecarEnvironment(): Record<string, string> {
  return {
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  }
}

export function createEnterpriseCredentialHandlers(
  enabled: boolean,
  store: Store,
  profile: { defaultModelID: string; models: { id: string; name: string; baseURL: string }[] } = {
    defaultModelID: store.defaultModelID,
    models: [],
  },
) {
  const status = async (modelID = store.defaultModelID) => {
    if (!enabled) return { configured: false }
    store.requireModel(modelID)
    const health = await store.health()
    if (health.state === "corrupt") return { configured: false, errorCode: "credential_decryption_failed" as const }
    if (health.state === "encryption-unavailable")
      return { configured: false, errorCode: "credential_encryption_unavailable" as const }
    const credentials = (await store.all()).models[modelID]
    return { configured: Boolean(credentials?.apiKey || Object.keys(credentials?.headers ?? {}).length) }
  }

  const set = async (input: { modelID?: string; apiKey?: string; headers?: Record<string, string> }) => {
    if (!enabled) return { restartRequired: true as const }
    const modelID = input.modelID ?? store.defaultModelID
    store.requireModel(modelID)
    await store.updateAll((current) => {
      const credentials = current.models[modelID] ?? { headers: {} }
      return {
        schemaVersion: 2,
        models: {
          ...current.models,
          [modelID]: {
            apiKey: input.apiKey === undefined ? credentials.apiKey : input.apiKey,
            headers: input.headers && Object.keys(input.headers).length ? input.headers : credentials.headers,
          },
        },
      }
    })
    return { restartRequired: true as const }
  }

  const clear = async (modelID?: string) => {
    if (!enabled) return { restartRequired: true as const }
    if (modelID === undefined) {
      await store.clear()
      return { restartRequired: true as const }
    }
    store.requireModel(modelID)
    await store.updateAll((current) => ({
      schemaVersion: 2,
      models: Object.fromEntries(Object.entries(current.models).filter(([id]) => id !== modelID)),
    }))
    return { restartRequired: true as const }
  }

  const catalog = async (): Promise<EnterpriseCredentialCatalog> => {
    if (!enabled) return { defaultModelID: "", models: [] }
    const health = await store.health()
    const credentials = health.state === "available" || health.state === "missing" ? await store.all() : undefined
    const errorCode =
      health.state === "corrupt"
        ? ("credential_decryption_failed" as const)
        : health.state === "encryption-unavailable"
          ? ("credential_encryption_unavailable" as const)
          : undefined
    return {
      defaultModelID: profile.defaultModelID,
      models: profile.models.map((model) => ({
        ...model,
        credentialStatus: {
          configured: Boolean(
            credentials?.models[model.id]?.apiKey || Object.keys(credentials?.models[model.id]?.headers ?? {}).length,
          ),
          ...(errorCode ? { errorCode } : {}),
        },
      })),
    }
  }

  return { catalog, status, set, clear }
}

type Input = {
  file: string
  modelIDs?: string[]
  defaultModelID?: string
  encryptionAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
  write?: (file: string, value: Buffer) => Promise<void>
}

export function createEnterpriseCredentialStore(input: Input) {
  const temp = `${input.file}.tmp`
  const defaultModelID = input.defaultModelID ?? input.modelIDs?.[0] ?? "default"
  const modelIDs = new Set(input.modelIDs ?? [defaultModelID])
  const writeEncrypted =
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

  const all = async (): Promise<EnterpriseCredentials> => {
    const encrypted = await readFile(input.file).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!encrypted) return { schemaVersion: 2, models: {} }

    const value: unknown = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    return decodeCredentials(value, modelIDs, defaultModelID) ?? { schemaVersion: 2, models: {} }
  }

  const read = async (): Promise<EnterpriseProviderCredentials> => {
    const encrypted = await readFile(input.file).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!encrypted) return { schemaVersion: 3, providers: {} }
    const value: unknown = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    return decodeProviderCredentials(value) ?? { schemaVersion: 3, providers: {} }
  }

  const readLegacy = async (): Promise<EnterpriseLegacyProviderCredentials | undefined> => {
    const encrypted = await readFile(input.file).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!encrypted) return
    const value: unknown = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    const v2 = decodeLegacyCredentials(value)
    if (v2) return { kind: "v2", credentials: v2 }
    if (isRecord(value) && "schemaVersion" in value) return
    const v1 = decodeCredential(value)
    if (v1) return { kind: "v1", credentials: v1 }
  }

  const get = async () => (await all()).models[defaultModelID] ?? { headers: {} }

  const health = async () => {
    const encrypted = await readFile(input.file).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!encrypted) return { state: "missing" as const }
    if (!input.encryptionAvailable()) return { state: "encryption-unavailable" as const }
    const valid = await Promise.resolve(encrypted)
      .then(input.decrypt)
      .then((text) => JSON.parse(text))
      .then(
        (value) => Boolean(decodeProviderCredentials(value) ?? decodeCredentials(value, modelIDs, defaultModelID)),
        () => false,
      )
    return { state: valid ? ("available" as const) : ("corrupt" as const) }
  }

  const persist = async (credentials: EnterpriseCredentials) => {
    if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
    const normalized = decodeCredentials(credentials, modelIDs, defaultModelID)
    if (!normalized) throw new Error("Enterprise credentials are invalid")
    await writeEncrypted(temp, input.encrypt(JSON.stringify(normalized)))
      .then(() => rename(temp, input.file))
      .finally(() => rm(temp, { force: true }))
  }

  const persistProvider = async (credentials: EnterpriseProviderCredentials) => {
    if (!input.encryptionAvailable()) throw new Error("Windows secure storage is unavailable")
    const normalized = decodeProviderCredentials(credentials)
    if (!normalized) throw new Error("Enterprise provider credentials are invalid")
    await writeEncrypted(temp, input.encrypt(JSON.stringify(normalized)))
      .then(() => rename(temp, input.file))
      .finally(() => rm(temp, { force: true }))
  }

  const setAll = (credentials: EnterpriseCredentials) => mutate(() => persist(credentials))
  const write = (credentials: EnterpriseProviderCredentials) => mutate(() => persistProvider(credentials))
  const updateAll = (transform: (current: EnterpriseCredentials) => EnterpriseCredentials) =>
    mutate(async () => persist(transform(await all())))
  const set = (credentials: EnterpriseCredential) =>
    updateAll((current) => ({ schemaVersion: 2, models: { ...current.models, [defaultModelID]: credentials } }))
  const update = (transform: (current: EnterpriseCredential) => EnterpriseCredential) =>
    updateAll((current) => ({
      schemaVersion: 2,
      models: {
        ...current.models,
        [defaultModelID]: transform(current.models[defaultModelID] ?? { headers: {} }),
      },
    }))
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
  const requireModel = (modelID: string) => {
    if (!modelIDs.has(modelID)) throw new Error("Enterprise credential model is not configured")
  }

  return { all, get, read, readLegacy, write, health, setAll, updateAll, set, update, clear, requireModel, defaultModelID }
}

function decodeCredentials(
  value: unknown,
  modelIDs: Set<string>,
  defaultModelID: string,
): EnterpriseCredentials | undefined {
  if (!isRecord(value)) return
  if (value.schemaVersion === 2 && isRecord(value.models)) {
    const models = Object.entries(value.models).flatMap(([modelID, credentials]) => {
      if (!modelIDs.has(modelID)) return []
      const decoded = decodeV2Credential(credentials)
      if (!decoded) return [undefined]
      return [[modelID, decoded] as const]
    })
    if (models.some((model) => model === undefined)) return
    return {
      schemaVersion: 2,
      models: Object.fromEntries(
        models.filter((model): model is readonly [string, EnterpriseCredential] => model !== undefined),
      ),
    }
  }
  if ("schemaVersion" in value || "models" in value) return
  const legacy = decodeCredential(value)
  if (!legacy) return
  return { schemaVersion: 2, models: { [defaultModelID]: legacy } }
}

function decodeV2Credential(value: unknown): EnterpriseCredential | undefined {
  if (!isRecord(value) || !isRecord(value.headers)) return
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") return
  if (Object.values(value.headers).some((header) => typeof header !== "string")) return
  return {
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    headers: value.headers as Record<string, string>,
  }
}

function decodeProviderCredentials(value: unknown): EnterpriseProviderCredentials | undefined {
  if (!isRecord(value) || value.schemaVersion !== 3 || !isRecord(value.providers)) return
  const providers = Object.entries(value.providers).flatMap(([providerID, credentials]) => {
    const decoded = decodeV2Credential(credentials)
    return decoded ? [[providerID, decoded] as const] : [undefined]
  })
  if (providers.some((provider) => provider === undefined)) return
  return {
    schemaVersion: 3,
    providers: Object.fromEntries(
      providers.filter((provider): provider is readonly [string, EnterpriseCredential] => provider !== undefined),
    ),
  }
}

function decodeLegacyCredentials(value: unknown): EnterpriseCredentials | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.models)) return
  const models = Object.entries(value.models).flatMap(([modelID, credentials]) => {
    const decoded = decodeV2Credential(credentials)
    return decoded ? [[modelID, decoded] as const] : [undefined]
  })
  if (models.some((model) => model === undefined)) return
  return {
    schemaVersion: 2,
    models: Object.fromEntries(
      models.filter((model): model is readonly [string, EnterpriseCredential] => model !== undefined),
    ),
  }
}

function decodeCredential(value: unknown): EnterpriseCredential | undefined {
  if (!isRecord(value)) return
  if (value.headers !== undefined && !isRecord(value.headers)) return
  const entries = Object.entries(value.headers ?? {})
  const headers = Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (
    typeof value.apiKey !== "string" &&
    ((value.apiKey !== undefined && !Object.keys(headers).length) ||
      (entries.some((entry) => typeof entry[1] !== "string") && !Object.keys(headers).length))
  ) {
    return
  }
  return { ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}), headers }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
