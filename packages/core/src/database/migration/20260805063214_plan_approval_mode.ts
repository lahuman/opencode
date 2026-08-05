import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805063214_plan_approval_mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`approval_mode\` text DEFAULT 'ask' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
