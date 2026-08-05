import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPermissionMutation, toggleBlindAuto } from "./permission-mutation"

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("createPermissionMutation", () => {
  test("returns completed values and can be reused after settlement", async () => {
    await createRoot(async (dispose) => {
      const mutation = createPermissionMutation()

      expect(await mutation.run(async () => "first")).toEqual({ status: "completed", value: "first" })
      expect(await mutation.run(async () => "second")).toEqual({ status: "completed", value: "second" })
      expect(mutation.pending()).toBe(false)
      dispose()
    })
  })

  test("propagates rejection and releases the mutation", async () => {
    await createRoot(async (dispose) => {
      const mutation = createPermissionMutation()

      await expect(
        mutation.run(async () => {
          throw new Error("failed")
        }),
      ).rejects.toThrow("failed")
      expect(mutation.pending()).toBe(false)
      expect(await mutation.run(async () => 2)).toEqual({ status: "completed", value: 2 })
      dispose()
    })
  })

  test("acquires synchronously and returns busy without queuing", async () => {
    await createRoot(async (dispose) => {
      const hold = deferred()
      const mutation = createPermissionMutation()
      const calls: string[] = []
      const first = mutation.run(async () => {
        calls.push("first")
        await hold.promise
        calls.push("released")
      })

      const second = await mutation.run(async () => calls.push("second"))

      expect(mutation.pending()).toBe(true)
      expect(second).toEqual({ status: "busy" })
      expect(calls).toEqual(["first"])
      hold.resolve()
      await first
      expect(calls).toEqual(["first", "released"])
      dispose()
    })
  })

  test("idle resolves before and after work and waits for the current action", async () => {
    await createRoot(async (dispose) => {
      const hold = deferred()
      const mutation = createPermissionMutation()

      await mutation.idle()
      const action = mutation.run(() => hold.promise)
      let idle = false
      const waiting = mutation.idle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)

      hold.resolve()
      await action
      await waiting
      expect(idle).toBe(true)
      await mutation.idle()
      dispose()
    })
  })

  test("separate mutations remain independent", async () => {
    await createRoot(async (dispose) => {
      const hold = deferred()
      const first = createPermissionMutation()
      const second = createPermissionMutation()
      const active = first.run(() => hold.promise)

      expect(await second.run(async () => "done")).toEqual({ status: "completed", value: "done" })
      expect(first.pending()).toBe(true)
      hold.resolve()
      await active
      dispose()
    })
  })

  test("resets only registered directory drafts and honors cleanup", () => {
    createRoot((dispose) => {
      const mutation = createPermissionMutation()
      const calls: string[] = []
      const cleanup = mutation.registerDraftReset("/a", () => calls.push("a"))
      mutation.registerDraftReset("/b", () => calls.push("b"))

      mutation.resetDrafts("/a")
      cleanup()
      mutation.resetDrafts("/a")
      mutation.resetDrafts("/b")

      expect(calls).toEqual(["a", "b"])
      dispose()
    })
  })

  test("uses a reset snapshot when callbacks mutate registration", () => {
    createRoot((dispose) => {
      const mutation = createPermissionMutation()
      const calls: string[] = []
      let added = false
      let cleanupSecond: () => void = () => {}
      mutation.registerDraftReset("/repo", () => {
        calls.push("first")
        cleanupSecond()
        if (added) return
        added = true
        mutation.registerDraftReset("/repo", () => calls.push("third"))
      })
      cleanupSecond = mutation.registerDraftReset("/repo", () => calls.push("second"))

      mutation.resetDrafts("/repo")
      expect(calls).toEqual(["first", "second"])
      mutation.resetDrafts("/repo")
      expect(calls).toEqual(["first", "second", "first", "third"])
      dispose()
    })
  })
})

describe("toggleBlindAuto", () => {
  const setup = () => {
    const calls: string[] = []
    return {
      calls,
      callbacks: {
        updateToAsk: async (sessionID: string) => {
          calls.push(`update:${sessionID}`)
        },
        resetDrafts: () => calls.push("reset"),
        enableSession: (sessionID: string) => calls.push(`session-enable:${sessionID}`),
        disableSession: (sessionID: string) => calls.push(`session-disable:${sessionID}`),
        enableDirectory: () => calls.push("directory-enable"),
        disableDirectory: () => calls.push("directory-disable"),
      },
    }
  }

  test("updates every session to ask before enabling exact blind auto", async () => {
    const input = setup()

    await toggleBlindAuto({ checked: true, active: false, sessionID: "session-1", ...input.callbacks })

    expect(input.calls).toEqual(["update:session-1", "session-enable:session-1"])
  })

  test("does not enable a session when the ask update fails", async () => {
    const input = setup()
    input.callbacks.updateToAsk = async () => {
      input.calls.push("update")
      throw new Error("update failed")
    }

    await expect(
      toggleBlindAuto({ checked: true, active: false, sessionID: "session-1", ...input.callbacks }),
    ).rejects.toThrow("update failed")
    expect(input.calls).toEqual(["update"])
  })

  test("disables a session without changing server mode", async () => {
    const input = setup()

    await toggleBlindAuto({ checked: false, active: true, sessionID: "session-1", ...input.callbacks })

    expect(input.calls).toEqual(["session-disable:session-1"])
  })

  test("resets matching drafts before enabling a directory", async () => {
    const input = setup()

    await toggleBlindAuto({ checked: true, active: false, ...input.callbacks })

    expect(input.calls).toEqual(["reset", "directory-enable"])
  })

  test("disables a directory without resetting drafts", async () => {
    const input = setup()

    await toggleBlindAuto({ checked: false, active: true, ...input.callbacks })

    expect(input.calls).toEqual(["directory-disable"])
  })

  test("keeps matching state unchanged", async () => {
    const input = setup()

    await toggleBlindAuto({ checked: true, active: true, sessionID: "session-1", ...input.callbacks })

    expect(input.calls).toEqual([])
  })
})
