import type {
  createEnterpriseCredentialStore,
  EnterpriseCredential,
  EnterpriseProviderCredentials,
} from "./enterprise-credentials"
import {
  createEnterpriseProviderStore,
  validateEnterpriseProviderCatalog,
  type EnterpriseModelRef,
  type EnterpriseProvider,
  type EnterpriseProviderCatalog,
  type EnterpriseProviderModel,
} from "./enterprise-providers"

export type EnterpriseProviderCatalogView = EnterpriseProviderCatalog & {
  providers: Array<
    EnterpriseProvider & {
      credentials: {
        configured: boolean
        headerNames: string[]
        errorCode?: "credential_decryption_failed" | "credential_encryption_unavailable"
      }
    }
  >
}

export type CredentialReplacement = { apiKey?: string; headers: Record<string, string> }
export type EnterpriseProviderErrorCode =
  | "restart_failed_rolled_back"
  | "restart_failed_recovery_failed"
  | "credential_decryption_failed"
  | "credential_encryption_unavailable"
  | "credential_provider_not_configured"

export type EnterpriseProviderAPI = {
  providerCatalog(): Promise<EnterpriseProviderCatalogView>
  createProvider(input: {
    provider: EnterpriseProvider
    credentials?: CredentialReplacement
  }): Promise<EnterpriseProviderCatalogView>
  updateProvider(input: {
    providerID: string
    name: string
    baseURL: string
    credentials?: CredentialReplacement
    clearCredentials?: true
  }): Promise<EnterpriseProviderCatalogView>
  deleteProvider(providerID: string): Promise<EnterpriseProviderCatalogView>
  createModel(input: {
    providerID: string
    model: EnterpriseProviderModel
  }): Promise<EnterpriseProviderCatalogView>
  updateModel(input: { providerID: string; modelID: string; name: string }): Promise<EnterpriseProviderCatalogView>
  deleteModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
  setDefaultModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
  replaceProviderCredentials(input: {
    providerID: string
    credentials: CredentialReplacement
  }): Promise<EnterpriseProviderCatalogView>
  clearProviderCredentials(providerID: string): Promise<EnterpriseProviderCatalogView>
}

type State = { catalog: EnterpriseProviderCatalog; credentials: EnterpriseProviderCredentials }
type CredentialHealth =
  | { state: "available" | "missing" }
  | { state: "corrupt" | "encryption-unavailable" }

export async function initializeEnterpriseProviderStores(input: {
  catalog: ReturnType<typeof createEnterpriseProviderStore>
  credentials: ReturnType<typeof createEnterpriseCredentialStore>
  profile: { defaultModelID: string; models: { id: string; name: string; baseURL: string }[] }
}) {
  const health = await input.credentials.health()
  const errorCode = credentialHealthError(health)
  if (errorCode) throw new EnterpriseProviderRuntimeError(errorCode)
  const legacy = await input.credentials.readLegacy()
  const initialized = await input.catalog.initialize(
    input.profile,
    legacy?.kind === "v2" ? legacy.credentials : undefined,
  )
  const providerID = initialized.catalog.default?.providerID ?? initialized.catalog.providers[0]?.id
  if (legacy?.kind === "v1" && providerID) {
    await input.credentials.write({ schemaVersion: 3, providers: { [providerID]: legacy.credentials } })
    return initialized.catalog
  }
  if (initialized.credentials) {
    await input.credentials.write(initialized.credentials)
    return initialized.catalog
  }
  const credentials = requireCredentialMembership(initialized.catalog, await input.credentials.read())
  if ((await input.credentials.health()).state === "missing") await input.credentials.write(credentials)
  return initialized.catalog
}

export class EnterpriseProviderRuntimeError extends Error {
  constructor(readonly code: EnterpriseProviderErrorCode) {
    super(code)
    this.name = "EnterpriseProviderRuntimeError"
  }
}

export function createEnterpriseSidecarTransitionQueue() {
  let transitions: Promise<unknown> = Promise.resolve()
  return <T>(transition: () => Promise<T>) => {
    const result = transitions.then(transition)
    transitions = result.catch(() => undefined)
    return result
  }
}

