export type DialogFocusTarget = {
  readonly isConnected: boolean
  focus(): void
}

export function createDialogFocusManager(input: {
  active(): DialogFocusTarget | undefined
  schedule(run: () => void): void
}) {
  const state: {
    generation: number
    target?: DialogFocusTarget
  } = { generation: 0 }

  return {
    opened(layer: number) {
      if (layer !== 0) return
      state.generation++
      state.target ??= input.active()
    },
    closed(remaining: number) {
      if (remaining !== 0) return
      const target = state.target
      const generation = state.generation
      state.target = undefined
      if (!target) return
      input.schedule(() => {
        if (state.generation !== generation) return
        if (!target.isConnected) return
        target.focus()
      })
    },
  }
}
