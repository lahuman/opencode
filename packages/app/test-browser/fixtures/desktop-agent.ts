import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import type { FormInfo } from "@opencode/client/promise"
import { agent, durable, fixture } from "./model-selection-harness"
import { flushPersisted } from "@/runtime/persistence/persist"

const defaultKey = "opencode.global.dat:agent-default"

test("Desktop keeps approval intent before agent hydration and restores the default across workspaces", async () => {
  const storage = new Map<string, string>()
  const f = fixture({ platform: "desktop", storage, agents: [], session: durable("a", undefined, "plan") })
  const first = f.mount()
  first.local.agent.set("build")
  first.local.agent.setDefault("build")
  f.set("agents", [agent("plan"), agent("build")])
  await ready(first.local.session.ready)
  expect(first.local.agent.current()?.name).toBe("build")
  flushPersisted()
  expect(storage.get(defaultKey)).toBe('{"agent":"build"}')
  first.dispose()

  const other = fixture({ platform: "desktop", storage, agents: [agent("plan"), agent("build")] })
  other.set("route", "id", undefined)
  const restored = other.mount()
  await ready(restored.local.session.ready)
  expect(restored.local.agent.current()?.name).toBe("build")
  restored.local.agent.set("plan")
  expect(restored.local.agent.current()?.name).toBe("plan")
  restored.local.session.reset()
  expect(restored.local.agent.current()?.name).toBe("build")
  other.set("sessions", "ses_a", durable("b", "high", "plan"))
  other.set("route", "id", "ses_a")
  expect(restored.local.agent.current()?.name).toBe("plan")
})

test("Desktop defaults a new draft to Build without replacing an explicit Plan draft", async () => {
  const f = fixture({ platform: "desktop" })
  f.set("route", "id", undefined)
  const { local } = f.mount()
  await ready(local.session.ready)
  expect(local.agent.current()?.name).toBe("build")
  local.agent.set("plan")
  expect(local.agent.current()?.name).toBe("plan")
  local.session.reset()
  expect(local.agent.current()?.name).toBe("build")
})

test("Web does not read or write the Desktop agent preference", () => {
  const storage = new Map([[defaultKey, "{malformed"]])
  const f = fixture({ platform: "web", storage })
  const { local } = f.mount()
  local.agent.setDefault("build")
  expect(f.reads).not.toContain(defaultKey)
  expect(storage.get(defaultKey)).toBe("{malformed")
})

test.each([
  { name: "successful Build approval", answer: "Build now", fail: false, expected: "build" },
  { name: "Keep planning", answer: "Keep planning", fail: false, expected: "plan" },
  { name: "failed Build reply", answer: "Build now", fail: true, expected: "plan" },
])("Desktop form preserves the mode for $name", async (row) => {
  const response = Promise.withResolvers<void>()
  const f = fixture({ platform: "desktop", session: durable("a", undefined, "plan"), reply: () => response.promise })
  const request: FormInfo = {
    id: `form-${row.answer}-${row.fail}`,
    sessionID: "ses_a",
    title: "Build Agent",
    metadata: { kind: "question", tool: { messageID: "msg_plan", id: "call_plan" } },
    fields: [
      {
        key: "q0",
        type: "string",
        custom: false,
        title: "Build Agent",
        description: "The plan is ready. Would you like to switch to Build?",
        options: [
          { value: "Build now", label: "Build now", description: "Switch to Build and send an implementation request" },
          { value: "Keep planning", label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
        ],
      },
    ],
  }
  const { local, element, query } = f.mount(false, request)
  await ready(local.session.ready)
  const option = Array.from(element.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find((button) =>
    button.textContent?.includes(row.answer),
  )
  expect(option).toBeDefined()
  option!.click()
  const submit = Array.from(element.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes("Submit"),
  )
  expect(submit).toBeDefined()
  const settled = Promise.withResolvers<void>()
  const unsubscribe = query.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && (event.action.type === "success" || event.action.type === "error"))
      settled.resolve()
  })
  submit!.click()
  expect(local.agent.current()?.name).toBe("plan")
  expect(f.values.get(defaultKey)).toBeUndefined()
  if (row.fail) response.reject(new Error("Approval reply failed"))
  else response.resolve()
  await settled.promise
  unsubscribe()
  expect(f.replies).toEqual([{ sessionID: "ses_a", formID: request.id, answer: { q0: row.answer } }])
  expect(local.agent.current()?.name).toBe(row.expected)
  flushPersisted()
  expect(f.values.get(defaultKey)).toBe(row.expected === "build" ? '{"agent":"build"}' : undefined)
})

function ready(check: () => boolean) {
  return new Promise<void>((resolve) =>
    createRoot((dispose) =>
      createEffect(() => {
        if (!check()) return
        dispose()
        resolve()
      }),
    ),
  )
}
