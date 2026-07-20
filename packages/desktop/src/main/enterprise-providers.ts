export type EnterpriseModelRef = { providerID: string; modelID: string }

export type EnterpriseProviderModel = { id: string; name: string }

export type EnterpriseProvider = {
  id: string
  name: string
  baseURL: string
  models: EnterpriseProviderModel[]
}

export type EnterpriseProviderCatalog = {
  schemaVersion: 1
  default?: EnterpriseModelRef
  providers: EnterpriseProvider[]
}

type LegacyCredential = {
  apiKey?: string
  headers: Record<string, string>
}

type LegacyCredentials = {
  schemaVersion: 2
  models: Record<string, LegacyCredential>
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

export function validateEnterpriseProviderCatalog(value: unknown): EnterpriseProviderCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw new Error("Enterprise provider catalog is invalid")
  }
  const providerIDs = new Set<string>()
  const providers = value.providers.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.models)) throw new Error("Enterprise provider is invalid")
    const id = requireProviderID(item.id)
    if (providerIDs.has(id)) throw new Error("Enterprise provider ID is duplicated")
    providerIDs.add(id)
    const modelIDs = new Set<string>()
    const models = item.models.map((model) => {
      if (!isRecord(model)) throw new Error("Enterprise model is invalid")
      const modelID = requireText(model.id, "Enterprise model ID is required")
      if (modelIDs.has(modelID)) throw new Error("Enterprise model ID is duplicated")
      modelIDs.add(modelID)
      return { id: modelID, name: requireText(model.name, "Enterprise model name is required") }
    })
    return {
      id,
      name: requireText(item.name, "Enterprise provider name is required"),
      baseURL: requireBaseURL(item.baseURL),
      models,
    }
  })
  const defaultModel = decodeDefault(value.default, providers)
  return { schemaVersion: 1, ...(defaultModel ? { default: defaultModel } : {}), providers }
}

export function createEnterpriseProviderStore(input: { file: string }) {
  const temp = `${input.file}.tmp`

  const read = async () => {
    const value = await readFile(input.file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return
      throw error
    })
    if (value === undefined) return
    try {
      return validateEnterpriseProviderCatalog(JSON.parse(value))
    } catch {
      throw new Error("Enterprise provider catalog is invalid")
    }
  }

  const write = async (catalog: EnterpriseProviderCatalog) => {
    const normalized = validateEnterpriseProviderCatalog(catalog)
    await mkdir(dirname(input.file), { recursive: true })
    await writeFile(temp, JSON.stringify(normalized), { mode: 0o600 })
      .then(() => rename(temp, input.file))
      .finally(() => rm(temp, { force: true }))
  }

  const initialize = async (
    profile: { defaultModelID: string; models: { id: string; name: string; baseURL: string }[] },
    legacyCredentials?: LegacyCredentials,
  ) => {
    const existing = await read()
    if (existing) {
      const credentials = legacyCredentials ? deriveProviderCredentials(existing, legacyCredentials) : undefined
      if (credentials) return { catalog: existing, credentials }
      return { catalog: existing }
    }
    const providerIDs = new Set(profile.models.some((model) => model.id === profile.defaultModelID) ? ["company-llm"] : [])
    const providers = profile.models.map((model) => {
      const id = model.id === profile.defaultModelID ? "company-llm" : nextProviderID(providerIDs)
      providerIDs.add(id)
      return {
        id,
        name: model.name,
        baseURL: model.baseURL,
        models: [{ id: model.id, name: model.name }],
      }
    })
    const defaultProvider = providers.find((provider) => provider.models[0]?.id === profile.defaultModelID)
    const catalog = validateEnterpriseProviderCatalog({
      schemaVersion: 1,
      ...(defaultProvider ? { default: { providerID: defaultProvider.id, modelID: profile.defaultModelID } } : {}),
      providers,
    })
    const credentials = deriveProviderCredentials(catalog, legacyCredentials ?? { schemaVersion: 2, models: {} })
    await write(catalog)
    return { catalog, credentials }
  }

  const clear = async () => {
    await Promise.all([input.file, temp].map((file) => rm(file, { force: true })))
  }

  return { read, write, initialize, clear }
}

function decodeDefault(value: unknown, providers: EnterpriseProvider[]) {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error("Enterprise provider default is invalid")
  const providerID = requireProviderID(value.providerID)
  const modelID = requireText(value.modelID, "Enterprise provider default model is required")
  if (!providers.some((provider) => provider.id === providerID && provider.models.some((model) => model.id === modelID))) {
    throw new Error("Enterprise provider default is invalid")
  }
  return { providerID, modelID }
}

function requireProviderID(value: unknown) {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new Error("Enterprise provider ID is invalid")
  return value
}

function requireText(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message)
  return value
}

function requireBaseURL(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enterprise provider URL is invalid")
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Enterprise provider URL is invalid")
  }
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function nextProviderID(existing: Set<string>) {
  if (!existing.has("company-llm")) return "company-llm"
  let suffix = 2
  while (existing.has(`company-llm-${suffix}`)) suffix++
  return `company-llm-${suffix}`
}

function deriveProviderCredentials(catalog: EnterpriseProviderCatalog, legacy: LegacyCredentials) {
  const providers = catalog.providers.flatMap((provider) => {
    const models = provider.models.filter((model) => legacy.models[model.id])
    if (models.length !== 1) return []
    return [[provider.id, legacy.models[models[0]!.id]] as const]
  })
  const covered = new Set(providers.map(([providerID]) => providerID))
  const expected = Object.keys(legacy.models).length
  if (providers.length !== expected || covered.size !== providers.length) return
  return { schemaVersion: 3 as const, providers: Object.fromEntries(providers) }
}
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
