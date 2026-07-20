export type EnterpriseModel = {
  id: string
  name: string
  baseURL: string
}

export type EnterpriseProfile =
  | { enabled: false }
  | {
      enabled: true
      models: EnterpriseModel[]
      defaultModelID: string
      defaultsVersion: string
      guideVersion: string
      catalogVersion: string
      allowedOrigins: string[]
    }

type BuildEnv = Record<string, string | undefined>

export function parseEnterpriseProfile(env: BuildEnv): EnterpriseProfile {
  if (env.OPENCODE_ENTERPRISE !== "1") return { enabled: false }

  const models = parseModels(env)
  const defaultModelID = env.OPENCODE_ENTERPRISE_MODELS
    ? models.length
      ? requireValue(env, "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
      : env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID?.trim() ?? ""
    : models[0].id
  if (
    (models.length === 0 && defaultModelID) ||
    (models.length > 0 && !models.some((model) => model.id === defaultModelID))
  ) {
    throw new Error("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID must reference a configured model")
  }
  const defaultsVersion = requireValue(env, "OPENCODE_ENTERPRISE_DEFAULTS_VERSION")
  const guideVersion = requireValue(env, "OPENCODE_ENTERPRISE_GUIDE_VERSION")
  const catalogVersion = env.OPENCODE_ENTERPRISE_CATALOG_VERSION?.trim() || defaultsVersion
  const allowedOrigins = Array.from(
    new Set([
      ...models.map((model) => new URL(model.baseURL).origin),
      ...(env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(parseAllowedOrigin),
    ]),
  )
  return {
    enabled: true,
    models,
    defaultModelID,
    defaultsVersion,
    guideVersion,
    catalogVersion,
    allowedOrigins,
  }
}

export function enterpriseEnvironment(
  profile: EnterpriseProfile,
  paths: { defaults: string; guide: string; userData?: string; skillPacks?: string[] },
): Record<string, string> {
  if (!profile.enabled) return {}
  const userData = paths.userData?.replace(/[\\/]+$/, "")
  return {
    OPENCODE_ENTERPRISE_OFFLINE: "1",
    OPENCODE_ENTERPRISE_DEFAULTS_PATH: paths.defaults,
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: profile.defaultsVersion,
    OPENCODE_ENTERPRISE_GUIDE_VERSION: profile.guideVersion,
    OPENCODE_ENTERPRISE_CATALOG_VERSION: profile.catalogVersion,
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: profile.allowedOrigins.join(","),
    OPENCODE_ENTERPRISE_MODELS: JSON.stringify(profile.models),
    OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: profile.defaultModelID,
    OPENCODE_ENTERPRISE_SKILL_PATHS: JSON.stringify(paths.skillPacks ?? []),
    ...(userData
      ? {
          XDG_DATA_HOME: `${userData}/data`,
          XDG_CONFIG_HOME: `${userData}/config`,
          XDG_CACHE_HOME: `${userData}/cache`,
          XDG_STATE_HOME: `${userData}/state`,
        }
      : {}),
    ...(paths.guide ? { OPENCODE_ENTERPRISE_GUIDE_PATH: paths.guide } : {}),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
}

function parseModels(env: BuildEnv) {
  if (!env.OPENCODE_ENTERPRISE_MODELS) {
    return [
      parseModel({
        id: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_ID"),
        name: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_NAME"),
        baseURL: requireValue(env, "OPENCODE_ENTERPRISE_BASE_URL"),
      }, "OPENCODE_ENTERPRISE_BASE_URL"),
    ]
  }

  const value: unknown = (() => {
    try {
      return JSON.parse(env.OPENCODE_ENTERPRISE_MODELS)
    } catch {
      throw new Error("OPENCODE_ENTERPRISE_MODELS must be a JSON array")
    }
  })()
  if (!Array.isArray(value)) {
    throw new Error("OPENCODE_ENTERPRISE_MODELS must be a JSON array")
  }
  const models = value.map((model) => parseModel(model, "OPENCODE_ENTERPRISE_MODELS"))
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("OPENCODE_ENTERPRISE_MODELS must contain unique model IDs")
  }
  return models
}

function parseModel(value: unknown, key: string): EnterpriseModel {
  if (!isRecord(value) || !hasExactKeys(value, ["baseURL", "id", "name"])) {
    throw new Error(`${key} must contain only id, name, and baseURL`)
  }
  const id = typeof value.id === "string" ? value.id.trim() : ""
  const name = typeof value.name === "string" ? value.name.trim() : ""
  const baseURL = typeof value.baseURL === "string" ? value.baseURL.trim() : ""
  if (!id || !name || !baseURL) throw new Error(`${key} contains incomplete model metadata`)
  if (/[?#]/.test(baseURL)) throw new Error(`${key} model URLs must not contain a query or fragment`)
  const url = (() => {
    try {
      return new URL(baseURL)
    } catch {
      throw new Error(`${key} model URLs must be absolute HTTP(S) URLs`)
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} model URLs must be absolute HTTP(S) URLs`)
  }
  if (url.username || url.password) throw new Error(`${key} model URLs must not contain credentials`)
  return { id, name, baseURL: url.toString() }
}

function parseAllowedOrigin(value: string) {
  const url = (() => {
    try {
      return new URL(value)
    } catch {
      throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain HTTP(S) origins")
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain HTTP(S) origins")
  }
  if (url.username || url.password) {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
  }
  return url.origin
}

function requireValue(env: BuildEnv, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = keys.sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
