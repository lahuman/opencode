export type ModelCandidate = { providerID: string; modelID: string }

export function resolveModelCandidate<T extends ModelCandidate>(
  candidates: Array<T | undefined>,
  valid: (model: T) => boolean,
) {
  return candidates.find((model): model is T => !!model && valid(model))
}

export function parseModelSelection(value: string | undefined) {
  if (!value) return
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

export function resolveModelRecovery<T extends ModelCandidate>(input: {
  ready: boolean
  previous: T | undefined
  candidates: Array<T | undefined>
  valid: (model: T) => boolean
}) {
  if (!input.ready || !input.previous || input.valid(input.previous)) return
  const next = resolveModelCandidate(input.candidates, input.valid)
  if (!next || (next.providerID === input.previous.providerID && next.modelID === input.previous.modelID)) return
  return { previous: input.previous, next }
}

export function promptModelRecoveryNotice(input: { previous: ModelCandidate; next: ModelCandidate }) {
  return {
    title: "Model selection updated",
    description: `${input.previous.providerID}/${input.previous.modelID} is no longer available. Switched to ${input.next.providerID}/${input.next.modelID}.`,
  }
}

export function modelRecoveryNoticeOwner(sessionID: string | undefined) {
  return sessionID ? "local" : "prompt"
}

export function enterpriseModelState(input: { enterprise: boolean; loading: boolean; model?: unknown }) {
  if (input.loading) return "loading"
  if (input.enterprise && !input.model) return "empty"
  return "available"
}
