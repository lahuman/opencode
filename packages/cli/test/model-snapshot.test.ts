import { expect, test } from "bun:test"
import path from "node:path"
import { createModelSnapshotPlugin } from "../script/model-snapshot"
import { tmpdir } from "./fixture/tmpdir"

test("enterprise CLI bundles only its packaged catalog and public builds keep their snapshot", async () => {
  await using root = await tmpdir()
  const snapshot = path.join(root.path, "models-dev", "snapshot.txt")
  const catalog = path.join(root.path, "company.json")
  const entry = path.join(root.path, "entry.ts")
  await Bun.write(snapshot, JSON.stringify({ public: { models: { public_model: {} } } }))
  await Bun.write(catalog, JSON.stringify({ company: { models: { company_model: {} } } }))
  await Bun.write(
    entry,
    'import snapshot from "./models-dev/snapshot.txt" with { type: "text" }; export default JSON.parse(snapshot)',
  )
  for (const enterprise of [true, false]) {
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      plugins: [createModelSnapshotPlugin(enterprise ? catalog : undefined)],
    })
    expect(build.success).toBe(true)
    const output = await build.outputs[0].text()
    const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)
    expect(Object.keys(module.default)).toEqual([enterprise ? "company" : "public"])
    if (enterprise) expect(output).not.toContain("public_model")
  }
})
