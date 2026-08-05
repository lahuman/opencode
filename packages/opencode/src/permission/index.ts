import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PlanReview } from "./plan-review"

export const Event = PermissionV1.Event

type PlanAskInput = Omit<PermissionV1.AskInput, "ruleset"> & {
  alwaysAsk?: boolean
  plan: PlanReview.ContextInput
  ruleset?: never
}

type LegacyAskInput = PermissionV1.AskInput & {
  alwaysAsk?: boolean
  plan?: never
}

type AskInput = PlanAskInput | LegacyAskInput

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
  alwaysAsk: boolean
  planEnvelope?: PlanReview.ExecutionEnvelope
  planOwnership?: PlanOwnership
  published?: boolean
  replied?: boolean
}

interface PlanOwnership {
  sessionID: PermissionV1.Request["sessionID"]
  assistantMessageID: PlanReview.ContextSeed["assistantMessageID"]
  invalidated: Deferred.Deferred<void>
  controller: AbortController
  abort: AbortSignal
  abortListener: () => void
  settled: boolean
  failure?: PermissionV1.RejectedError | PermissionV1.CorrectedError
  syntheticReply?: PermissionV1.Request
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  reviewing: Map<PermissionV1.ID, PlanOwnership>
  rejectedPlanTurns: Map<
    PermissionV1.Request["sessionID"],
    { assistantIDs: Set<PlanReview.ContextSeed["assistantMessageID"]>; saturated: boolean }
  >
}

