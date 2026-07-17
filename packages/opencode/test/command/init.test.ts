import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"

import { Command } from "@/command"
import { InstanceRef } from "@/effect/instance-ref"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Command.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

it.live("serves the scoped Investigate, Write, Verify init template", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const instance = yield* InstanceRef
      const init = yield* command.get(Command.Default.INIT)
      expect(init).toBeDefined()
      expect(init?.hints).toEqual(["$ARGUMENTS"])
      const template = yield* Effect.promise(() => Promise.resolve(init?.template ?? ""))
      expect(template).toContain("## 1. Investigate")
      expect(template).toContain("## 2. Write")
      expect(template).toContain("## 3. Verify")
      expect(template).toContain(`Only create or update \`${instance?.worktree}/AGENTS.md\``)
      expect(template).not.toContain("${path}")
      expect(template).toContain("standard library")
      expect(template).toContain("installed dependencies")
      expect(template).toContain("commands, paths, symbols, URLs, environment variables, and versions")
      expect(template).not.toMatch(/Ponytail|Caveman|Superpowers/)
      expect(template).not.toContain("install skills")
    }),
    { git: true },
  ),
)
