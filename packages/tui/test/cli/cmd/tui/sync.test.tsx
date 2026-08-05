/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent, PermissionRequest } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function permissionEvent(id: string, sessionID: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_permission_${id}`,
      type: "permission.asked",
      properties: {
        id,
        sessionID,
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      } satisfies PermissionRequest,
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount({ state: tmp.path })

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount({ state: tmp.path })

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps auto-review server permissions pending in normal mode", async () => {
    const sessionID = "ses_auto_review"
    const { app, emit, replies, sync } = await mount({
      fetch(url) {
        if (url.pathname !== "/session") return undefined
        return json([
          {
            id: sessionID,
            slug: "auto-review",
            projectID: "proj_test",
            directory,
            title: "Auto review",
            approvalMode: "auto_review",
            time: { created: 0, updated: 0 },
          },
        ])
      },
    })

    try {
      await wait(() => sync.session.get(sessionID)?.approvalMode === "auto_review")
      emit(permissionEvent("permission_normal", sessionID))
      await Bun.sleep(30)

      expect(replies).toEqual([])
      expect(sync.data.permission[sessionID]).toEqual([
        {
          id: "permission_normal",
          sessionID,
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("blind auto replies once without enqueuing the permission", async () => {
    const sessionID = "ses_auto"
    const { app, emit, permission, replies, sync } = await mount({ args: { auto: true } })

    try {
      expect(permission.mode).toBe("auto")
      emit(permissionEvent("permission_auto", sessionID))
      await wait(() => replies.length === 1)

      expect(replies).toEqual([
        {
          method: "POST",
          path: "/permission/permission_auto/reply",
          body: { reply: "once" },
        },
      ])
      expect(sync.data.permission[sessionID]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("claims a deferred blind reply until the synchronized reply event", async () => {
    const sessionID = "ses_deferred"
    const { app, emit, permission, replies, sync } = await mount({ args: { auto: true } })
    let release!: () => void
    const pending = permission.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    try {
      await wait(() => permission.approvalPending)
      emit(permissionEvent("permission_deferred", sessionID))
      emit(permissionEvent("permission_deferred", sessionID))
      await Bun.sleep(30)

      expect(replies).toEqual([])
      expect(sync.data.permission[sessionID]).toHaveLength(1)

      release()
      await pending
      await wait(() => replies.length === 1)
      emit(permissionEvent("permission_deferred", sessionID))
      await Bun.sleep(30)

      expect(replies).toHaveLength(1)
      expect(sync.data.permission[sessionID]).toHaveLength(1)
    } finally {
      release?.()
      app.renderer.destroy()
    }
  })

  test("drops a deferred blind reply after a synchronized reply", async () => {
    const sessionID = "ses_replied"
    const { app, emit, permission, replies, sync } = await mount({ args: { auto: true } })
    let release!: () => void
    const pending = permission.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    try {
      await wait(() => permission.approvalPending)
      emit(permissionEvent("permission_replied", sessionID))
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_permission_replied",
          type: "permission.replied",
          properties: { requestID: "permission_replied", sessionID, reply: "once" },
        },
      })
      await wait(() => sync.data.permission[sessionID]?.length === 0)
      release()
      await pending
      await Bun.sleep(30)

      expect(replies).toEqual([])
      expect(sync.data.permission[sessionID]).toEqual([])
    } finally {
      release?.()
      app.renderer.destroy()
    }
  })

  test("releases a deferred claim after a data-less reply response", async () => {
    const sessionID = "ses_retry"
    let responses = 0
    const { app, emit, permission, replies } = await mount({
      args: { auto: true },
      fetch(url) {
        if (!/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return undefined
        responses++
        if (responses === 1) return new Response(null, { status: 200 })
        return json(true)
      },
    })
    let release!: () => void
    const pending = permission.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    try {
      await wait(() => permission.approvalPending)
      emit(permissionEvent("permission_retry", sessionID))
      release()
      await pending
      await wait(() => replies.length === 1)

      emit(permissionEvent("permission_retry", sessionID))
      await wait(() => replies.length === 2)

      expect(responses).toBe(2)
    } finally {
      release?.()
      app.renderer.destroy()
    }
  })
})