const PLAN_DENY_RULESET: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "deny" }]

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          reviewing: new Map<PermissionV1.ID, PlanOwnership>(),
          rejectedPlanTurns: new Map<
            PermissionV1.Request["sessionID"],
            { assistantIDs: Set<PlanReview.ContextSeed["assistantMessageID"]>; saturated: boolean }
          >(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const published = yield* Effect.sync(() => {
              const result: PermissionV1.Request[] = []
              for (const item of state.reviewing.values()) {
                item.controller.abort()
                Deferred.doneUnsafe(item.invalidated, Effect.succeed(undefined))
                item.abort.removeEventListener("abort", item.abortListener)
                item.settled = true
              }
              for (const item of state.pending.values()) {
                Deferred.doneUnsafe(item.deferred, Effect.fail(new PermissionV1.RejectedError()))
                if (item.planOwnership && item.published && !item.replied) {
                  item.replied = true
                  result.push(item.info)
                }
              }
              state.pending.clear()
              state.reviewing.clear()
              state.rejectedPlanTurns.clear()
              return result
            })
            for (const item of published) {
              yield* events.publish(Event.Replied, {
                sessionID: item.sessionID,
                requestID: item.id,
                reply: "reject",
              })
            }
          }),
        )

        return state
      }),
    )

    const reviewer = yield* PlanReview.Service

    const isActive = (current: State, id: PermissionV1.ID, ownership: PlanOwnership) =>
      Effect.sync(() => current.reviewing.get(id) === ownership && !ownership.settled)

    const invalidate = (current: State, id: PermissionV1.ID, ownership: PlanOwnership) => {
      if (current.reviewing.get(id) === ownership) current.reviewing.delete(id)
      ownership.controller.abort()
      Deferred.doneUnsafe(ownership.invalidated, Effect.succeed(undefined))
    }

    const recordRejectedTurn = (current: State, ownership: PlanOwnership) => {
      const turn = current.rejectedPlanTurns.get(ownership.sessionID) ?? {
        assistantIDs: new Set<PlanReview.ContextSeed["assistantMessageID"]>(),
        saturated: false,
      }
      if (!turn.assistantIDs.has(ownership.assistantMessageID)) {
        if (turn.assistantIDs.size < 64) turn.assistantIDs.add(ownership.assistantMessageID)
        else turn.saturated = true
      }
      current.rejectedPlanTurns.set(ownership.sessionID, turn)
    }

    const ensureRejectedTurnCapacity = Effect.fn("Permission.ensureRejectedTurnCapacity")(function* (input: {
      current: State
      sessionID: PermissionV1.Request["sessionID"]
      assistantMessageID: PlanReview.ContextSeed["assistantMessageID"]
    }): Effect.fn.Return<boolean> {
      const observed = yield* Effect.sync(() => {
        const turn = input.current.rejectedPlanTurns.get(input.sessionID)
        if (!turn || turn.assistantIDs.size < 64) return { type: "ready" as const }
        if (turn.saturated || turn.assistantIDs.has(input.assistantMessageID)) {
          return { type: "blocked" as const }
        }
        return { type: "full" as const, assistantMessageIDs: [...turn.assistantIDs] }
      })
      if (observed.type === "ready") return true
      if (observed.type === "blocked") return false
      const evictable = yield* reviewer.findEvictableTurn({
        sessionID: input.sessionID,
        assistantMessageIDs: observed.assistantMessageIDs,
      })
      if (!evictable) return false
      const claimed = yield* Effect.sync(() => {
        const turn = input.current.rejectedPlanTurns.get(input.sessionID)
        if (!turn || turn.assistantIDs.size < 64) return "ready" as const
        if (turn.saturated || turn.assistantIDs.has(input.assistantMessageID)) return "blocked" as const
        if (!turn.assistantIDs.delete(evictable)) return "retry" as const
        return "ready" as const
      })
      if (claimed === "ready") return true
      if (claimed === "blocked") return false
      return yield* ensureRejectedTurnCapacity(input)
    })

    const finishPlan = (
      current: State,
      id: PermissionV1.ID,
      ownership: PlanOwnership,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const removed = yield* Effect.sync(() => {
          if (ownership.settled) return
          ownership.settled = true
          ownership.abort.removeEventListener("abort", ownership.abortListener)
          if (current.reviewing.get(id) === ownership) current.reviewing.delete(id)
          if (ownership.syntheticReply) {
            const info = ownership.syntheticReply
            ownership.syntheticReply = undefined
            return info
          }
          const item = current.pending.get(id)
          if (!item || item.planOwnership !== ownership) return
          current.pending.delete(id)
          const error = ownership.failure ?? new PermissionV1.RejectedError()
          Deferred.doneUnsafe(item.deferred, Effect.fail(error))
          if (!item.published || item.replied) return
          item.replied = true
          return item.info
        })
        if (!removed) return
        yield* events.publish(Event.Replied, {
          sessionID: removed.sessionID,
          requestID: removed.id,
          reply: "reject",
        })
      })

    const askLegacy = Effect.fn("Permission.askLegacy")(function* (input: LegacyAskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, alwaysAsk, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, alwaysAsk ? [] : approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred, alwaysAsk: Boolean(alwaysAsk) })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const askPlan = Effect.fn("Permission.askPlan")(function* (input: PlanAskInput) {
      const current = yield* InstanceState.get(state)
      const id = input.id ?? PermissionV1.ID.ascending()
      const ownership = yield* Effect.sync(() => {
        const rejected = current.rejectedPlanTurns.get(input.sessionID)
        if (
          rejected?.saturated ||
          rejected?.assistantIDs.has(input.plan.seed.assistantMessageID)
        ) return
        if (input.plan.seed.abort.aborted) return
        if (current.reviewing.has(id) || current.pending.has(id)) return
        const controller = new AbortController()
        const invalidated = Deferred.makeUnsafe<void>()
        const abortListener = () => {
          const item = current.pending.get(id)
          if (item?.planOwnership === result) {
            current.pending.delete(id)
            const error = result.failure ?? new PermissionV1.RejectedError()
            result.failure = error
            Deferred.doneUnsafe(item.deferred, Effect.fail(error))
            if (item.published && !item.replied) {
              item.replied = true
              result.syntheticReply = item.info
            }
          }
          if (current.reviewing.get(id) === result) current.reviewing.delete(id)
          controller.abort()
          Deferred.doneUnsafe(invalidated, Effect.succeed(undefined))
        }
        const result: PlanOwnership = {
          sessionID: input.sessionID,
          assistantMessageID: input.plan.seed.assistantMessageID,
          invalidated,
          controller,
          abort: input.plan.seed.abort,
          abortListener,
          settled: false,
        }
        current.reviewing.set(id, result)
        result.abort.addEventListener("abort", abortListener, { once: true })
        if (result.abort.aborted) abortListener()
        return result
      })
      if (!ownership) return yield* new PermissionV1.RejectedError()
      const request = yield* Effect.sync(
        (): PlanReview.ReviewRequest => ({
          id,
          sessionID: input.sessionID,
          permission: input.permission,
          patterns: [...input.patterns],
          metadata: { ...input.metadata },
          always: [...input.always],
          tool: input.tool,
        }),
      ).pipe(Effect.onError(() => finishPlan(current, id, ownership)))

      const active = () => isActive(current, id, ownership)
      const combined = AbortSignal.any([input.plan.seed.abort, ownership.controller.signal])
      const mapOutcome = (outcome: PlanReview.Outcome): Effect.Effect<void, PermissionV1.Error> => {
        if (outcome.type === "allow") return Effect.void
        if (outcome.type === "configured_deny") {
          return new PermissionV1.DeniedError({ ruleset: PLAN_DENY_RULESET })
        }
        if (outcome.type === "read_only") {
          return new PermissionV1.PlanReadOnlyError({ reason: outcome.reason, alternative: outcome.alternative })
        }
        if (outcome.type === "deny") {
          return new PermissionV1.ReviewedDeniedError({ reason: outcome.reason, alternative: outcome.alternative })
        }
        return ownership.failure ?? new PermissionV1.RejectedError()
      }
      const applyOutcome = (outcome: PlanReview.Outcome) =>
        Effect.sync(() => {
          if (current.reviewing.get(id) !== ownership || ownership.settled) return false
          current.reviewing.delete(id)
          ownership.abort.removeEventListener("abort", ownership.abortListener)
          ownership.settled = true
          return true
        }).pipe(Effect.flatMap((active) => mapOutcome(active ? outcome : { type: "cancel" })))

      const run = Effect.gen(function* () {
        if (
          !(yield* ensureRejectedTurnCapacity({
            current,
            sessionID: input.sessionID,
            assistantMessageID: input.plan.seed.assistantMessageID,
          }))
        ) return { type: "cancel" } as const
        const loaded = yield* input.plan.load()
        if (loaded.type === "missing") return { type: "cancel" } as const
        const context: PlanReview.Context = { ...loaded.value.context, abort: combined }
        if (
          request.sessionID !== context.messages[0]?.info.sessionID ||
          context.userMessageID !== input.plan.seed.userMessageID ||
          context.assistantMessageID !== input.plan.seed.assistantMessageID ||
          context.callID !== input.plan.seed.callID ||
          context.agentID !== input.plan.seed.agentID ||
          context.directory !== input.plan.seed.directory ||
          context.model.providerID !== input.plan.seed.model.providerID ||
          context.model.id !== input.plan.seed.model.id ||
          request.tool?.messageID !== context.assistantMessageID ||
          request.tool.callID !== context.callID ||
          PlanReview.rulesetDigest(loaded.value.ruleset) !== context.rulesetDigest
        ) return { type: "cancel" } as const

        const configured = request.patterns.map((pattern) =>
          evaluate(request.permission, pattern, loaded.value.ruleset),
        )
        for (const rule of configured) {
          yield* Effect.logInfo("evaluated", {
            permission: request.permission,
            patternCount: request.patterns.length,
            action: rule.action,
          })
        }
        if (configured.some((rule) => rule.action === "deny")) return { type: "configured_deny" } as const

        const checked = yield* PlanReview.preflight({ request, context })
        if (checked.type === "deny") {
          return { type: "read_only", reason: checked.reason, alternative: checked.alternative } as const
        }

        const capture = (model: boolean) =>
          reviewer.captureExecution({ request, context, ruleset: loaded.value.ruleset, reviewer: model })
        const revalidate = (envelope: PlanReview.ExecutionEnvelope) =>
          reviewer.revalidateExecution({ request, plan: input.plan, envelope, isActive: active })
        const handoff = (envelope: PlanReview.ExecutionEnvelope, review?: PermissionV1.Review) =>
          Effect.gen(function* () {
            const humanEnvelope: PlanReview.ExecutionEnvelope = {
              ...envelope,
              reviewer: false,
              evidenceDigest: undefined,
            }
            const gate = yield* revalidate(humanEnvelope)
            if (gate.type !== "allow") return gate
            const deferred = Deferred.makeUnsafe<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
            const info: PermissionV1.Request = {
              id,
              sessionID: request.sessionID,
              permission: request.permission,
              patterns: request.patterns,
              metadata: request.metadata,
              always: request.always,
              tool: request.tool,
              ...(review ? { review } : {}),
            }
            yield* Effect.logInfo("asking", {
              id,
              permission: info.permission,
              patternCount: info.patterns.length,
            })
            const entry: PendingEntry = {
              info,
              deferred,
              alwaysAsk: Boolean(input.alwaysAsk),
              planEnvelope: humanEnvelope,
              planOwnership: ownership,
              published: false,
            }
            const inserted = yield* Effect.sync(() => {
              if (current.reviewing.get(id) !== ownership || ownership.settled || current.pending.has(id)) return false
              current.pending.set(id, entry)
              return true
            })
            if (!inserted) return { type: "cancel" } as const
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* events.publish(Event.Asked, info)
                const orphaned = yield* Effect.sync(() => {
                  entry.published = true
                  if (current.pending.get(id) === entry || entry.replied) return false
                  entry.replied = true
                  return true
                })
                if (!orphaned) return
                yield* events.publish(Event.Replied, {
                  sessionID: info.sessionID,
                  requestID: info.id,
                  reply: "reject",
                })
              }),
            )
            yield* Deferred.await(deferred)
            return yield* revalidate(humanEnvelope)
          })

        if (checked.type === "ask") {
          const captured = yield* capture(false)
          if (captured.type === "outcome") return captured.value
          return yield* handoff(captured.value)
        }

        const configuredAllow = configured.every((rule) => rule.action === "allow")
        const transientAllow =
          !input.alwaysAsk &&
          request.patterns.every(
            (pattern) => evaluate(request.permission, pattern, current.approved).action === "allow",
          )
        if (configuredAllow || transientAllow) {
          const captured = yield* capture(false)
          if (captured.type === "outcome") return captured.value
          return yield* revalidate(captured.value)
        }

        if (context.approvalMode !== "auto_review") {
          const captured = yield* capture(false)
          if (captured.type === "outcome") return captured.value
          return yield* handoff(captured.value)
        }

        const captured = yield* capture(true)
        if (captured.type === "outcome") {
          if (captured.value.type !== "manual") return captured.value
          const manual = yield* capture(false)
          if (manual.type === "outcome") return manual.value
          return yield* handoff(manual.value)
        }
        const outcome = yield* reviewer.review({
          request,
          context,
          findings: checked.findings,
          isActive: active,
        })
        if (outcome.type === "allow") return yield* revalidate(captured.value)
        if (outcome.type === "ask") return yield* handoff(captured.value, outcome.review)
        if (outcome.type === "manual") return yield* handoff(captured.value)
        return outcome
      })

      return yield* Effect.race(
        run,
        Deferred.await(ownership.invalidated).pipe(Effect.as({ type: "cancel" } as const)),
      ).pipe(
        Effect.flatMap(applyOutcome),
        Effect.ensuring(finishPlan(current, id, ownership)),
      )
    })

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      if (input.plan) return yield* askPlan(input)
      return yield* askLegacy(input)
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.get(state)
      const existing = current.pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      if (
        existing.planOwnership &&
        (current.reviewing.get(input.requestID) !== existing.planOwnership || existing.planOwnership.settled)
      ) {
        yield* finishPlan(current, input.requestID, existing.planOwnership)
        return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      }
      const response =
        input.reply === "always" && (existing.alwaysAsk || existing.planOwnership) ? "once" : input.reply

      if (response === "reject") {
        const error = input.message
          ? new PermissionV1.CorrectedError({ feedback: input.message })
          : new PermissionV1.RejectedError()
        const siblings = yield* Effect.sync(() => {
          current.pending.delete(input.requestID)
          existing.replied = true
          if (existing.planOwnership) existing.planOwnership.failure = error
          const items: PendingEntry[] = []
          for (const [id, item] of current.pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            current.pending.delete(id)
            if (item.planOwnership) item.planOwnership.failure = new PermissionV1.RejectedError()
            if (item.published !== false) item.replied = true
            items.push(item)
          }
          for (const [id, ownership] of current.reviewing.entries()) {
            if (ownership.sessionID !== existing.info.sessionID) continue
            recordRejectedTurn(current, ownership)
            invalidate(current, id, ownership)
          }
          if (existing.planOwnership) Deferred.doneUnsafe(existing.deferred, Effect.fail(error))
          for (const item of items) {
            if (item.planOwnership) Deferred.doneUnsafe(item.deferred, Effect.fail(new PermissionV1.RejectedError()))
          }
          return items
        })
        yield* Effect.logInfo("permission replied", {
          permission: existing.info.permission,
          reply: response,
          patternCount: existing.info.patterns.length,
        })
        yield* events.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          reply: response,
        })
        if (!existing.planOwnership) Deferred.doneUnsafe(existing.deferred, Effect.fail(error))
        for (const item of siblings) {
          if (item.published === false) continue
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          if (!item.planOwnership) {
            Deferred.doneUnsafe(item.deferred, Effect.fail(new PermissionV1.RejectedError()))
          }
        }
        return
      }

      yield* Effect.logInfo("permission replied", {
        permission: existing.info.permission,
        reply: response,
        patternCount: existing.info.patterns.length,
      })
      current.pending.delete(input.requestID)
      existing.replied = true
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: response,
      })
      yield* Deferred.succeed(existing.deferred, undefined)
      if (response === "once") return

      for (const pattern of existing.info.always) {
        current.approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of current.pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        if (item.alwaysAsk) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, current.approved).action === "allow",
        )
        if (!ok) continue
        current.pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const current = yield* InstanceState.get(state)
      return Array.from(current.pending.values())
        .filter(
          (item) =>
            item.published !== false &&
            (!item.planOwnership ||
              (current.reviewing.get(item.info.id) === item.planOwnership && !item.planOwnership.settled)),
        )
        .map((item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, PlanReview.node] })

export * as Permission from "."
