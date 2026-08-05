import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect } from "bun:test"
import os from "os"
import path from "path"
import { mkdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MockLanguageModelV3 } from "ai/test"
import { PlanReview } from "../../src/permission/plan-review"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { PartID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import type { Agent } from "../../src/agent/agent"
import { SessionTools } from "../../src/session/tools"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { Truncate } from "../../src/tool/truncate"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

let planLanguageRequests = 0
let planLanguageOutput = { decision: "allow", risk: "low", reason: "Read-only inspection" }
let planLanguageWait: Promise<void> | undefined

const resetPlanLanguage = () => {
  planLanguageRequests = 0
  planLanguageOutput = { decision: "allow", risk: "low", reason: "Read-only inspection" }
  planLanguageWait = undefined
}

const planProvider = ProviderTest.fake({
  getLanguage: () =>
    Effect.sync(() => {
      planLanguageRequests++
      return new MockLanguageModelV3({
        doGenerate: async () => {
          await planLanguageWait
          return {
            content: [{ type: "text", text: JSON.stringify(planLanguageOutput) }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          }
        },
      })
    }),
})
const planEnv = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    PlanReview.node,
    Session.node,
    SessionProjector.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [Provider.node, planProvider.layer],
    [InstanceStore.bootstrapNode, noopBootstrap],
  ],
)
const planIt = testEffect(planEnv)

const planFixture = (input?: {
  approvalMode?: "ask" | "auto_review"
  agentPermission?: PermissionV1.Ruleset
  sessionPermission?: PermissionV1.Ruleset
  permission?: string
  patterns?: string[]
}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const test = yield* TestInstance
    const agent: Agent.Info = {
      name: "plan",
      mode: "primary",
      native: true,
      permission: [...(input?.agentPermission ?? [])],
      options: {},
    }
    const session = yield* sessions.create({ approvalMode: input?.approvalMode ?? "auto_review" })
    if (input?.sessionPermission) {
      yield* sessions.setPermission({ sessionID: session.id, permission: input.sessionPermission })
    }
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "plan",
      model: { providerID: planProvider.model.providerID, modelID: planProvider.model.id },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: user.id,
      type: "text",
      text: "Inspect the repository",
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: user.id,
      modelID: planProvider.model.id,
      providerID: planProvider.model.providerID,
      mode: "plan",
      agent: "plan",
      path: { cwd: test.directory, root: test.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const callID = "call-plan-permission"
    const permission = input?.permission ?? "bash"
    const patterns = input?.patterns ?? ["git status"]
    const toolPart = yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: assistant.id,
      type: "tool",
      callID,
      tool: permission,
      state: { status: "running", input: {}, time: { start: Date.now() } },
    })
    const abort = new AbortController()
    const seed: PlanReview.ContextSeed = {
      agent,
      agentID: "plan",
      model: planProvider.model,
      userMessageID: user.id,
      assistantMessageID: assistant.id,
      callID,
      directory: test.directory,
      abort: abort.signal,
    }
    const plan: PlanReview.ContextInput = {
      seed,
      load: () =>
        Effect.gen(function* () {
          const current = yield* sessions.get(session.id)
          const ruleset = Permission.merge(agent.permission, current.permission ?? [])
          return {
            type: "loaded" as const,
            value: {
              ruleset,
              context: {
                ...seed,
                approvalMode: current.approvalMode,
                messages: yield* sessions.messages({ sessionID: session.id, limit: 64 }),
                rulesetDigest: PlanReview.rulesetDigest(ruleset),
              },
            },
          }
        }).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed({ type: "missing" as const }))),
    }
    return {
      abort,
      session,
      user,
      assistant,
      toolPart,
      request: {
        id: PermissionV1.ID.ascending(),
        sessionID: session.id,
        permission,
        patterns,
        metadata:
          permission === "bash"
            ? { command: patterns.join(" && "), shell: "powershell", parsed: true, cwd: test.directory }
            : {},
        always: [...patterns],
        tool: { messageID: assistant.id, callID },
        plan,
      },
    }
  })

const resolvePlanProbe = Effect.fn("PermissionTest.resolvePlanProbe")(function* (input: {
  fixture: {
    session: Session.Info
    assistant: SessionV1.Assistant
    request: { plan: PlanReview.ContextInput }
  }
  execute: () => void
  beforeAsk?: Effect.Effect<void>
  session?: Session.Interface
}) {
  const sessions = yield* Session.Service
  const tool: Tool.Def = {
    id: "bash",
    description: "Plan integration probe",
    parameters: Schema.Struct({}),
    execute: (_args, ctx) =>
      Effect.gen(function* () {
        if (input.beforeAsk) yield* input.beforeAsk
        yield* ctx.ask({
          permission: "bash",
          patterns: ["git status"],
          always: ["git status"],
          metadata: {
            command: "git status",
            shell: "powershell",
            parsed: true,
            cwd: input.fixture.session.directory,
          },
        })
        input.execute()
        return { title: "bash", metadata: {}, output: "ok" }
      }),
  }
  const deps = Layer.mergeAll(
    Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([tool]) }),
    Layer.mock(MCP.Service, {
      clients: () => Effect.succeed({}),
      tools: () => Effect.succeed({}),
    }),
    Layer.mock(Plugin.Service, {
      trigger: ((_name: unknown, _event: unknown, output: unknown) =>
        Effect.succeed(output)) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, {}),
    RuntimeFlags.layer(),
  )
  const layers = input.session
    ? Layer.merge(deps, Layer.succeed(Session.Service, Session.Service.of(input.session)))
    : deps
  const tools = yield* SessionTools.resolve({
    agent: input.fixture.request.plan.seed.agent,
    agentID: "plan",
    model: input.fixture.request.plan.seed.model,
    session: input.fixture.session,
    processor: {
      message: input.fixture.assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: yield* sessions.messages({ sessionID: input.fixture.session.id, limit: 64 }),
    promptOps: {} as never,
  }).pipe(Effect.provide(layers))
  if (!tools.bash?.execute) return yield* Effect.die(new Error("Plan probe tool is not executable"))
  return tools.bash
})

const executePlanProbe = (tool: import("ai").Tool, callID: string, abort: AbortSignal) =>
  Effect.promise(() => Promise.resolve(tool.execute!({}, { toolCallId: callID, messages: [], abortSignal: abort })))

