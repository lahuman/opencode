import { expect, test } from "bun:test"
import type { ModelKey } from "@/context/local"
import {
  enterpriseModelState,
  modelRecoveryNoticeOwner,
  parseModelSelection,
  promptModelRecoveryNotice,
  resolveModelCandidate,
  resolveModelRecovery,
} from "@/context/model-selection"

test("falls back when the current enterprise model was deleted", () => {
  const valid = (model: ModelKey) => model.providerID === "remaining" && model.modelID === "code"

  expect(
    resolveModelCandidate(
      [
        { providerID: "deleted", modelID: "old" },
        { providerID: "remaining", modelID: "code" },
      ],
      valid,
    ),
  ).toEqual({ providerID: "remaining", modelID: "code" })
})

test("reports enterprise empty state when no model exists", () => {
  expect(enterpriseModelState({ enterprise: true, loading: false, model: undefined })).toBe("empty")
})

test("waits for agent, config, and providers before recovering a deleted selection", () => {
  const deleted = { providerID: "deleted", modelID: "old" }
  const recent = { providerID: "recent", modelID: "recent" }
  const fallback = { providerID: "fallback", modelID: "first" }
  const valid = (model: ModelKey) => model.providerID !== "deleted"

  expect(
    resolveModelRecovery({
      ready: false,
      previous: deleted,
      candidates: [deleted, undefined, undefined, recent, fallback],
      valid,
    }),
  ).toBeUndefined()

  const agent = { providerID: "agent", modelID: "preferred" }
  const configured = { providerID: "configured", modelID: "default" }
  expect(
    resolveModelRecovery({
      ready: true,
      previous: deleted,
      candidates: [deleted, agent, configured, recent, fallback],
      valid,
    }),
  ).toEqual({ previous: deleted, next: agent })
})

test("resolves all five model priorities after readiness", () => {
  const deleted = { providerID: "deleted", modelID: "old" }
  const agent = { providerID: "agent", modelID: "preferred" }
  const configured = { providerID: "configured", modelID: "default" }
  const recent = { providerID: "recent", modelID: "recent" }
  const fallback = { providerID: "fallback", modelID: "first" }
  const valid = (model: ModelKey) => model.providerID !== "deleted"
  const recover = (candidates: Array<ModelKey | undefined>) =>
    resolveModelRecovery({ ready: true, previous: deleted, candidates, valid })?.next

  expect(recover([deleted, agent, configured, recent, fallback])).toEqual(agent)
  expect(recover([deleted, undefined, configured, recent, fallback])).toEqual(configured)
  expect(recover([deleted, undefined, undefined, recent, fallback])).toEqual(recent)
  expect(recover([deleted, undefined, undefined, undefined, fallback])).toEqual(fallback)
  expect(recover([deleted, undefined, undefined, undefined, undefined])).toBeUndefined()
})

test("preserves slash-containing model IDs in configured selections", () => {
  expect(parseModelSelection("provider/family/code/latest")).toEqual({
    providerID: "provider",
    modelID: "family/code/latest",
  })
})

test("emits exactly one New Session notice across prompt recovery and later local hydration", () => {
  const previous = { providerID: "deleted", modelID: "old" }
  const next = { providerID: "remaining", modelID: "code" }
  const valid = (model: ModelKey) => model.providerID === "remaining"
  const recovery = resolveModelRecovery({ ready: true, previous, candidates: [previous, next], valid })
  const notices = [
    recovery && modelRecoveryNoticeOwner(undefined) === "prompt",
    recovery && modelRecoveryNoticeOwner(undefined) === "local",
    resolveModelRecovery({ ready: true, previous: recovery?.next, candidates: [recovery?.next], valid }) &&
      modelRecoveryNoticeOwner("ses_hydrated") === "local",
  ].filter(Boolean)

  expect(notices).toHaveLength(1)
  expect(promptModelRecoveryNotice(recovery!)).toEqual({
    title: "Model selection updated",
    description: "deleted/old is no longer available. Switched to remaining/code.",
  })
})

test("assigns exactly one existing-session recovery notice to Local", () => {
  const previous = { providerID: "deleted", modelID: "old" }
  const next = { providerID: "remaining", modelID: "code" }
  const recovery = resolveModelRecovery({
    ready: true,
    previous,
    candidates: [previous, next],
    valid: (model) => model.providerID === "remaining",
  })
  const notices = [
    recovery && modelRecoveryNoticeOwner("ses_existing") === "local",
    recovery && modelRecoveryNoticeOwner("ses_existing") === "prompt",
  ].filter(Boolean)

  expect(notices).toHaveLength(1)
})