export function createEnterpriseProviderRuntime(input: {
  catalog: {
    read: () => Promise<EnterpriseProviderCatalog>
    write: (catalog: EnterpriseProviderCatalog) => Promise<void>
  }
  credentials: {
    read: () => Promise<EnterpriseProviderCredentials>
    write: (credentials: EnterpriseProviderCredentials) => Promise<void>
    health: () => Promise<CredentialHealth>
  }
  restart: (catalog: EnterpriseProviderCatalog, credentials: EnterpriseProviderCredentials) => Promise<void>
}): EnterpriseProviderAPI {
  let operations: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = operations.then(operation)
    operations = result.catch(() => undefined)
    return result
  }
  const snapshot = async (): Promise<State> => {
    const catalog = validateEnterpriseProviderCatalog(await input.catalog.read())
    return { catalog, credentials: requireCredentialMembership(catalog, await input.credentials.read()) }
  }
  const persist = async (state: State) => {
    await input.catalog.write(state.catalog)
    await input.credentials.write(state.credentials)
  }
  const mutate = (transform: (state: State) => State) =>
    enqueue(async () => {
      const errorCode = credentialHealthError(await input.credentials.health())
      if (errorCode) throw new EnterpriseProviderRuntimeError(errorCode)
      const previous = await snapshot()
      const next = transform(previous)
      try {
        await persist(next)
      } catch (error) {
        try {
          await persist(previous)
        } catch {
          throw new EnterpriseProviderRuntimeError("restart_failed_recovery_failed")
        }
        throw error
      }
      try {
        await input.restart(next.catalog, next.credentials)
      } catch {
        try {
          await persist(previous)
          await input.restart(previous.catalog, previous.credentials)
        } catch {
          throw new EnterpriseProviderRuntimeError("restart_failed_recovery_failed")
        }
        throw new EnterpriseProviderRuntimeError("restart_failed_rolled_back")
      }
      return view(next, await input.credentials.health())
    })

  return {
    providerCatalog: () =>
      enqueue(async () => {
        const health = await input.credentials.health()
        const errorCode = credentialHealthError(health)
        const catalog = validateEnterpriseProviderCatalog(await input.catalog.read())
        return view(
          {
            catalog,
            credentials: errorCode
              ? { schemaVersion: 3, providers: {} }
              : requireCredentialMembership(catalog, await input.credentials.read()),
          },
          health,
        )
      }),
    createProvider: (value) =>
      mutate((state) => {
        const catalog = validateEnterpriseProviderCatalog({
          ...state.catalog,
          providers: [...state.catalog.providers, value.provider],
        })
        const selected = catalog.default ?? firstModel(catalog)
        const credentials =
          value.credentials === undefined
            ? state.credentials
            : {
                schemaVersion: 3 as const,
                providers: {
                  ...state.credentials.providers,
                  [value.provider.id]: requireCredentialReplacement(value.credentials),
                },
              }
        return {
          catalog: validateEnterpriseProviderCatalog({ ...catalog, ...(selected ? { default: selected } : {}) }),
          credentials,
        }
      }),
    updateProvider: (value) =>
      mutate((state) => {
        requireProvider(state.catalog, value.providerID)
        if (value.clearCredentials !== undefined && value.clearCredentials !== true) {
          throw new Error("Enterprise provider credentials are invalid")
        }
        if (value.credentials !== undefined && value.clearCredentials) {
          throw new Error("Enterprise provider credentials are invalid")
        }
        const catalog = validateEnterpriseProviderCatalog({
          ...state.catalog,
          providers: state.catalog.providers.map((provider) =>
            provider.id === value.providerID
              ? { ...provider, name: value.name, baseURL: value.baseURL }
              : provider,
          ),
        })
        if (value.credentials === undefined && !value.clearCredentials) return { catalog, credentials: state.credentials }
        return {
          catalog,
          credentials: {
            schemaVersion: 3,
            providers: {
              ...state.credentials.providers,
              [value.providerID]: value.clearCredentials ? { headers: {} } : requireCredentialReplacement(value.credentials),
            },
          },
        }
      }),
    deleteProvider: (providerID) =>
      mutate((state) => {
        const provider = requireProvider(state.catalog, providerID)
        const providers = state.catalog.providers.filter((item) => item.id !== provider.id)
        const selected = state.catalog.default?.providerID === provider.id ? firstModel({ ...state.catalog, providers }) : state.catalog.default
        const catalog = validateEnterpriseProviderCatalog({
          schemaVersion: 1,
          ...(selected ? { default: selected } : {}),
          providers,
        })
        return {
          catalog,
          credentials: {
            schemaVersion: 3,
            providers: Object.fromEntries(
              Object.entries(state.credentials.providers).filter(([id]) => id !== provider.id),
            ),
          },
        }
      }),
    createModel: (value) =>
      mutate((state) => {
        requireProvider(state.catalog, value.providerID)
        const providers = state.catalog.providers.map((provider) =>
          provider.id === value.providerID ? { ...provider, models: [...provider.models, value.model] } : provider,
        )
        const selected = state.catalog.default ?? firstModel({ ...state.catalog, providers })
        return {
          catalog: validateEnterpriseProviderCatalog({
            schemaVersion: 1,
            ...(selected ? { default: selected } : {}),
            providers,
          }),
          credentials: state.credentials,
        }
      }),
    updateModel: (value) =>
      mutate((state) => {
        requireModel(state.catalog, value)
        return {
          catalog: validateEnterpriseProviderCatalog({
            ...state.catalog,
            providers: state.catalog.providers.map((provider) =>
              provider.id === value.providerID
                ? {
                    ...provider,
                    models: provider.models.map((model) =>
                      model.id === value.modelID ? { ...model, name: value.name } : model,
                    ),
                  }
                : provider,
            ),
          }),
          credentials: state.credentials,
        }
      }),
    deleteModel: (value) =>
      mutate((state) => {
        requireModel(state.catalog, value)
        const providers = state.catalog.providers.map((provider) =>
          provider.id === value.providerID
            ? { ...provider, models: provider.models.filter((model) => model.id !== value.modelID) }
            : provider,
        )
        const selected =
          state.catalog.default?.providerID === value.providerID && state.catalog.default.modelID === value.modelID
            ? firstModel({ ...state.catalog, providers }, value.providerID)
            : state.catalog.default
        return {
          catalog: validateEnterpriseProviderCatalog({
            schemaVersion: 1,
            ...(selected ? { default: selected } : {}),
            providers,
          }),
          credentials: state.credentials,
        }
      }),
    setDefaultModel: (value) =>
      mutate((state) => {
        requireModel(state.catalog, value)
        return {
          catalog: validateEnterpriseProviderCatalog({ ...state.catalog, default: value }),
          credentials: state.credentials,
        }
      }),
    replaceProviderCredentials: (value) =>
      mutate((state) => {
        requireProvider(state.catalog, value.providerID)
        return {
          catalog: validateEnterpriseProviderCatalog(state.catalog),
          credentials: {
            schemaVersion: 3,
            providers: {
              ...state.credentials.providers,
              [value.providerID]: requireCredentialReplacement(value.credentials),
            },
          },
        }
      }),
    clearProviderCredentials: (providerID) =>
      mutate((state) => {
        requireProvider(state.catalog, providerID)
        return {
          catalog: validateEnterpriseProviderCatalog(state.catalog),
          credentials: {
            schemaVersion: 3,
            providers: { ...state.credentials.providers, [providerID]: { headers: {} } },
          },
        }
      }),
  }
}

