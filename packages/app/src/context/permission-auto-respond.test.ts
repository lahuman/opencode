import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  autoRespondsPermission,
  isDirectoryAutoAccepting,
  isExactAutoAccepting,
  mergePermissionSessions,
  resolvePendingAutoResponse,
  sessionAutoAccept,
} from "./permission-auto-respond"
import { createPermissionMutation } from "./permission-mutation"

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const session = (input: { id: string; parentID?: string; approvalMode?: "ask" | "auto_review" }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    approvalMode: input.approvalMode,
  }) as Session

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
    expect(sessionAutoAccept(autoAccept, sessions, permission("root"), directory)).toBeUndefined()
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("parent false override takes precedence over directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("parent true override takes precedence over disabled directory fallback", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: false,
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("prefers an exact true override over target auto-review mode", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", approvalMode: "auto_review" })]
    const autoAccept = { [`${base64Encode(directory)}/root`]: true }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
  })

  test("uses target auto-review mode before directory fallback", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", approvalMode: "auto_review" })]
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("keeps an exact false stronger than parent and directory true", () => {
    const directory = "/tmp/project"
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root", approvalMode: "auto_review" }),
    ]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: true,
      [`${base64Encode(directory)}/child`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("does not inherit a parent auto-review mode into an ask fork", () => {
    const directory = "/tmp/project"
    const sessions = [
      session({ id: "root", approvalMode: "auto_review" }),
      session({ id: "child", parentID: "root", approvalMode: "ask" }),
    ]
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})

describe("isExactAutoAccepting", () => {
  test("does not mistake directory or legacy fallback for an exact scoped enable", () => {
    const directory = "/tmp/project"
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      session: true,
    }

    expect(isExactAutoAccepting(autoAccept, "session", directory)).toBe(false)
    expect(
      isExactAutoAccepting({ ...autoAccept, [`${base64Encode(directory)}/session`]: true }, "session", directory),
    ).toBe(true)
  })
})

describe("resolvePendingAutoResponse", () => {
  test("keeps a stale child duplicate from overriding hydrated global auto-review", async () => {
    const directory = "/tmp/project"
    const mutation = createPermissionMutation()
    const child = [session({ id: "root", approvalMode: "ask" })]
    let synchronized = child
    let replies = 0

    await resolvePendingAutoResponse({
      current: () => true,
      isPending: () => true,
      disposed: () => false,
      ensureLineage: async () => {
        synchronized = mergePermissionSessions(
          [session({ id: "root", approvalMode: "auto_review" })],
          child,
        )
        return true
      },
      mutation,
      autoResponds: () =>
        autoRespondsPermission(
          { [`${base64Encode(directory)}/*`]: true },
          synchronized,
          permission("root"),
          directory,
        ),
      respond: () => replies++,
    })

    expect(synchronized).toEqual([session({ id: "root", approvalMode: "auto_review" })])
    expect(replies).toBe(0)
  })

  test("rechecks latest synchronized state after lineage hydration", async () => {
    const hydration = deferred()
    const mutation = createPermissionMutation()
    let accepting = true
    let replies = 0
    const result = resolvePendingAutoResponse({
      current: () => true,
      isPending: () => true,
      disposed: () => false,
      ensureLineage: async () => {
        await hydration.promise
        return true
      },
      mutation,
      autoResponds: () => accepting,
      respond: () => replies++,
    })

    accepting = false
    hydration.resolve()
    await result

    expect(replies).toBe(0)
  })

  test("responds once for an ordinary pending permission", async () => {
    const mutation = createPermissionMutation()
    let replies = 0

    await resolvePendingAutoResponse({
      current: () => true,
      isPending: () => true,
      disposed: () => false,
      ensureLineage: async () => true,
      mutation,
      autoResponds: () => true,
      respond: () => replies++,
    })

    expect(replies).toBe(1)
  })

  test("waits for successful approval mutation and keeps auto-review pending", async () => {
    const hold = deferred()
    const mutation = createPermissionMutation()
    let accepting = true
    let replies = 0
    const update = mutation.run(async () => {
      await hold.promise
      accepting = false
    })
    const result = resolvePendingAutoResponse({
      current: () => true,
      isPending: () => true,
      disposed: () => false,
      ensureLineage: async () => true,
      mutation,
      autoResponds: () => accepting,
      respond: () => replies++,
    })

    hold.resolve()
    await update
    await result

    expect(replies).toBe(0)
  })

  test("rechecks prior blind auto after a failed approval mutation", async () => {
    const hold = deferred()
    const mutation = createPermissionMutation()
    let replies = 0
    const update = mutation
      .run(async () => {
        await hold.promise
        throw new Error("update failed")
      })
      .catch(() => undefined)
    const result = resolvePendingAutoResponse({
      current: () => true,
      isPending: () => true,
      disposed: () => false,
      ensureLineage: async () => true,
      mutation,
      autoResponds: () => true,
      respond: () => replies++,
    })

    hold.resolve()
    await update
    await result

    expect(replies).toBe(1)
  })
})