const pauseSessionGet = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const reached = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let paused = false
  let loads = 0
  return {
    reached,
    release,
    loads: () => loads,
    session: Session.Service.of({
      ...sessions,
      get: (id) =>
        Effect.gen(function* () {
          loads++
          if (!paused) {
            paused = true
            yield* Deferred.succeed(reached, undefined)
            yield* Deferred.await(release)
          }
          return yield* sessions.get(id)
        }),
    }),
  }
})

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const waitForPlanLanguage = (count: number) =>
  Effect.gen(function* () {
    while (planLanguageRequests < count) yield* Effect.sleep("10 millis")
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} Plan review request(s)`)),
    }),
  )

const pausePlanLoad = <T extends { plan: PlanReview.ContextInput }>(request: T, at: number) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const load = request.plan.load
    let count = 0
    return {
      reached,
      release,
      loads: () => count,
      request: {
        ...request,
        plan: {
          ...request.plan,
          load: (): Effect.Effect<PlanReview.ContextLoad> =>
            Effect.gen(function* () {
              count++
              if (count === at) {
                yield* Deferred.succeed(reached, undefined)
                yield* Deferred.await(release)
              }
              return yield* load()
            }),
        },
      },
    }
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

// Permission precedence follows config insertion order. `evaluate()` uses the
// last matching rule, so later config entries intentionally override earlier
// entries even when a wildcard appears after a specific permission.

test("fromConfig - preserves top-level config key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((r) => r.permission)).toEqual(["*", "bash"])
  expect(specificFirst.map((r) => r.permission)).toEqual(["bash", "*"])

  expect(Permission.evaluate("bash", "ls", wildcardFirst).action).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).action).toBe("deny")
})

test("fromConfig - wildcard acts as fallback when it appears before specifics", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("fromConfig - top-level ordering is not sorted by wildcard specificity", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  expect(ruleset.map((r) => r.permission)).toEqual(["bash", "*", "edit", "mcp_*"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved", () => {
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.pattern)).toEqual(["*", "git *"])
  expect(Permission.evaluate("bash", "rm foo", ruleset).action).toBe("deny")
  expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("allow")
})

test("enterprise harness patterns keep safe operations allowed and ask on sensitive operations", () => {
  const rules = Permission.fromConfig({
    read: {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*.env.example": "allow",
    },
    bash: {
      "*": "allow",
      "rm -rf *": "ask",
      "git reset --hard*": "ask",
      "git clean -fd*": "ask",
    },
  })

  expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  expect(Permission.evaluate("bash", "rm -rf build", rules).action).toBe("ask")
  expect(Permission.evaluate("bash", "git reset --hard HEAD", rules).action).toBe("ask")
  expect(Permission.evaluate("bash", "git clean -fd", rules).action).toBe("ask")
  expect(Permission.evaluate("read", "README.md", rules).action).toBe("allow")
  expect(Permission.evaluate("read", ".env", rules).action).toBe("ask")
  expect(Permission.evaluate("read", ".env.production", rules).action).toBe("ask")
  expect(Permission.evaluate("read", ".env.example", rules).action).toBe("allow")
  expect(rules.filter((rule) => rule.permission === "read").map((rule) => rule.pattern)).toEqual([
    "*",
    "*.env",
    "*.env.*",
    "*.env.example",
  ])
  expect(rules.filter((rule) => rule.permission === "bash").map((rule) => rule.pattern)).toEqual([
    "*",
    "rm -rf *",
    "git reset --hard*",
    "git clean -fd*",
  ])
})

test("fromConfig - documented fallback-first example", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).action).toBe("ask")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - later wildcard permission can override earlier specific permission", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionV1.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

it.instance(
  "ask - resolves immediately when action is allow",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - throws DeniedError when action is deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - stays pending when action is ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - adds request to pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const items = yield* waitForPending(1)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - publishes asked event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        ),
      ).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

// reply tests

it.instance(
  "reply - once resolves the pending ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test1"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

it.instance(
  "enterprise permission reply log contains metadata-safe fields only",
  () => {
    const logs: unknown[] = []
    const logger = Logger.make((options) => logs.push(options.message))

    return Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_enterprise-log"),
        sessionID: SessionID.make("session_enterprise-log"),
        permission: "bash",
        patterns: ["secret-pattern", "second-pattern"],
        metadata: { credential: "metadata-secret", input: "tool-input-secret" },
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({
        requestID: PermissionV1.ID.make("per_enterprise-log"),
        reply: "reject",
        message: "feedback-secret",
      })
      yield* Fiber.await(fiber)

      const entry = logs
        .filter((item): item is ReadonlyArray<unknown> => Array.isArray(item))
        .find((item) => item[0] === "permission replied")
      expect(entry).toEqual([
        "permission replied",
        {
          permission: "bash",
          reply: "reject",
          patternCount: 2,
        },
      ])
      expect(JSON.stringify(entry)).not.toContain("secret")
    }).pipe(Effect.provide(Logger.layer([logger])))
  },
  { git: true },
)

it.instance(
  "reply - reject throws RejectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test2"), reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - reject with message throws CorrectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({
        requestID: PermissionV1.ID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).toBeInstanceOf(PermissionV1.CorrectedError)
        expect(String(err)).toContain("Use a safer command")
      }
    }),
  { git: true },
)

it.instance(
  "reply - always persists approval and resolves",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test3"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test3"), reply: "always" })
      yield* Fiber.join(fiber)

      const result = yield* ask({
        sessionID: SessionID.make("session_test2"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - alwaysAsk ignores persisted approval",
  () =>
    Effect.gen(function* () {
      const approved = yield* ask({
        id: PermissionV1.ID.make("per_always_ask_approved"),
        sessionID: SessionID.make("session_always_ask_approved"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_always_ask_approved"), reply: "always" })
      yield* Fiber.join(approved)

      const pending = yield* ask({
        id: PermissionV1.ID.make("per_always_ask_pending"),
        sessionID: SessionID.make("session_always_ask_pending"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        alwaysAsk: true,
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_always_ask_pending"), reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
    }),
  { git: true },
  { timeout: 15_000 },
)

it.instance(
  "reply - reject cancels all pending for same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test4a"), reply: "reject" })

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isFailure(ea)).toBe(true)
      expect(Exit.isFailure(eb)).toBe(true)
      if (Exit.isFailure(ea)) expect(Cause.squash(ea.cause)).toBeInstanceOf(PermissionV1.RejectedError)
      if (Exit.isFailure(eb)) expect(Cause.squash(eb.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - always resolves matching pending requests in same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test5a"), reply: "always" })

      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "reply - always keeps other session pending",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test6a"), reply: "always" })

      yield* Fiber.join(a)
      expect((yield* list()).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_test6b")])

      yield* rejectAll()
      yield* Fiber.await(b)
    }),
  { git: true },
)

it.instance(
  "reply - publishes replied event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<{
        sessionID: SessionID
        requestID: PermissionV1.ID
        reply: PermissionV1.Reply
      }>()

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)

      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type)
          Deferred.doneUnsafe(
            seen,
            Effect.succeed(
              event.data as { sessionID: SessionID; requestID: PermissionV1.ID; reply: PermissionV1.Reply },
            ),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* reply({ requestID: PermissionV1.ID.make("per_test7"), reply: "once" })
      yield* Fiber.join(fiber)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission replied event")),
          }),
        ),
      ).toEqual({
        sessionID: SessionID.make("session_test"),
        requestID: PermissionV1.ID.make("per_test7"),
        reply: "once",
      })
    }),
  { git: true },
)

it.live("permission requests stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    const a = yield* store
      .provide(
        { directory: one },
        ask({
          id: PermissionV1.ID.make("per_dir_a"),
          sessionID: SessionID.make("session_dir_a"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const b = yield* store
      .provide(
        { directory: two },
        ask({
          id: PermissionV1.ID.make("per_dir_b"),
          sessionID: SessionID.make("session_dir_b"),
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const onePending = yield* store.provide({ directory: one }, waitForPending(1))
    const twoPending = yield* store.provide({ directory: two }, waitForPending(1))

    expect(onePending).toHaveLength(1)
    expect(twoPending).toHaveLength(1)
    expect(onePending[0].id).toBe(PermissionV1.ID.make("per_dir_a"))
    expect(twoPending[0].id).toBe(PermissionV1.ID.make("per_dir_b"))

    yield* store.provide({ directory: one }, reply({ requestID: onePending[0].id, reply: "reject" }))
    yield* store.provide({ directory: two }, reply({ requestID: twoPending[0].id, reply: "reject" }))

    yield* Fiber.await(a)
    yield* Fiber.await(b)
  }),
)

it.instance(
  "pending permission rejects on instance dispose",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_dispose"),
        sessionID: SessionID.make("session_dispose"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      const ctx = yield* store.load({ directory: test.directory })
      yield* store.dispose(ctx)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "pending permission rejects on instance reload",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* reply({ requestID: PermissionV1.ID.make("per_unknown"), reply: "once" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Permission.NotFoundError", requestID: "per_unknown" })
      }
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - checks all patterns and stops on first deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - allows all patterns when all match allow rules",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - should deny even when an earlier pattern is ask",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "echo *", action: "ask" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )

      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - abort should clear pending request",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

planIt.instance(
  "plan - configured deny is authoritative and redacted before review",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        patterns: ["git status", "git log"],
        sessionPermission: [
          { permission: "bash", pattern: "git status", action: "allow" },
          { permission: "bash", pattern: "git log", action: "deny" },
          { permission: "bash", pattern: "SECRET_RULE_SENTINEL", action: "allow" },
        ],
      })
      const error = yield* fail(ask(fixture.request as never))

      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect((error as PermissionV1.DeniedError).ruleset).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(String(error)).not.toContain("SECRET_RULE_SENTINEL")
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - configured deny logs and persisted error material stay metadata-safe",
  () => {
    const logs: unknown[] = []
    const logger = Logger.make((options) => logs.push(options.message))
    const token = "Bearer abcdefghijklmnopqrstuvwxyz0123456789"
    const credential = "C:\\Users\\alice\\.ssh\\id_enterprise_secret"
    const ruleSecret = "IRRELEVANT_RULE_SECRET_SENTINEL"

    return Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        patterns: [`Get-Content \"${credential}\" ${token}`],
        sessionPermission: [
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "bash", pattern: ruleSecret, action: "allow" },
        ],
      })
      const error = yield* fail(ask(fixture.request as never))
      const sessions = yield* Session.Service
      yield* sessions.updatePart({
        ...fixture.toolPart,
        state: {
          status: "error",
          input: {},
          error: String(error),
          time: { start: 1, end: 2 },
        },
      })
      const callID = "call-plan-persisted-error-projection"
      yield* sessions.updatePart({
        ...fixture.toolPart,
        id: PartID.ascending(),
        callID,
        state: { status: "running", input: {}, time: { start: 3 } },
      })
      const current = yield* sessions.get(fixture.session.id)
      const messages = yield* sessions.messages({ sessionID: fixture.session.id, limit: 64 })
      const ruleset = Permission.merge(fixture.request.plan.seed.agent.permission, current.permission ?? [])
      const evidence = yield* PlanReview.captureEvidence({
        messages,
        context: {
          ...fixture.request.plan.seed,
          callID,
          approvalMode: current.approvalMode,
          messages,
          rulesetDigest: PlanReview.rulesetDigest(ruleset),
        },
      })
      const serialized = JSON.stringify({ logs, error, message: String(error), messages, evidence })

      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(evidence.type).toBe("captured")
      expect(serialized).not.toContain(token)
      expect(serialized).not.toContain(credential)
      expect(serialized).not.toContain(ruleSecret)
      expect(serialized).toContain('"patternCount":1')
      expect(serialized).toContain('"action":"deny"')
      expect(planLanguageRequests).toBe(0)
    }).pipe(Effect.provide(Logger.layer([logger])))
  },
  { git: true },
)

