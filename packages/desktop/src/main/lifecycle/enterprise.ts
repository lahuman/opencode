import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { app, safeStorage, shell } from "electron"
import { ENTERPRISE_PROFILE, enterpriseEnvironment } from "../../enterprise"
import { adoptEnterpriseLegacyState } from "../enterprise-adoption"
import { createEnterpriseCredentialStore, enterpriseSidecarEnvironment, type EnterpriseProviderCredentials } from "../enterprise-credentials"
import { readEnterpriseGuide } from "../enterprise-guide"
import { runEnterprisePreflight } from "../enterprise-preflight"
import { createEnterpriseProviderRuntime, createEnterpriseSidecarTransitionQueue, initializeEnterpriseProviderStores } from "../enterprise-provider-runtime"
import { createEnterpriseProviderStore, type EnterpriseProviderCatalog } from "../enterprise-providers"
import { checkEnterpriseAppData, createEnterpriseReadinessReport, findEnterpriseExecutable, type EnterpriseProviderDiagnostic } from "../enterprise-readiness"
import { createEnterpriseSkillPackController, openEnterpriseSkillPackSource, resolveEnterpriseSkillPackState, type VerifiedEnterpriseSkillPack } from "../enterprise-skill-packs"
import { EnterpriseStateError, listCompatibleEnterpriseBackups, markEnterpriseStateHealthy, prepareEnterpriseState, restoreEnterpriseBackup } from "../enterprise-state"
import { createSidecarEnv } from "../sidecar-startup"
import { launchEnterpriseProcess } from "../service/enterprise-process"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { ENTERPRISE_SKILL_PACKS_KEY } from "../storage/keys"
import { getStore } from "../storage/store"

let current: ReturnType<typeof initialize> | undefined

export function enterpriseDesktop() {
  return current ??= initialize()
}

