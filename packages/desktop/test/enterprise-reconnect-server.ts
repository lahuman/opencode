import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin, terminal: false })
lines.once("line", (line) => {
  const bootstrap = JSON.parse(line)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.headers.get("authorization") !== `Basic ${btoa(`opencode:${bootstrap.password}`)}`)
        return new Response(null, { status: 401 })
      return Response.json({ pid: process.pid, catalog: bootstrap.catalog })
    },
  })
  console.log(JSON.stringify({ url: server.url.origin }))
})
lines.once("close", () => process.exit(0))