planIt.instance(
  "plan - read-only guard wins over a configured allow",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        permission: "edit",
        patterns: ["README.md"],
        sessionPermission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      const error = yield* fail(ask(fixture.request as never))

      expect(error).toBeInstanceOf(PermissionV1.PlanReadOnlyError)
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - configured allow passes only after deterministic reviewable preflight",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        sessionPermission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })

      expect(yield* ask(fixture.request as never)).toBeUndefined()
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

for (const [name, pattern, parsed] of [
  ["parser failure", "git status", false],
  ["shell alias", "alias gs='git status'", true],
  ["encoded command", "powershell -EncodedCommand Z2l0IHN0YXR1cw==", true],
  ["unresolved redirection", "Get-Content < missing.txt", true],
  ["ambiguous wildcard", "Get-Content *.txt", true],
] as const) {
  planIt.instance(
    `plan - configured bash allow hands ${name} to manual approval`,
    () =>
      Effect.gen(function* () {
        resetPlanLanguage()
        const fixture = yield* planFixture({
          patterns: [pattern],
          sessionPermission: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        const request = {
          ...fixture.request,
          metadata: {
            command: pattern,
            shell: "powershell",
            parsed,
            cwd: fixture.request.plan.seed.directory,
          },
        }
        const fiber = yield* ask(request as never).pipe(Effect.forkScoped)
        const pending = yield* waitForPending(1)

        expect(pending[0].review).toBeUndefined()
        expect(planLanguageRequests).toBe(0)
        yield* reply({ requestID: pending[0].id, reply: "reject" })
        expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      }),
    { git: true },
  )
}

planIt.instance(
  "plan - configured bash allow hands an initially broken symlink to manual approval",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const test = yield* TestInstance
      const target = path.join(test.directory, "plan-broken-target")
      const link = path.join(test.directory, "plan-broken-link")
      mkdirSync(target)
      symlinkSync(target, link, "junction")
      rmdirSync(target)
      const pattern = `Get-Content "${path.join(link, "missing.txt")}"`
      const fixture = yield* planFixture({
        patterns: [pattern],
        sessionPermission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      expect(pending[0].review).toBeUndefined()
      expect(planLanguageRequests).toBe(0)
      yield* reply({ requestID: pending[0].id, reply: "reject" })
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - static deny defeats Build approval while Build keeps legacy combined precedence",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        permission: "read",
        patterns: ["README.md"],
        sessionPermission: [{ permission: "read", pattern: "README.md", action: "deny" }],
      })
      const seedID = PermissionV1.ID.ascending()
      const seedFiber = yield* ask({
        id: seedID,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: ["README.md"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: seedID, reply: "always" })
      yield* Fiber.join(seedFiber)

      const planError = yield* fail(ask(fixture.request as never))
      expect(planError).toBeInstanceOf(PermissionV1.DeniedError)
      expect((planError as PermissionV1.DeniedError).ruleset).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(planLanguageRequests).toBe(0)

      expect(
        yield* ask({
          sessionID: fixture.session.id,
          permission: "read",
          patterns: ["README.md"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "read", pattern: "README.md", action: "deny" }],
        }),
      ).toBeUndefined()
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - manual mode publishes the existing request without review",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      expect(pending[0].review).toBeUndefined()
      expect(planLanguageRequests).toBe(0)
      yield* reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

planIt.instance(
  "plan - auto review allow completes one request without publishing or approval mutation",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()

      expect(yield* ask(fixture.request as never)).toBeUndefined()
      expect(planLanguageRequests).toBe(1)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - SessionTools observes ask to auto_review when the tool reaches ctx.ask",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      let executions = 0
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type) asked++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const tool = yield* resolvePlanProbe({ fixture, execute: () => executions++ })

      yield* sessions.setApprovalMode({ sessionID: fixture.session.id, approvalMode: "auto_review" })
      yield* executePlanProbe(tool, fixture.request.plan.seed.callID, fixture.abort.signal)

      expect(planLanguageRequests).toBe(1)
      expect(executions).toBe(1)
      expect(asked).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - SessionTools observes a fresh deny before ctx.ask and never executes",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        sessionPermission: [{ permission: "bash", pattern: "git status", action: "allow" }],
      })
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      let executions = 0
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type) asked++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const tool = yield* resolvePlanProbe({ fixture, execute: () => executions++ })

      yield* sessions.setPermission({
        sessionID: fixture.session.id,
        permission: [{ permission: "bash", pattern: "git status", action: "deny" }],
      })
      const exit = yield* executePlanProbe(tool, fixture.request.plan.seed.callID, fixture.abort.signal).pipe(
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(planLanguageRequests).toBe(0)
      expect(executions).toBe(0)
      expect(asked).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - SessionTools initial loader is invalidated by a sibling reject",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const barrier = yield* pauseSessionGet
      const events = yield* EventV2Bridge.Service
      let executions = 0
      let targetAsked = 0
      const unsub = yield* events.listen((event) => {
        if (
          event.type === Permission.Event.Asked.type &&
          (event.data as PermissionV1.Request).tool?.callID === fixture.request.plan.seed.callID
        ) targetAsked++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const tool = yield* resolvePlanProbe({ fixture, execute: () => executions++, session: barrier.session })
      const toolFiber = yield* executePlanProbe(
        tool,
        fixture.request.plan.seed.callID,
        fixture.abort.signal,
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(barrier.reached)

      const siblingID = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: siblingID,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: siblingID, reply: "reject" })
      yield* Deferred.succeed(barrier.release, undefined)

      expect(Exit.isFailure(yield* Fiber.await(toolFiber))).toBe(true)
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(barrier.loads()).toBe(1)
      expect(planLanguageRequests).toBe(0)
      expect(executions).toBe(0)
      expect(targetAsked).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - SessionTools initial loader is invalidated by caller abort",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const barrier = yield* pauseSessionGet
      let executions = 0
      const tool = yield* resolvePlanProbe({ fixture, execute: () => executions++, session: barrier.session })
      const toolFiber = yield* executePlanProbe(
        tool,
        fixture.request.plan.seed.callID,
        fixture.abort.signal,
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(barrier.reached)

      fixture.abort.abort()
      yield* Deferred.succeed(barrier.release, undefined)

      expect(Exit.isFailure(yield* Fiber.await(toolFiber))).toBe(true)
      expect(barrier.loads()).toBe(1)
      expect(planLanguageRequests).toBe(0)
      expect(executions).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - SessionTools initial loader maps a deleted session to rejection",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const sessions = yield* Session.Service
      const barrier = yield* pauseSessionGet
      let executions = 0
      const tool = yield* resolvePlanProbe({ fixture, execute: () => executions++, session: barrier.session })
      const toolFiber = yield* executePlanProbe(
        tool,
        fixture.request.plan.seed.callID,
        fixture.abort.signal,
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(barrier.reached)

      yield* sessions.remove(fixture.session.id)
      yield* Deferred.succeed(barrier.release, undefined)

      expect(Exit.isFailure(yield* Fiber.await(toolFiber))).toBe(true)
      expect(barrier.loads()).toBe(1)
      expect(planLanguageRequests).toBe(0)
      expect(executions).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - SessionTools delayed pre-ask call is stopped by the rejected turn tombstone",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.ignore))
      yield* Effect.addFinalizer(() => Effect.sync(() => fixture.abort.abort()))
      let loads = 0
      let executions = 0
      let asked = 0
      let beforeCalls = 0
      const counting = Session.Service.of({
        ...sessions,
        get: (id) =>
          Effect.sync(() => loads++).pipe(Effect.flatMap(() => sessions.get(id))),
      })
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type) asked++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const tool = yield* resolvePlanProbe({
        fixture,
        execute: () => executions++,
        beforeAsk: Effect.gen(function* () {
          beforeCalls++
          yield* Deferred.succeed(reached, undefined)
          yield* Deferred.await(release)
        }),
        session: counting,
      })
      const toolFiber = yield* executePlanProbe(
        tool,
        fixture.request.plan.seed.callID,
        fixture.abort.signal,
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(reached).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die(new Error(`pre-ask barrier ran ${beforeCalls} time(s)`)),
        }),
      )

      const rejecting = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* reply({ requestID: pending[0].id, reply: "reject" })
      expect(yield* fail(Fiber.join(rejecting))).toBeInstanceOf(PermissionV1.RejectedError)
      yield* Deferred.succeed(release, undefined)

      expect(Exit.isFailure(yield* Fiber.await(toolFiber).pipe(Effect.timeout("2 seconds")))).toBe(true)
      expect(loads).toBe(0)
      expect(planLanguageRequests).toBe(0)
      expect(executions).toBe(0)
      expect(asked).toBe(1)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - reviewer ask publishes one typed review request",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      planLanguageOutput = { decision: "ask", risk: "medium", reason: "Confirm repository inspection" }
      const fixture = yield* planFixture()
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      expect(pending[0].review).toEqual({ risk: "medium", reason: "Confirm repository inspection" })
      expect(planLanguageRequests).toBe(1)
      yield* reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

planIt.instance(
  "plan - reviewer deny returns ReviewedDeniedError without publishing",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      planLanguageOutput = { decision: "deny", risk: "high", reason: "Unsafe inspection request" }
      const fixture = yield* planFixture()
      const error = yield* fail(ask(fixture.request as never))

      expect(error).toBeInstanceOf(PermissionV1.ReviewedDeniedError)
      expect(planLanguageRequests).toBe(1)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - reviewer unavailable publishes a concise fallback review",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      planLanguageOutput = { decision: "invalid", risk: "low", reason: "ignored" }
      const fixture = yield* planFixture()
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      expect(pending[0].review).toEqual({ risk: "medium", reason: "This request needs manual review." })
      yield* reply({ requestID: pending[0].id, reply: "reject" })
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

planIt.instance(
  "plan - manual evidence fallback publishes a normal request without invoking the provider",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const sessions = yield* Session.Service
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: fixture.session.id,
        messageID: fixture.request.plan.seed.userMessageID,
        type: "text",
        text: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      })

      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].review).toBeUndefined()
      expect(planLanguageRequests).toBe(0)
      yield* reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - fresh configured deny defeats a pending human approval",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const sessions = yield* Session.Service
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      yield* sessions.setPermission({
        sessionID: fixture.session.id,
        permission: [{ permission: "bash", pattern: "git status", action: "deny" }],
      })
      yield* reply({ requestID: pending[0].id, reply: "once" })
      const error = yield* fail(Fiber.join(fiber))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect((error as PermissionV1.DeniedError).ruleset).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - fresh deny blocks a manual handoff before Event.Asked",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const paused = yield* pausePlanLoad(fixture.request, 2)
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
          asked++
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      yield* Deferred.await(paused.reached)

      yield* sessions.setPermission({
        sessionID: fixture.session.id,
        permission: [{ permission: "bash", pattern: "git status", action: "deny" }],
      })
      yield* Deferred.succeed(paused.release, undefined)
      const error = yield* fail(Fiber.join(fiber))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect((error as PermissionV1.DeniedError).ruleset).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(asked).toBe(0)
      expect(yield* list()).toHaveLength(0)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - changed target blocks a manual handoff before Event.Asked",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const test = yield* TestInstance
      const left = path.join(test.directory, "plan-handoff-left")
      const right = path.join(test.directory, "plan-handoff-right")
      const link = path.join(test.directory, "plan-handoff-link")
      mkdirSync(left)
      mkdirSync(right)
      symlinkSync(left, link, "junction")
      const pattern = `Get-Content "${path.join(link, "missing.txt")}"`
      const fixture = yield* planFixture({
        approvalMode: "ask",
        patterns: [pattern],
      })
      const paused = yield* pausePlanLoad(
        {
          ...fixture.request,
          metadata: { ...fixture.request.metadata, parsed: false },
        },
        2,
      )
      const events = yield* EventV2Bridge.Service
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
          asked++
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      yield* Deferred.await(paused.reached).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die(new Error(`manual handoff reached only ${paused.loads()} load(s)`)),
        }),
      )

      unlinkSync(link)
      symlinkSync(right, link, "junction")
      yield* Deferred.succeed(paused.release, undefined)

      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(asked).toBe(0)
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - configured allow revalidates a fresh deny before returning authority",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        sessionPermission: [{ permission: "bash", pattern: "git status", action: "allow" }],
      })
      const paused = yield* pausePlanLoad(fixture.request, 2)
      const sessions = yield* Session.Service
      const fiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      yield* Deferred.await(paused.reached)

      yield* sessions.setPermission({
        sessionID: fixture.session.id,
        permission: [{ permission: "bash", pattern: "git status", action: "deny" }],
      })
      yield* Deferred.succeed(paused.release, undefined)
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - transient allow rejects a changed canonical target before returning authority",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const test = yield* TestInstance
      const left = path.join(test.directory, "plan-transient-left")
      const right = path.join(test.directory, "plan-transient-right")
      const link = path.join(test.directory, "plan-transient-link")
      mkdirSync(left)
      mkdirSync(right)
      symlinkSync(left, link, "junction")
      const pattern = `Get-Content "${path.join(link, "missing.txt")}"`
      const fixture = yield* planFixture({ patterns: [pattern] })
      const seedID = PermissionV1.ID.ascending()
      const seedFiber = yield* ask({
        id: seedID,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: [pattern],
        metadata: {},
        always: [pattern],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: seedID, reply: "always" })
      yield* Fiber.join(seedFiber)
      const paused = yield* pausePlanLoad(fixture.request, 2)
      const fiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      yield* Deferred.await(paused.reached)

      unlinkSync(link)
      symlinkSync(right, link, "junction")
      yield* Deferred.succeed(paused.release, undefined)

      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - execution gate honors the newer session snapshot after a stale loader result",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        sessionPermission: [{ permission: "bash", pattern: "git status", action: "allow" }],
      })
      const sessions = yield* Session.Service
      const load = fixture.request.plan.load
      let loads = 0
      const request = {
        ...fixture.request,
        plan: {
          ...fixture.request.plan,
          load: () =>
            Effect.gen(function* () {
              loads++
              const loaded = yield* load()
              if (loads === 2) {
                yield* sessions.setPermission({
                  sessionID: fixture.session.id,
                  permission: [{ permission: "bash", pattern: "git status", action: "deny" }],
                })
              }
              return loaded
            }),
        },
      }

      expect(yield* fail(ask(request as never))).toBeInstanceOf(PermissionV1.DeniedError)
      expect(loads).toBe(2)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - sibling reject after human once invalidates execution revalidation",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const paused = yield* pausePlanLoad(fixture.request, 3)
      const planFiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      const planPending = (yield* waitForPending(1))[0]
      const siblingID = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: siblingID,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      yield* reply({ requestID: planPending.id, reply: "once" })
      yield* Deferred.await(paused.reached)
      yield* reply({ requestID: siblingID, reply: "reject" })
      yield* Deferred.succeed(paused.release, undefined)
      expect(yield* fail(Fiber.join(planFiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - sibling reject during Asked publish produces an ordered synthetic reply",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const siblingID = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: siblingID,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const events = yield* EventV2Bridge.Service
      const permission = yield* Permission.Service
      const order: string[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
          order.push("asked")
          return permission.reply({ requestID: siblingID, reply: "reject" }).pipe(Effect.orDie)
        }
        if (event.type === Permission.Event.Replied.type) {
          const data = event.data as { requestID: PermissionV1.ID }
          if (data.requestID === fixture.request.id) order.push("replied")
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      expect(yield* fail(ask(fixture.request as never))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(order).toEqual(["asked", "replied"])
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - symlink target swap rejects a pending human approval without a second ask",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const test = yield* TestInstance
      const left = path.join(test.directory, "plan-target-left")
      const right = path.join(test.directory, "plan-target-right")
      const link = path.join(test.directory, "plan-target-link")
      mkdirSync(left)
      mkdirSync(right)
      symlinkSync(left, link, "junction")
      const pattern = `Get-Content "${path.join(link, "missing.txt")}"`
      const fixture = yield* planFixture({ approvalMode: "ask", patterns: [pattern] })
      const events = yield* EventV2Bridge.Service
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
          asked++
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      unlinkSync(link)
      symlinkSync(right, link, "junction")
      yield* reply({ requestID: pending[0].id, reply: "once" })
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(asked).toBe(1)
      expect(yield* list()).toHaveLength(0)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - configured allow rejects a nearest-parent swap before returning authority",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const test = yield* TestInstance
      const left = path.join(test.directory, "plan-fast-left")
      const right = path.join(test.directory, "plan-fast-right")
      const link = path.join(test.directory, "plan-fast-link")
      mkdirSync(left)
      mkdirSync(right)
      symlinkSync(left, link, "junction")
      const pattern = `Get-Content "${path.join(link, "missing", "file.txt")}"`
      const fixture = yield* planFixture({
        patterns: [pattern],
        sessionPermission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const paused = yield* pausePlanLoad(fixture.request, 2)
      const fiber = yield* ask(paused.request as never).pipe(Effect.forkScoped)
      yield* Deferred.await(paused.reached)

      unlinkSync(link)
      symlinkSync(right, link, "junction")
      yield* Deferred.succeed(paused.release, undefined)
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* list()).toHaveLength(0)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - caller abort clears a published request and rejects a late reply",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const events = yield* EventV2Bridge.Service
      const replies: PermissionV1.Reply[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type) {
          const data = event.data as { requestID: PermissionV1.ID; reply: PermissionV1.Reply }
          if (data.requestID === fixture.request.id) replies.push(data.reply)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)

      fixture.abort.abort()
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* list()).toHaveLength(0)
      expect(replies).toEqual(["reject"])
      expect(yield* fail(reply({ requestID: pending[0].id, reply: "once" }))).toBeInstanceOf(
        PermissionV1.NotFoundError,
      )
    }),
  { git: true },
)

planIt.instance(
  "plan - caller abort synchronously hides pending authority from a racing reply",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const events = yield* EventV2Bridge.Service
      const permission = yield* Permission.Service
      const context = yield* Effect.context<never>()
      const replies: PermissionV1.Reply[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type) {
          const data = event.data as { requestID: PermissionV1.ID; reply: PermissionV1.Reply }
          if (data.requestID === fixture.request.id) replies.push(data.reply)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = (yield* waitForPending(1))[0]
      let immediate: ReadonlyArray<PermissionV1.Request> = []
      let replyError: unknown
      const probe = () => {
        immediate = Effect.runSyncWith(context)(permission.list())
        const exit = Effect.runSyncExitWith(context)(
          permission.reply({ requestID: pending.id, reply: "always" }),
        )
        replyError = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      }
      fixture.abort.signal.addEventListener("abort", probe, { once: true })
      yield* Effect.addFinalizer(() => Effect.sync(() => fixture.abort.signal.removeEventListener("abort", probe)))

      fixture.abort.abort()
      expect(immediate).toHaveLength(0)
      expect(replyError).toBeInstanceOf(PermissionV1.NotFoundError)
      expect(yield* list()).toHaveLength(0)
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(replies).toEqual(["reject"])
    }),
  { git: true },
)

planIt.instance(
  "plan - already aborted request rejects before loading context",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      let loads = 0
      const request = {
        ...fixture.request,
        plan: {
          ...fixture.request.plan,
          load: () => {
            loads++
            return fixture.request.plan.load()
          },
        },
      }
      fixture.abort.abort()

      expect(yield* fail(ask(request as never))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(loads).toBe(0)
      expect(planLanguageRequests).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - instance reload rejects a published request with one synthetic reply",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const events = yield* EventV2Bridge.Service
      const replied = yield* Deferred.make<PermissionV1.Reply>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type) {
          const data = event.data as { requestID: PermissionV1.ID; reply: PermissionV1.Reply }
          if (data.requestID === fixture.request.id) Deferred.doneUnsafe(replied, Effect.succeed(data.reply))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const store = yield* InstanceStore.Service
      const test = yield* TestInstance
      yield* store.reload({ directory: test.directory })
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* Deferred.await(replied).pipe(Effect.timeout("1 second"))).toBe("reject")
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - sibling reject promptly invalidates a provider that never settles",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      planLanguageWait = new Promise<void>(() => undefined)
      const fixture = yield* planFixture()
      const sibling = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: sibling,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      yield* waitForPlanLanguage(1)

      yield* reply({ requestID: sibling, reply: "reject" })
      expect(yield* fail(Fiber.join(fiber)).pipe(Effect.timeout("1 second"))).toBeInstanceOf(
        PermissionV1.RejectedError,
      )
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

for (const decision of ["allow", "ask"] as const) {
  planIt.instance(
    `plan - sibling reject discards a delayed reviewer ${decision} without a late ask`,
    () =>
      Effect.gen(function* () {
        resetPlanLanguage()
        planLanguageOutput = {
          decision,
          risk: decision === "allow" ? "low" : "medium",
          reason: decision === "allow" ? "Read-only inspection" : "Needs human review",
        }
        let release: () => void = () => {}
        planLanguageWait = new Promise<void>((resolve) => {
          release = resolve
        })
        const fixture = yield* planFixture()
        const events = yield* EventV2Bridge.Service
        let targetAsked = 0
        const unsub = yield* events.listen((event) => {
          if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
            targetAsked++
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)
        const sibling = PermissionV1.ID.ascending()
        const siblingFiber = yield* ask({
          id: sibling,
          sessionID: fixture.session.id,
          permission: "read",
          patterns: ["README.md"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
        yield* waitForPlanLanguage(1)

        yield* reply({ requestID: sibling, reply: "reject" })
        release()

        expect(yield* fail(Fiber.join(fiber)).pipe(Effect.timeout("1 second"))).toBeInstanceOf(
          PermissionV1.RejectedError,
        )
        expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)
        expect(targetAsked).toBe(0)
        expect(yield* list()).toHaveLength(0)
      }),
    { git: true },
    10_000,
  )
}

planIt.instance(
  "plan - caller abort promptly invalidates a provider that never settles",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      planLanguageWait = new Promise<void>(() => undefined)
      const fixture = yield* planFixture()
      const events = yield* EventV2Bridge.Service
      let asked = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type && (event.data as PermissionV1.Request).id === fixture.request.id) {
          asked++
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      yield* waitForPlanLanguage(1)

      fixture.abort.abort()
      expect(yield* fail(Fiber.join(fiber)).pipe(Effect.timeout("1 second"))).toBeInstanceOf(
        PermissionV1.RejectedError,
      )
      expect(asked).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - reviewer fresh configured deny maps to redacted DeniedError",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      let release: () => void = () => undefined
      planLanguageWait = new Promise<void>((resolve) => {
        release = resolve
      })
      const fixture = yield* planFixture()
      const sessions = yield* Session.Service
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      yield* waitForPlanLanguage(1)

      yield* sessions.setPermission({
        sessionID: fixture.session.id,
        permission: [
          { permission: "bash", pattern: "git status", action: "deny" },
          { permission: "bash", pattern: "REVIEW_SECRET_SENTINEL", action: "allow" },
        ],
      })
      release()
      const error = yield* fail(Fiber.join(fiber))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect((error as PermissionV1.DeniedError).ruleset).toEqual([
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(String(error)).not.toContain("REVIEW_SECRET_SENTINEL")
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - reviewer mode change hands off to normal manual approval",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      let release: () => void = () => undefined
      planLanguageWait = new Promise<void>((resolve) => {
        release = resolve
      })
      const fixture = yield* planFixture()
      const sessions = yield* Session.Service
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      yield* waitForPlanLanguage(1)

      yield* sessions.setApprovalMode({ sessionID: fixture.session.id, approvalMode: "ask" })
      release()
      const pending = yield* waitForPending(1)
      expect(pending[0].review).toBeUndefined()
      yield* reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - an always reply is exact once and cannot approve a sibling Plan request",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const first = { ...fixture.request, id: PermissionV1.ID.ascending() }
      const second = { ...fixture.request, id: PermissionV1.ID.ascending() }
      const firstFiber = yield* ask(first as never).pipe(Effect.forkScoped)
      const secondFiber = yield* ask(second as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(2)

      yield* reply({ requestID: first.id, reply: "always" })
      yield* Fiber.join(firstFiber)
      expect((yield* list()).map((item) => item.id)).toEqual([second.id])

      yield* reply({ requestID: second.id, reply: "reject" })
      expect(yield* fail(Fiber.join(secondFiber))).toBeInstanceOf(PermissionV1.RejectedError)

      const build = PermissionV1.ID.ascending()
      const buildFiber = yield* ask({
        id: build,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect((yield* waitForPending(1))[0].id).toBe(build)
      yield* reply({ requestID: build, reply: "reject" })
      expect(yield* fail(Fiber.join(buildFiber))).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - alwaysAsk ignores Build approval while Build siblings keep legacy cascade",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const seedID = PermissionV1.ID.ascending()
      const seedFiber = yield* ask({
        id: seedID,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git status"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: seedID, reply: "always" })
      yield* Fiber.join(seedFiber)

      const first = { ...fixture.request, id: PermissionV1.ID.ascending(), alwaysAsk: true }
      const second = { ...fixture.request, id: PermissionV1.ID.ascending(), alwaysAsk: true }
      const firstFiber = yield* ask(first as never).pipe(Effect.forkScoped)
      const secondFiber = yield* ask(second as never).pipe(Effect.forkScoped)
      yield* waitForPending(2)

      const buildSource = PermissionV1.ID.ascending()
      const buildSibling = PermissionV1.ID.ascending()
      const sourceFiber = yield* ask({
        id: buildSource,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: ["git log"],
        metadata: {},
        always: ["git log"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const siblingFiber = yield* ask({
        id: buildSibling,
        sessionID: fixture.session.id,
        permission: "bash",
        patterns: ["git log"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(4)

      yield* reply({ requestID: buildSource, reply: "always" })
      yield* Fiber.join(sourceFiber)
      yield* Fiber.join(siblingFiber)
      expect(new Set((yield* list()).map((item) => item.id))).toEqual(new Set([first.id, second.id]))

      yield* reply({ requestID: first.id, reply: "always" })
      yield* Fiber.join(firstFiber)
      expect((yield* list()).map((item) => item.id)).toEqual([second.id])
      yield* reply({ requestID: second.id, reply: "reject" })
      expect(yield* fail(Fiber.join(secondFiber))).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - external_directory approval and following bash use independent review decisions",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({
        approvalMode: "auto_review",
        permission: "external_directory",
        patterns: ["C:\\outside"],
      })
      const sessions = yield* Session.Service
      const externalFiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const external = yield* waitForPending(1)
      expect(external[0].review).toBeUndefined()
      expect(planLanguageRequests).toBe(0)
      yield* reply({ requestID: external[0].id, reply: "once" })
      yield* Fiber.join(externalFiber)

      yield* sessions.updatePart({
        ...fixture.toolPart,
        state: {
          status: "completed",
          input: {},
          output: "approved",
          title: "External directory",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const callID = "call-following-bash"
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: fixture.session.id,
        messageID: fixture.request.plan.seed.assistantMessageID,
        type: "tool",
        callID,
        tool: "bash",
        state: { status: "running", input: {}, time: { start: Date.now() } },
      })
      const seed = { ...fixture.request.plan.seed, callID }
      const load = fixture.request.plan.load
      const plan: PlanReview.ContextInput = {
        seed,
        load: () =>
          load().pipe(
            Effect.map((loaded) =>
              loaded.type === "missing"
                ? loaded
                : { ...loaded, value: { ...loaded.value, context: { ...loaded.value.context, ...seed } } },
            ),
          ),
      }
      expect(
        yield* ask({
          id: PermissionV1.ID.ascending(),
          sessionID: fixture.session.id,
          permission: "bash",
          patterns: ["git status"],
          metadata: {
            command: "git status",
            shell: "powershell",
            parsed: true,
            cwd: fixture.request.plan.seed.directory,
          },
          always: [],
          tool: { messageID: seed.assistantMessageID, callID },
          plan,
        }),
      ).toBeUndefined()
      expect(planLanguageRequests).toBe(1)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
  10_000,
)

planIt.instance(
  "plan - rejected turn tombstone stops a delayed sibling before loading context",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture({ approvalMode: "ask" })
      const fiber = yield* ask(fixture.request as never).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* reply({ requestID: pending[0].id, reply: "reject" })
      expect(yield* fail(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)

      let loads = 0
      const delayed = {
        ...fixture.request,
        id: PermissionV1.ID.ascending(),
        plan: {
          ...fixture.request.plan,
          load: () => {
            loads++
            return fixture.request.plan.load()
          },
        },
      }
      expect(yield* fail(ask(delayed as never))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(loads).toBe(0)
      expect(planLanguageRequests).toBe(0)
    }),
  { git: true },
)

planIt.instance(
  "plan - full tombstone capacity evicts the oldest freshly proven inactive turn",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const blocker = yield* Deferred.make<void>()
      let loads = 0
      const fibers: Fiber.Fiber<void, PermissionV1.Error>[] = []
      for (let index = 0; index < 64; index++) {
        const assistantMessageID = MessageID.make(`msg_evictable_tombstone_${index}`)
        const callID = `call-evictable-tombstone-${index}`
        const plan: PlanReview.ContextInput = {
          seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
          load: () =>
            Effect.gen(function* () {
              loads++
              yield* Deferred.await(blocker)
              return { type: "missing" as const }
            }),
        }
        fibers.push(
          yield* ask({
            ...fixture.request,
            id: PermissionV1.ID.ascending(),
            tool: { messageID: assistantMessageID, callID },
            plan,
          } as never).pipe(Effect.forkScoped),
        )
      }
      yield* Effect.gen(function* () {
        while (loads < 64) yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("2 seconds"))

      const sibling = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: sibling,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: sibling, reply: "reject" })
      expect((yield* Effect.all(fibers.map(Fiber.await), { concurrency: "unbounded" })).every(Exit.isFailure)).toBe(
        true,
      )
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)

      let lateLoads = 0
      const assistantMessageID = MessageID.make("msg_evictable_tombstone_late")
      const callID = "call-evictable-tombstone-late"
      expect(
        yield* fail(
          ask({
            ...fixture.request,
            id: PermissionV1.ID.ascending(),
            tool: { messageID: assistantMessageID, callID },
            plan: {
              seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
              load: () => {
                lateLoads++
                return Effect.succeed({ type: "missing" as const })
              },
            },
          } as never),
        ),
      ).toBeInstanceOf(PermissionV1.RejectedError)
      expect(lateLoads).toBe(1)
    }),
  { git: true },
  15_000,
)

planIt.instance(
  "plan - full tombstone capacity fails closed while every persisted turn is active",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const sessions = yield* Session.Service
      const blocker = yield* Deferred.make<void>()
      let loads = 0
      const fibers: Fiber.Fiber<void, PermissionV1.Error>[] = []
      for (let index = 0; index < 64; index++) {
        const assistantMessageID = MessageID.make(`msg_active_tombstone_${index}`)
        const callID = `call-active-tombstone-${index}`
        yield* sessions.updateMessage({ ...fixture.assistant, id: assistantMessageID })
        yield* sessions.updatePart({
          ...fixture.toolPart,
          id: PartID.ascending(),
          messageID: assistantMessageID,
          callID,
        })
        const plan: PlanReview.ContextInput = {
          seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
          load: () =>
            Effect.gen(function* () {
              loads++
              yield* Deferred.await(blocker)
              return { type: "missing" as const }
            }),
        }
        fibers.push(
          yield* ask({
            ...fixture.request,
            id: PermissionV1.ID.ascending(),
            tool: { messageID: assistantMessageID, callID },
            plan,
          } as never).pipe(Effect.forkScoped),
        )
      }
      yield* Effect.gen(function* () {
        while (loads < 64) yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("2 seconds"))

      const sibling = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: sibling,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: sibling, reply: "reject" })
      expect((yield* Effect.all(fibers.map(Fiber.await), { concurrency: "unbounded" })).every(Exit.isFailure)).toBe(
        true,
      )
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)

      let lateLoads = 0
      const assistantMessageID = MessageID.make("msg_active_tombstone_late")
      const callID = "call-active-tombstone-late"
      expect(
        yield* fail(
          ask({
            ...fixture.request,
            id: PermissionV1.ID.ascending(),
            tool: { messageID: assistantMessageID, callID },
            plan: {
              seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
              load: () => {
                lateLoads++
                return Effect.succeed({ type: "missing" as const })
              },
            },
          } as never),
        ),
      ).toBeInstanceOf(PermissionV1.RejectedError)
      expect(lateLoads).toBe(0)
    }),
  { git: true },
  15_000,
)

planIt.instance(
  "plan - tombstone saturation fails closed and instance reload clears it",
  () =>
    Effect.gen(function* () {
      resetPlanLanguage()
      const fixture = yield* planFixture()
      const blocker = yield* Deferred.make<void>()
      let loads = 0
      const fibers: Fiber.Fiber<void, PermissionV1.Error>[] = []
      for (let index = 0; index < 65; index++) {
        const assistantMessageID = MessageID.make(`msg_tombstone_${index}`)
        const callID = `call-tombstone-${index}`
        const plan: PlanReview.ContextInput = {
          seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
          load: () =>
            Effect.gen(function* () {
              loads++
              yield* Deferred.await(blocker)
              return { type: "missing" as const }
            }),
        }
        fibers.push(
          yield* ask({
            ...fixture.request,
            id: PermissionV1.ID.ascending(),
            tool: { messageID: assistantMessageID, callID },
            plan,
          } as never).pipe(Effect.forkScoped),
        )
      }
      yield* Effect.gen(function* () {
        while (loads < 65) yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("2 seconds"))

      const sibling = PermissionV1.ID.ascending()
      const siblingFiber = yield* ask({
        id: sibling,
        sessionID: fixture.session.id,
        permission: "read",
        patterns: ["README.md"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: sibling, reply: "reject" })
      const exits = yield* Effect.all(fibers.map(Fiber.await), { concurrency: "unbounded" })
      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(yield* fail(Fiber.join(siblingFiber))).toBeInstanceOf(PermissionV1.RejectedError)

      let lateLoads = 0
      const assistantMessageID = MessageID.make("msg_tombstone_late")
      const callID = "call-tombstone-late"
      const late = {
        ...fixture.request,
        id: PermissionV1.ID.ascending(),
        tool: { messageID: assistantMessageID, callID },
        plan: {
          seed: { ...fixture.request.plan.seed, assistantMessageID, callID },
          load: () => {
            lateLoads++
            return Effect.succeed({ type: "missing" as const })
          },
        },
      }
      expect(yield* fail(ask(late as never))).toBeInstanceOf(PermissionV1.RejectedError)
      expect(lateLoads).toBe(0)

      const store = yield* InstanceStore.Service
      const test = yield* TestInstance
      yield* store.reload({ directory: test.directory })
      expect(yield* fail(ask({ ...late, id: PermissionV1.ID.ascending() } as never))).toBeInstanceOf(
        PermissionV1.RejectedError,
      )
      expect(lateLoads).toBe(1)
    }),
  { git: true },
  15_000,
)
