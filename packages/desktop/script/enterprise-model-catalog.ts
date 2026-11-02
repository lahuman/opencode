type Env = Record<string, string | undefined>

export function enterpriseModelEnvironment(env: Env, catalogPath: string): Env {
  if (env.OPENCODE_ENTERPRISE !== "1") return env
  return { ...env, MODELS_DEV_API_JSON: catalogPath }
}
