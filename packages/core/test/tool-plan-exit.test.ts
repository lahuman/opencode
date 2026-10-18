import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Form } from "@opencode/core/form"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { Tool } from "@opencode/core/tool"
import { PlanExitTool } from "@opencode/core/tool/plugin/plan-exit"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const plugin = makeLocationNode({
  name: "test/plan-exit",
  layer: Layer.effectDiscard(registerToolPlugin(PlanExitTool.Plugin)),
  deps: [Tool.node, Session.node, Form.node, Permission.node],
})

function suite(answer: Form.TerminalState) {
  return testEffect(
    AppNodeBuilder.build(LayerNode.group([plugin, Session.node, Tool.node, SessionInbox.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Form.node.replace(
        Layer.mock(Form.Service, {
          ask: (input) =>
            Effect.sync(() => {
              const field = input.fields[0]
              if (field.type !== "string") throw new Error("Expected a single-choice approval")
              expect(field.custom).toBe(false)
              expect(field.options?.map((option) => option.value)).toEqual(["Build now", "Keep planning"])
              return answer
            }),
        }),
      ),
    ]),
  )
}

const run = Effect.fnUntraced(function* (agent: Agent.ID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make("/project") }) })
  yield* sessions.switchAgent({ sessionID: session.id, agent })
  const registry = yield* Tool.Service
  const result = yield* executeTool(registry, {
    sessionID: session.id,
    ...toolIdentity,
    agent,
    call: {
      type: "tool-call",
      id: "call-plan-exit",
      name: "plan_exit",
      input: { plan: "# Approved plan\n\nPreserve enterprise settings." },
    },
  })
  const inbox = yield* SessionInbox.Service
  return { result, session: yield* sessions.get(session.id), pending: yield* inbox.list(session.id) }
})

describe("Plan exit approval", () => {
  suite({ status: "answered", answer: { q0: "Build now" } }).effect(
    "admits the approved plan durably and switches to Build",
    () =>
      Effect.gen(function* () {
        const state = yield* run(Agent.ID.make("plan"))
        expect(state.result).toMatchObject({ status: "completed", output: { agent: "build" } })
        expect(state.session.agent).toBe(Agent.defaultID)
        expect(state.pending).toHaveLength(1)
        expect(state.pending[0]).toMatchObject({
          type: "user",
          delivery: "steer",
          payload: {
            text: "The following plan has been approved. Implement it now.\n\n# Approved plan\n\nPreserve enterprise settings.",
          },
        })
      }),
  )
  for (const answer of [{ status: "cancelled" }, { status: "answered", answer: { q0: "Keep planning" } }] as const) {
    suite(answer).effect(
      `keeps Plan mode when ${answer.status === "cancelled" ? "dismissed" : "planning continues"}`,
      () =>
        Effect.gen(function* () {
          const state = yield* run(Agent.ID.make("plan"))
          expect(state.result).toMatchObject({ status: "completed", output: { agent: "plan" } })
          expect(state.session.agent).toBe(Agent.ID.make("plan"))
          expect(state.pending).toHaveLength(0)
        }),
    )
  }
  suite({ status: "answered", answer: { q0: "Build now" } }).effect("rejects use outside Plan mode", () =>
    Effect.gen(function* () {
      const state = yield* run(Agent.defaultID)
      expect(state.result.status).toBe("error")
      expect(state.pending).toHaveLength(0)
    }),
  )
})