function requireProvider(catalog: EnterpriseProviderCatalog, providerID: unknown) {
  if (typeof providerID !== "string") throw new Error("Enterprise provider ID is invalid")
  const provider = catalog.providers.find((item) => item.id === providerID)
  if (!provider) throw new Error("Enterprise provider is not configured")
  return provider
}

function requireModel(catalog: EnterpriseProviderCatalog, value: { providerID: unknown; modelID: unknown }) {
  const provider = requireProvider(catalog, value.providerID)
  if (typeof value.modelID !== "string") throw new Error("Enterprise model ID is invalid")
  const model = provider.models.find((item) => item.id === value.modelID)
  if (!model) throw new Error("Enterprise model is not configured")
  return model
}

function firstModel(catalog: EnterpriseProviderCatalog, preferredProviderID?: string): EnterpriseModelRef | undefined {
  const preferred = catalog.providers.find((provider) => provider.id === preferredProviderID)
  if (preferred?.models[0]) return { providerID: preferred.id, modelID: preferred.models[0].id }
  const provider = catalog.providers.find((item) => item.models.length)
  if (!provider?.models[0]) return
  return { providerID: provider.id, modelID: provider.models[0].id }
}

function requireCredentialReplacement(value: unknown): EnterpriseCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Enterprise provider credentials are invalid")
  }
  if (!("headers" in value) || typeof value.headers !== "object" || value.headers === null || Array.isArray(value.headers)) {
    throw new Error("Enterprise provider credentials are invalid")
  }
  const apiKey = "apiKey" in value ? value.apiKey : undefined
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new Error("Enterprise provider credentials are invalid")
  }
  const headers = Object.entries(value.headers)
  if (headers.some(([name, header]) => !name.trim() || typeof header !== "string" || !header.trim())) {
    throw new Error("Enterprise provider credentials are invalid")
  }
  const headerNames = headers.map(([name]) => name.trim().toLowerCase())
  if (new Set(headerNames).size !== headerNames.length) {
    throw new Error("Enterprise provider credentials are invalid")
  }
  return {
    ...(typeof apiKey === "string" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    headers: Object.fromEntries(headers.map(([name, header]) => [name.trim(), (header as string).trim()])),
  }
}

function requireCredentialMembership(
  catalog: EnterpriseProviderCatalog,
  credentials: EnterpriseProviderCredentials,
) {
  const providerIDs = new Set(catalog.providers.map((provider) => provider.id))
  if (Object.keys(credentials.providers).some((providerID) => !providerIDs.has(providerID))) {
    throw new EnterpriseProviderRuntimeError("credential_provider_not_configured")
  }
  return credentials
}

function view(state: State, health: CredentialHealth): EnterpriseProviderCatalogView {
  const errorCode = credentialHealthError(health)
  return {
    ...state.catalog,
    default: state.catalog.default,
    providers: state.catalog.providers.map((provider) => {
      const credentials = errorCode ? undefined : state.credentials.providers[provider.id]
      return {
        ...provider,
        credentials: {
          configured: Boolean(credentials?.apiKey || Object.keys(credentials?.headers ?? {}).length),
          headerNames: Object.keys(credentials?.headers ?? {}),
          ...(errorCode ? { errorCode } : {}),
        },
      }
    }),
  }
}

function credentialHealthError(health: CredentialHealth) {
  if (health.state === "corrupt") return "credential_decryption_failed" as const
  if (health.state === "encryption-unavailable") return "credential_encryption_unavailable" as const
}
