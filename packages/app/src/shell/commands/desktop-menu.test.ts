import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuForEdition } from "./desktop-menu"

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
      expect.arrayContaining([expect.objectContaining({ href: "https://opencode.ai/docs" })]),
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
