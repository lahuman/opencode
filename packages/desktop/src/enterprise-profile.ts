export type EnterpriseProfile =
  | { enabled: false }
  | {
      enabled: true
      baseURL: string
      modelID: string
      modelName: string
      defaultsVersion: string
      guideVersion: string
      allowedOrigins: string[]
    }

type BuildEnv = Record<string, string | undefined>

export function parseEnterpriseProfile(env: BuildEnv): EnterpriseProfile {
  if (env.OPENCODE_ENTERPRISE !== "1") return { enabled: false }

  const baseURL = env.OPENCODE_ENTERPRISE_BASE_URL?.trim()
  const modelID = env.OPENCODE_ENTERPRISE_MODEL_ID?.trim()
  const modelName = env.OPENCODE_ENTERPRISE_MODEL_NAME?.trim()
  const defaultsVersion = env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION?.trim()
  const guideVersion = env.OPENCODE_ENTERPRISE_GUIDE_VERSION?.trim()
  if (!baseURL) throw new Error("OPENCODE_ENTERPRISE_BASE_URL is required")
  if (!modelID) throw new Error("OPENCODE_ENTERPRISE_MODEL_ID is required")
  if (!modelName) throw new Error("OPENCODE_ENTERPRISE_MODEL_NAME is required")
  if (!defaultsVersion) throw new Error("OPENCODE_ENTERPRISE_DEFAULTS_VERSION is required")
  if (!guideVersion) throw new Error("OPENCODE_ENTERPRISE_GUIDE_VERSION is required")

  const url = (() => {
    try {
      return new URL(baseURL)
    } catch {
      throw new Error("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
    }
  })()
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
  }
  if (url.username || url.password) throw new Error("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
  const origin = url.origin

  const allowedOrigins = Array.from(
    new Set([
      origin,
      ...(env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const url = new URL(item)
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain HTTP(S) origins")
          }
          if (url.username || url.password) {
            throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
          }
          return url.origin
        }),
    ]),
  )
  return {
    enabled: true,
    baseURL: url.toString(),
    modelID,
    modelName,
    defaultsVersion,
    guideVersion,
    allowedOrigins,
  }
}

export function enterpriseEnvironment(
  profile: EnterpriseProfile,
  paths: { defaults: string; guide: string },
): Record<string, string> {
  if (!profile.enabled) return {}
  return {
    OPENCODE_ENTERPRISE_OFFLINE: "1",
    OPENCODE_ENTERPRISE_DEFAULTS_PATH: paths.defaults,
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: profile.defaultsVersion,
    OPENCODE_ENTERPRISE_GUIDE_VERSION: profile.guideVersion,
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: profile.allowedOrigins.join(","),
    OPENCODE_ENTERPRISE_BASE_URL: profile.baseURL,
    OPENCODE_ENTERPRISE_MODEL_ID: profile.modelID,
    OPENCODE_ENTERPRISE_MODEL_NAME: profile.modelName,
    ...(paths.guide ? { OPENCODE_ENTERPRISE_GUIDE_PATH: paths.guide } : {}),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
}
