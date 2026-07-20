import { describe, expect, test } from "bun:test"
import { createCompanyGuideCommand, openEditionHelp } from "./dialog-company-guide"

const providerAPI = {
  providerCatalog: async () => ({ schemaVersion: 1 as const, providers: [] }),
  createProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
  updateProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
  deleteProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
  createModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
  updateModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
  deleteModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
  setDefaultModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
  replaceProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
  clearProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
}

describe("company guide command", () => {
  test("is unavailable outside enterprise mode", () => {
    expect(
      createCompanyGuideCommand({
        enterprise: undefined,
        category: "Settings",
        open: () => undefined,
        reportFailure: () => undefined,
      }),
    ).toBeUndefined()
  })

  test("opens the local guide returned by the enterprise platform", async () => {
    const opened: { version: string; markdown: string }[] = []
    const command = createCompanyGuideCommand({
      enterprise: {
        ...providerAPI,
        readGuide: async () => ({ version: "kernexa-1", markdown: "# Kernexa AI 사용 가이드" }),
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "pass", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: false }),
        skillPacks: async () => [],
        setSkillPackEnabled: async () => [],
        openSkillPackSource: async () => undefined,
      },
      category: "Settings",
      open: (guide) => opened.push(guide),
      reportFailure: () => undefined,
    })

    await command?.onSelect?.()

    expect(command?.id).toBe("company.guide.open")
    expect(command?.title).toBe("Kernexa AI 가이드")
    expect(opened).toEqual([{ version: "kernexa-1", markdown: "# Kernexa AI 사용 가이드" }])
  })

  test("reports read failures without opening a dialog", async () => {
    const opened: { version: string; markdown: string }[] = []
    let failures = 0
    const command = createCompanyGuideCommand({
      enterprise: {
        ...providerAPI,
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "pass", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: false }),
        skillPacks: async () => [],
        setSkillPackEnabled: async () => [],
        openSkillPackSource: async () => undefined,
        readGuide: async () => {
          throw new Error("read failed")
        },
      },
      category: "Settings",
      open: (guide) => opened.push(guide),
      reportFailure: () => failures++,
    })

    await command?.onSelect?.()

    expect(opened).toEqual([])
    expect(failures).toBe(1)
  })
})

describe("edition help routing", () => {
  test("triggers the local guide command in enterprise mode", () => {
    const commands: string[] = []
    const links: string[] = []

    openEditionHelp({
      enterprise: true,
      href: "https://opencode.ai/docs",
      trigger: (id) => commands.push(id),
      openLink: (href) => links.push(href),
    })

    expect(commands).toEqual(["company.guide.open"])
    expect(links).toEqual([])
  })

  test("keeps the original help link in public mode", () => {
    const commands: string[] = []
    const links: string[] = []

    openEditionHelp({
      enterprise: false,
      href: "https://opencode.ai/docs",
      trigger: (id) => commands.push(id),
      openLink: (href) => links.push(href),
    })

    expect(commands).toEqual([])
    expect(links).toEqual(["https://opencode.ai/docs"])
  })
})
