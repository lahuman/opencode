import { createServer } from "node:http"

// A real HTTP/1.1 connection is required: Playwright routing and in-memory fetches
// accept streaming upload bodies that Chromium refuses to send to the desktop sidecar.
export async function createSessionHttpServer() {
  const requests: Array<{ method: string; path: string; body: unknown; contentType?: string }> = []
  const sessions = new Map<string, unknown>()
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "content-type")
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const pathname = request.url ?? "/"
    requests.push({
      method: request.method ?? "GET",
      path: pathname,
      body,
      contentType: request.headers["content-type"],
    })
    response.setHeader("content-type", "application/json")
    if (
      request.method === "POST" &&
      pathname === "/api/session" &&
      body &&
      typeof body === "object" &&
      "id" in body &&
      typeof body.id === "string"
    ) {
      sessions.set(body.id, body)
      response.end(JSON.stringify({ data: body }))
      return
    }
    const stored = sessions.get(pathname.slice("/api/session/".length))
    response.statusCode = stored ? 200 : 404
    response.end(JSON.stringify({ data: stored }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing HTTP test server address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
