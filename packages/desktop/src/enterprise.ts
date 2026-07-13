import { enterpriseEnvironment, parseEnterpriseProfile } from "./enterprise-profile"

export { enterpriseEnvironment, parseEnterpriseProfile }
export type { EnterpriseProfile } from "./enterprise-profile"

export const ENTERPRISE_PROFILE = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: import.meta.env.OPENCODE_ENTERPRISE,
  OPENCODE_ENTERPRISE_BASE_URL: import.meta.env.OPENCODE_ENTERPRISE_BASE_URL,
  OPENCODE_ENTERPRISE_MODEL_ID: import.meta.env.OPENCODE_ENTERPRISE_MODEL_ID,
  OPENCODE_ENTERPRISE_MODEL_NAME: import.meta.env.OPENCODE_ENTERPRISE_MODEL_NAME,
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS,
})

export const ENTERPRISE_ENABLED = ENTERPRISE_PROFILE.enabled
