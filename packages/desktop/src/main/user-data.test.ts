import { expect, test } from "bun:test"
import { resolveDesktopUserDataPath } from "./user-data"

test("uses LOCALAPPDATA for enterprise Windows state", () => {
  expect(
    resolveDesktopUserDataPath({
      platform: "win32",
      enterprise: true,
      appId: "com.company.opencode.pilot",
      localAppData: "C:\\Users\\Avery\\AppData\\Local",
      appData: () => {
        throw new Error("Electron appData must not be read")
      },
    }),
  ).toBe("C:\\Users\\Avery\\AppData\\Local\\com.company.opencode.pilot")
})

test("fails closed when enterprise Windows LOCALAPPDATA is unavailable", () => {
  expect(() =>
    resolveDesktopUserDataPath({
      platform: "win32",
      enterprise: true,
      appId: "com.company.opencode.pilot",
      appData: () => {
        throw new Error("Electron appData must not be read")
      },
    }),
  ).toThrow("LOCALAPPDATA is required for enterprise OpenCode Pilot on Windows")
})

test("keeps ordinary Windows state under Electron appData", () => {
  expect(
    resolveDesktopUserDataPath({
      platform: "win32",
      enterprise: false,
      appId: "ai.opencode.desktop",
      localAppData: "C:\\Users\\Avery\\AppData\\Local",
      appData: () => "C:\\Users\\Avery\\AppData\\Roaming",
    }),
  ).toBe("C:\\Users\\Avery\\AppData\\Roaming\\ai.opencode.desktop")
})

test("keeps non-Windows enterprise state under Electron appData", () => {
  expect(
    resolveDesktopUserDataPath({
      platform: "darwin",
      enterprise: true,
      appId: "com.company.opencode.pilot",
      localAppData: "/Users/avery/Library/Application Support",
      appData: () => "/Users/avery/Library/Application Support",
    }),
  ).toBe("/Users/avery/Library/Application Support/com.company.opencode.pilot")
})
