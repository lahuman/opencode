import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal"
export type ApprovalMode = "ask" | "auto_review"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const [store, setStore] = createStore<{
      mode: PermissionMode
      approvalMode: ApprovalMode
      approvalPending: boolean
    }>({
      mode: args.auto ? "auto" : "normal",
      approvalMode: "ask",
      approvalPending: false,
    })
    let approvalIdle = Promise.resolve()

    return {
      get mode() {
        return store.mode
      },
      get approvalMode() {
        return store.approvalMode
      },
      get approvalPending() {
        return store.approvalPending
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
      },
      setApprovalMode(mode: ApprovalMode) {
        setStore({
          approvalMode: mode,
          mode: mode === "auto_review" ? "normal" : store.mode,
        })
      },
      async run<T>(task: () => Promise<T>) {
        if (store.approvalPending) return { acquired: false as const }
        let resolve!: () => void
        const idle = new Promise<void>((done) => {
          resolve = done
        })
        approvalIdle = idle
        setStore("approvalPending", true)
        try {
          return { acquired: true as const, value: await task() }
        } finally {
          setStore("approvalPending", false)
          resolve()
        }
      },
      idle() {
        return approvalIdle
      },
    }
  },
})
