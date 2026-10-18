import { Effect } from "effect"
import { ServerProcess } from "../../cli/src/server-process"

await Effect.runPromise(ServerProcess.run({ mode: "stdio", hostname: "127.0.0.1", port: 0 }))
