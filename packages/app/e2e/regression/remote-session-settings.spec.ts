import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = { ...session("ses_server_b", directoryB, "Server B session"), approvalMode: "auto_review" as const }

for (const newLayoutDesigns of [true, false]) {
  const layout = newLayoutDesigns ? "new" : "legacy"

  test(`${layout} session settings update server mode before enabling remote auto-accept`, async ({ page }) => {
    const permissionRequests: string[] = []
    const sessionUpdates: SessionUpdate[] = []
    await mockServers(page, permissionRequests, [], sessionUpdates)
    await configureServers(page, [], newLayoutDesigns)

    await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
    await expect(page.getByText(sessionB.title).first()).toBeVisible()
    await page.keyboard.press("Control+,")

    const dialog = page.locator(newLayoutDesigns ? ".settings-v2-dialog" : ".settings-dialog")
    const autoAccept = dialog.locator('[data-action="settings-auto-accept-permissions"]')
    const input = autoAccept.getByRole("switch")
    const control = autoAccept.locator('[data-slot="switch-control"]')
    await expect(autoAccept).toBeVisible()
    await expect(input).toBeEnabled()
    await expect(input).not.toBeChecked()
    permissionRequests.length = 0

    await control.click()
    await expect.poll(() => sessionUpdates.length).toBe(1)
    const update = sessionUpdates[0]!
    try {
      expect({ origin: update.origin, directory: update.directory, sessionID: update.sessionID }).toEqual({
        origin: serverB,
        directory: directoryB,
        sessionID: sessionB.id,
      })
      expect(update.body).toEqual({ approvalMode: "ask" })
      await expect(input).toBeDisabled()
      await expect(input).not.toBeChecked()
      expect(permissionRequests).toEqual([])

      await control.click({ force: true })
      await page.waitForTimeout(100)
      expect(sessionUpdates).toHaveLength(1)
      expect(permissionRequests).toEqual([])
    } finally {
      update.respond({ ...sessionB, approvalMode: "ask" })
    }
    await expect(input).toBeEnabled()
    await expect(input).toBeChecked()
    await expect
      .poll(() =>
        permissionRequests.some((request) => {
          const url = new URL(request)
          return url.origin === serverB && url.searchParams.get("directory") === directoryB
        }),
      )
      .toBe(true)
    expect(permissionRequests.every((request) => new URL(request).origin === serverB)).toBe(true)

    await dialog.getByRole("tab", { name: "Models" }).click()
    await expect(dialog.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
    await expect(dialog.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
  })

  for (const response of ["rejected", "data-less", "auto_review"] as const) {
    test(`${layout} session settings keep auto-accept off when the mode update is ${response}`, async ({ page }) => {
      const permissionRequests: string[] = []
      const sessionUpdates: SessionUpdate[] = []
      await mockServers(page, permissionRequests, [], sessionUpdates)
      await configureServers(page, [], newLayoutDesigns)

      await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
      await expect(page.getByText(sessionB.title).first()).toBeVisible()
      await page.keyboard.press("Control+,")

      const dialog = page.locator(newLayoutDesigns ? ".settings-v2-dialog" : ".settings-dialog")
      const autoAccept = dialog.locator('[data-action="settings-auto-accept-permissions"]')
      const input = autoAccept.getByRole("switch")
      await expect(input).toBeEnabled()
      await expect(input).not.toBeChecked()
      permissionRequests.length = 0

      await autoAccept.locator('[data-slot="switch-control"]').click()
      await expect.poll(() => sessionUpdates.length).toBe(1)
      const update = sessionUpdates[0]!
      try {
        await expect(input).toBeDisabled()
      } finally {
        if (response === "rejected") update.respond({ name: "InternalServerError" }, 500)
        if (response === "data-less") update.respond(null)
        if (response === "auto_review") update.respond({ ...sessionB, approvalMode: "auto_review" })
      }

      await expect(input).toBeEnabled()
      await expect(input).not.toBeChecked()
      await expect(
        page
          .locator(newLayoutDesigns ? '[data-component="toast-v2"]' : '[data-component="toast"][data-variant="error"]')
          .filter({ hasText: "Request failed" }),
      ).toHaveCount(1)
      expect(permissionRequests).toEqual([])
    })
  }
}

test("auto-accept responds for an unfocused server session", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, {
    server: serverA,
    retry: 20,
  })
  await mockServers(page, permissionRequests, permissionResponses)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")
  const autoAccept = page.locator(".settings-v2-dialog").locator('[data-action="settings-auto-accept-permissions"]')
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(autoAccept.getByRole("switch")).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverA && url.searchParams.get("directory") === directoryA
      }),
    )
    .toBe(true)
  await page.keyboard.press("Escape")

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await transport.waitForConnection()

  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a",
      type: "permission.asked",
      properties: {
        id: "permission-background-a",
        sessionID: sessionA.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: directoryA,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { response: "once" },
      },
    ])

  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a-child",
      type: "permission.asked",
      properties: {
        id: "permission-background-a-child",
        sessionID: childSessionA.id,
        permission: "bash",
        patterns: ["git diff"],
        metadata: {},
        always: [],
      },
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: directoryA,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { response: "once" },
      },
      {
        origin: serverA,
        directory: directoryA,
        sessionID: childSessionA.id,
        permissionID: "permission-background-a-child",
        body: { response: "once" },
      },
    ])
})

