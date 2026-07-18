import { expect, test } from "bun:test"
import { createDialogFocusManager } from "./dialog-focus"

function harness() {
  const target = { connected: true, focused: 0 }
  const frames: (() => void)[] = []
  const manager = createDialogFocusManager({
    active: () => ({
      get isConnected() {
        return target.connected
      },
      focus: () => target.focused++,
    }),
    schedule: (run) => frames.push(run),
  })
  return { target, frames, manager }
}

test("restores the root opener only after the final dialog layer closes", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.opened(1)
  focus.manager.closed(1)
  expect(focus.frames).toHaveLength(0)

  focus.manager.closed(0)
  expect(focus.frames).toHaveLength(1)
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(1)
})

test("does not focus a disconnected opener", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.closed(0)
  focus.target.connected = false
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(0)
})

test("does not restore an old opener when another root dialog opens first", () => {
  const focus = harness()
  focus.manager.opened(0)
  focus.manager.closed(0)
  focus.manager.opened(0)
  focus.frames[0]?.()
  expect(focus.target.focused).toBe(0)
})

test("preserves the original opener when a root dialog is replaced", () => {
  const first = {
    isConnected: true,
    focused: 0,
    focus() {
      this.focused++
    },
  }
  const second = {
    isConnected: true,
    focused: 0,
    focus() {
      this.focused++
    },
  }
  const state = { active: first }
  const frames: (() => void)[] = []
  const manager = createDialogFocusManager({
    active: () => state.active,
    schedule: (run) => frames.push(run),
  })

  manager.opened(0)
  state.active = second
  manager.opened(0)
  manager.closed(0)
  frames[0]?.()

  expect(first.focused).toBe(1)
  expect(second.focused).toBe(0)
})
