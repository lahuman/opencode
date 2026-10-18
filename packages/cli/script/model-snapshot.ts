import type { BunPlugin } from "bun"

export function createModelSnapshotPlugin(catalogPath?: string): BunPlugin {
  return {
    name: "opencode-model-snapshot",
    setup(build) {
      if (!catalogPath) return
      build.onLoad({ filter: /models-dev[/\\]snapshot\.txt$/ }, async () => ({
        contents: JSON.stringify(await Bun.file(catalogPath).json()),
        loader: "text",
      }))
    },
  }
}
