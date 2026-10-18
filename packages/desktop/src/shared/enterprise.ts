import type { Platform } from "@opencode/app/desktop"

export type EnterpriseAPI = NonNullable<Platform["enterprise"]>

export const EnterpriseChannel = "opencode:enterprise"

export function createEnterpriseBridge(invoke: <K extends keyof EnterpriseAPI>(
  method: K,
  args: Parameters<EnterpriseAPI[K]>,
) => ReturnType<EnterpriseAPI[K]>): EnterpriseAPI {
  return {
    providerCatalog: () => invoke("providerCatalog", []),
    createProvider: (input) => invoke("createProvider", [input]),
    updateProvider: (input) => invoke("updateProvider", [input]),
    deleteProvider: (id) => invoke("deleteProvider", [id]),
    createModel: (input) => invoke("createModel", [input]),
    updateModel: (input) => invoke("updateModel", [input]),
    deleteModel: (input) => invoke("deleteModel", [input]),
    setDefaultModel: (input) => invoke("setDefaultModel", [input]),
    replaceProviderCredentials: (input) => invoke("replaceProviderCredentials", [input]),
    clearProviderCredentials: (id) => invoke("clearProviderCredentials", [id]),
    readGuide: () => invoke("readGuide", []),
    readiness: (input) => invoke("readiness", [input]),
    stateBackups: () => invoke("stateBackups", []),
    restoreStateBackup: (id) => invoke("restoreStateBackup", [id]),
    skillPacks: () => invoke("skillPacks", []),
    setSkillPackEnabled: (id, enabled) => invoke("setSkillPackEnabled", [id, enabled]),
    openSkillPackSource: (id) => invoke("openSkillPackSource", [id]),
  }
}
