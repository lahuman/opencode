import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuForEdition, nextDesktopZoomLevel } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("enterprise help menu contains only local guide and log export", () => {
    const help = desktopMenuForEdition("enterprise").find((menu) => menu.id === "help")
    expect(help?.items?.filter((item) => item.type === "item").map((item) => item.labelKey ?? item.label)).toEqual([
      "CHAI AI 가이드",
      "desktop.menu.exportLogs",
    ])
    expect(help?.items?.some((item) => item.type === "item" && "href" in item && item.href)).toBe(false)
  })

  test("public help menu keeps OpenCode links", () => {
    expect(desktopMenuForEdition("public").find((menu) => menu.id === "help")?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ href: "https://opencode.ai/v2/docs" })]),
    )
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })
})

import { terminalToggleCommand } from "@opencode/gui-plugins/terminal"
import { settingsOpenCommand } from "@/settings/command"
import { sidebarToggleCommand } from "@/shell/shell"
import { previousSessionCommand, nextSessionCommand } from "@/shell/titlebar/tab-strip"
import { goBackCommand, goForwardCommand, newTabCommand } from "@/shell/titlebar/titlebar"
import { exportLogsCommand } from "./desktop"
import { companyGuideCommand } from "@/components/dialog-company-guide"

test("every desktop menu command is one its owner registers", () => {
  const registered = new Set([
    settingsOpenCommand.id,
    exportLogsCommand.id,
    companyGuideCommand.id,
    newTabCommand.id,
    sidebarToggleCommand.id,
    goBackCommand.id,
    goForwardCommand.id,
    previousSessionCommand.id,
    nextSessionCommand.id,
    // The host publishes plugin commands as `${plugin}.${id}`; the built-in list names the terminal `terminal`.
    `terminal.${terminalToggleCommand.id}`,
  ])

  const commands = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).flatMap((entry) =>
    entry.type === "item" && entry.command ? [entry.command] : [],
  )

  expect(commands.filter((command) => !registered.has(command))).toEqual([])
})

test.each([
  { factor: 1, direction: "in", level: 1.1 },
  { factor: 1.25, direction: "out", level: 1.1 },
  // A factor read back from Chromium sits a hair off the level it was set to.
  { factor: 1.0999999, direction: "in", level: 1.25 },
  { factor: 1.1000001, direction: "out", level: 1 },
  // A pinch leaves the factor between levels, or outside them.
  { factor: 1.3, direction: "in", level: 1.5 },
  { factor: 1.3, direction: "out", level: 1.25 },
  { factor: 0.5, direction: "out", level: 1 },
  { factor: 3, direction: "in", level: 2 },
  { factor: 2, direction: "in", level: 2 },
  { factor: 1, direction: "out", level: 1 },
] as const)("zooming $direction from $factor lands on $level", ({ factor, direction, level }) => {
  expect(nextDesktopZoomLevel(factor, direction)).toBe(level)
})
