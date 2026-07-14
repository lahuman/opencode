type Env = Record<string, string | undefined>

export function validateEnterpriseBuild(env: Env) {
  if (env.OPENCODE_ENTERPRISE !== "1") throw new Error("OPENCODE_ENTERPRISE must be 1")
  rejectAlternateSigningInputs(env)

  const baseURL = requireValue(env, "OPENCODE_ENTERPRISE_BASE_URL")
  if (/[?#]/.test(baseURL)) {
    throw new Error("OPENCODE_ENTERPRISE_BASE_URL must not contain a query or fragment")
  }
  const base = parseHTTPURL(
    baseURL,
    "OPENCODE_ENTERPRISE_BASE_URL",
    "OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL",
  )
  const allowedOrigins = Array.from(
    new Set(
      requireValue(env, "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => parseAllowedOrigin(value).origin),
    ),
  )

  if (!allowedOrigins.includes(base.origin)) {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must include the OPENCODE_ENTERPRISE_BASE_URL origin")
  }

  requireValue(env, "CSC_LINK")
  requireValue(env, "CSC_KEY_PASSWORD")

  return {
    baseURL: base.href,
    modelID: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_ID"),
    modelName: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_NAME"),
    defaultsVersion: requireValue(env, "OPENCODE_ENTERPRISE_DEFAULTS_VERSION"),
    guideVersion: requireValue(env, "OPENCODE_ENTERPRISE_GUIDE_VERSION"),
    allowedOrigins,
  }
}

function rejectAlternateSigningInputs(env: Env) {
  for (const key of [
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "CSC_NAME",
    "CSC_INSTALLER_LINK",
    "CSC_INSTALLER_KEY_PASSWORD",
    "CSC_KEYCHAIN",
    "CSC_IDENTITY_AUTO_DISCOVERY",
    "CSC_FOR_PULL_REQUEST",
  ]) {
    if (env[key] !== undefined) throw new Error(`${key} is not supported for an enterprise Windows package`)
  }
}

function requireValue(env: Env, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required for an enterprise Windows package`)
  return value
}

function parseHTTPURL(value: string, key: string, invalid: string) {
  if (!URL.canParse(value)) throw new Error(invalid)

  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(invalid)
  if (url.username || url.password) throw new Error(`${key} must not contain credentials`)
  return url
}

function parseAllowedOrigin(value: string) {
  const url = parseHTTPURL(
    value,
    "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
    "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs",
  )
  if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(value)) {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins")
  }
  return url
}