async function initialize() {
  const profile = ENTERPRISE_PROFILE
  if (!profile.enabled) throw new Error("Enterprise desktop is unavailable")
  const enterpriseDir = app.isPackaged
    ? join(process.resourcesPath, "enterprise")
    : join(import.meta.dirname, "../../resources/enterprise")
  const userData = app.getPath("userData")
  const credentials = createEnterpriseCredentialStore({
    file: join(userData, "enterprise-credentials.bin"),
    modelIDs: profile.models.map((model) => model.id),
    defaultModelID: profile.defaultModelID,
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  })
  const catalog = createEnterpriseProviderStore({ file: join(userData, "enterprise-providers.json") })
  const state = {
    failure: undefined as unknown,
    packs: [] as VerifiedEnterpriseSkillPack[],
    server: undefined as Awaited<ReturnType<typeof launchEnterpriseProcess>> | undefined,
    command: undefined as readonly string[] | undefined,
    diagnostic: undefined as EnterpriseProviderDiagnostic | undefined,
  }
  try {
    const preflight = await runEnterprisePreflight({ profile, appVersion: app.getVersion(), enterpriseDir })
    state.packs = preflight?.skillPacks.packs ?? []
    await adoptEnterpriseLegacyState({
      enabled: true,
      userData,
      sources: {
        data: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        config: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        state: process.env.XDG_STATE_HOME ?? userData,
      },
    })
    await prepareEnterpriseState({ enabled: true, userData, appVersion: app.getVersion() })
    const health = await credentials.health()
    if (health.state === "corrupt" || health.state === "encryption-unavailable") await catalog.initialize(profile)
    else await initializeEnterpriseProviderStores({ catalog, credentials, profile })
  } catch (error) {
    state.failure = error
  }
  const paths = () => {
    const enabled = resolveEnterpriseSkillPackState(state.packs, getStore().get(ENTERPRISE_SKILL_PACKS_KEY))
    return state.packs.flatMap((pack) => enabled[pack.id] ? [pack.root] : [])
  }
  const readCredentials = async () => {
    const health = await credentials.health()
    if (health.state === "corrupt" || health.state === "encryption-unavailable")
      return { schemaVersion: 3 as const, providers: {} }
    return credentials.read()
  }
  const enqueue = createEnterpriseSidecarTransitionQueue()
  const restart = async (
    skillPaths = paths(),
    suppliedCatalog?: EnterpriseProviderCatalog,
    suppliedSecrets?: EnterpriseProviderCredentials,
  ) => {
    if (state.failure) throw new Error("Enterprise startup verification failed")
    if (!state.command) throw new Error("Enterprise server is not ready")
    const providers = suppliedCatalog ?? await catalog.read() ?? { schemaVersion: 1 as const, providers: [] }
    const secrets = suppliedSecrets ?? await readCredentials()
    const { setEnterpriseLogSecrets } = await import("../native/logging")
    setEnterpriseLogSecrets(Object.values(secrets.providers).flatMap((value) => [
      ...(value.apiKey ? [value.apiKey] : []), ...Object.values(value.headers),
    ]))
    await state.server?.stop()
    state.server = await launchEnterpriseProcess({
      command: state.command,
      env: createSidecarEnv({
        ...enterpriseEnvironment(profile, {
          defaults: join(enterpriseDir, "opencode.jsonc"),
          guide: join(enterpriseDir, "company-guide.md"),
          ripgrep: join(enterpriseDir, "ripgrep", "rg.exe"),
          userData,
          skillPacks: skillPaths,
        }),
        ...enterpriseSidecarEnvironment(),
        OPENCODE_MODELS_PATH: join(enterpriseDir, "models.json"),
      }, { inherited: process.env, packaged: app.isPackaged, platform: process.platform }),
      bootstrap: { password: randomBytes(32).toString("base64url"), catalog: providers, credentials: secrets },
    })
    const ready = { url: state.server.url, password: state.server.password }
    SidecarCredentials.set(ready)
    await markEnterpriseStateHealthy({ enabled: true, userData, appVersion: app.getVersion() })
    return ready
  }
  const providers = createEnterpriseProviderRuntime({
    catalog: {
      read: async () => {
        if (state.failure) throw new Error("Enterprise provider management is unavailable")
        return await catalog.read() ?? { schemaVersion: 1, providers: [] }
      },
      write: catalog.write,
    },
    credentials: { read: credentials.read, write: credentials.write, health: credentials.health },
    restart: (catalog, credentials) => enqueue(() => restart(paths(), catalog, credentials).then(() => undefined)),
  })
  const skills = createEnterpriseSkillPackController({
    packs: state.packs,
    read: () => getStore().get(ENTERPRISE_SKILL_PACKS_KEY),
    write: (value) => getStore().set(ENTERPRISE_SKILL_PACKS_KEY, value),
    restart: (paths) => enqueue(() => restart(paths).then(() => undefined)),
  })
  const api = {
    ...providers,
    readGuide: () => readEnterpriseGuide({ enabled: true, path: join(enterpriseDir, "company-guide.md"), version: profile.guideVersion }),
    readiness: async (provider?: EnterpriseProviderDiagnostic) => {
      if (provider) state.diagnostic = provider
      const health = await credentials.health()
      const data = await readCredentials()
      const configured = await catalog.read()
      const selected = configured?.default ? data.providers[configured.default.providerID] : undefined
      return createEnterpriseReadinessReport({
        packageVerified: !state.failure,
        appDataWritable: () => checkEnterpriseAppData(userData),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        credentialConfigured: Boolean(selected?.apiKey || Object.keys(selected?.headers ?? {}).length),
        credentialError: health.state === "corrupt" ? "credential_decryption_failed" : health.state === "encryption-unavailable" ? "credential_encryption_unavailable" : undefined,
        findExecutable: findEnterpriseExecutable,
        provider: state.diagnostic,
      })
    },
    stateBackups: async () => state.failure instanceof EnterpriseStateError
      && ["recovery_required", "downgrade"].includes(state.failure.kind)
      ? listCompatibleEnterpriseBackups(userData, app.getVersion()) : [],
    restoreStateBackup: async (backupID: string) => {
      if (!(await api.stateBackups()).some((backup) => backup.id === backupID)) throw new Error("Enterprise backup is incompatible")
      await restoreEnterpriseBackup({ userData, backupID })
      return { restartRequired: true }
    },
    skillPacks: skills.list,
    setSkillPackEnabled: skills.setEnabled,
    openSkillPackSource: (id: string) => openEnterpriseSkillPackSource(state.packs, id, shell.openExternal),
  }
  return {
    api,
    verified: !state.failure,
    connect: (command: readonly string[]) => {
      state.command = command
      return enqueue(() => restart())
    },
    stop: () => state.server?.stop(),
  }
}
