import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_legacy_new_session"
const directory = "C:/OpenCode/LegacyNewSession"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("redirects a draft to the legacy new-session route", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj_legacy_new_session",
      worktree: directory,
      vcs: "git",
      name: "legacy-new-session",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    agents: [
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
      {
        id: "plan",
        name: "Plan",
        mode: "primary",
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [],
      },
    ],
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()

  const editor = page.locator('[data-component="prompt-input"]')
  const agent = page.locator('[data-action="prompt-agent"]')
  await expect(editor).toBeVisible()
  await expect(agent).toContainText("Build")

  await editor.click()
  await page.keyboard.press("Control+Shift+X")
  await expect(editor).toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await editor.press("Escape")

  await editor.fill("keep this draft")
  await page.keyboard.press("Control+Shift+X")
  await expect(editor).toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await page.keyboard.press("Control+.")
  await expect(agent).toContainText("Plan")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await expect(editor).toHaveText("keep this draft")

  await editor.fill("")
  await page.keyboard.press("Control+Shift+X")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
  await editor.press("!")
  await expect(editor).toHaveText("!")
  await expect(editor).not.toHaveClass(/(^|\s)font-mono!(\s|$)/)
})