type PermissionResponse = {
  origin: string
  directory?: string
  sessionID: string
  permissionID: string
  body: unknown
}

type SessionUpdate = {
  origin: string
  directory?: string
  sessionID: string
  body: unknown
  respond: (body: unknown, status?: number) => void
}

async function configureServers(
  page: Page,
  tabs: { type: "session"; server: string; sessionId: string }[] = [],
  newLayoutDesigns = true,
) {
  await page.addInitScript(
    ({ serverB, tabs, newLayoutDesigns }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.11" }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverB)
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs, newLayoutDesigns },
  )
}

async function mockServers(
  page: Page,
  permissionRequests: string[],
  permissionResponses: PermissionResponse[] = [],
  sessionUpdates?: SessionUpdate[],
) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestDirectory = url.searchParams.get("directory")
    const response = url.pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (route.request().method() === "POST" && response) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestDirectory ?? undefined,
        sessionID: response[1]!,
        permissionID: response[2]!,
        body: route.request().postDataJSON(),
      })
      return json(route, true)
    }
    const update = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (route.request().method() === "PATCH" && update) {
      const body = route.request().postDataJSON()
      const headerDirectory = route.request().headers()["x-opencode-directory"]
      const updateDirectory = requestDirectory ?? (headerDirectory ? decodeURIComponent(headerDirectory) : undefined)
      if (updateDirectory && updateDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
      if (!sessionUpdates) return json(route, { ...update, approvalMode: "ask" })
      const result = await new Promise<{ body: unknown; status: number }>((resolve) => {
        sessionUpdates.push({
          origin: url.origin,
          directory: updateDirectory,
          sessionID: update.id,
          body,
          respond: (next, status = 200) => resolve({ body: next, status }),
        })
      })
      return json(route, result.body, result.status)
    }
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model" || url.pathname === "/api/agent")
      return json(route, { data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/permission/request", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          worktree: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory })
    if (url.pathname === "/api/session") return json(route, { data: sessions.map(currentSession), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    if (url.pathname === "/session") return json(route, sessions)
    const current = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (current) return json(route, current)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (url.pathname === "/permission") {
      permissionRequests.push(url.toString())
      return json(route, [])
    }
    if (["/skill", "/command", "/lsp", "/formatter", "/question", "/vcs/diff", "/pty/shells"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider") return json(route, provider(remote ? "server-b" : "server-a"))
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: remote ? sessionB.projectID : "project-server-a",
        worktree: directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: directory,
      })
    if (url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
