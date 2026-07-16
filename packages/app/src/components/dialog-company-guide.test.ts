import { describe, expect, test } from "bun:test"
import { createCompanyGuideCommand, openEditionHelp } from "./dialog-company-guide"

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
        credentialCatalog: async () => ({ defaultModelID: "code", models: [] }),
        credentialStatus: async () => ({ configured: true }),
        setCredentials: async () => ({ restartRequired: false }),
        clearCredentials: async () => ({ restartRequired: false }),
        readGuide: async () => ({ version: "2026.07", markdown: "# Company guide" }),
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "pass", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: false }),
      },
      category: "Settings",
      open: (guide) => opened.push(guide),
      reportFailure: () => undefined,
    })

    await command?.onSelect?.()

    expect(command?.id).toBe("company.guide.open")
    expect(opened).toEqual([{ version: "2026.07", markdown: "# Company guide" }])
  })

  test("reports read failures without opening a dialog", async () => {
    const opened: { version: string; markdown: string }[] = []
    let failures = 0
    const command = createCompanyGuideCommand({
      enterprise: {
        credentialCatalog: async () => ({ defaultModelID: "code", models: [] }),
        credentialStatus: async () => ({ configured: true }),
        setCredentials: async () => ({ restartRequired: false }),
        clearCredentials: async () => ({ restartRequired: false }),
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "pass", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: false }),
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
