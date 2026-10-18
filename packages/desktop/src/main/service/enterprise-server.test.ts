import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { launchEnterpriseProcess } from "./enterprise-process"

test("runs authenticated company diagnostics through the private V2 desktop service", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chai-server-"))
  const observed: { authorization: string | null; gateway: string | null; stream: boolean }[] = []
  let mode = "pass"
  let redirected = 0
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      redirected++
      return Response.json({})
    },
  })
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean; tools?: unknown[] }
      observed.push({
        authorization: request.headers.get("Authorization"),
        gateway: request.headers.get("X-Gateway"),
        stream: Boolean(body.stream),
      })
      if (mode === "redirect") return Response.redirect(destination.url, 302)
      if (mode === "auth")
        return Response.json({ error: { message: "diagnostic-secret", code: "invalid_api_key" } }, { status: 401 })
      const tool = Boolean(body.tools?.length)
      if (body.stream) {
        if (mode === "stream")
          return new Response("not an event stream", { headers: { "content-type": "text/event-stream" } })
        const chunks = [
          {
            id: "chat_probe",
            object: "chat.completion.chunk",
            created: 0,
            model: "company-model",
            choices: [
              {
                index: 0,
                delta: tool
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_probe",
                          type: "function",
                          function: { name: mode === "tool" ? "wrong_tool" : "enterprise_probe", arguments: "{}" },
                        },
                      ],
                    }
                  : { role: "assistant", content: "OK" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chat_probe",
            object: "chat.completion.chunk",
            created: 0,
            model: "company-model",
            choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({
        id: "chat_probe",
        object: "chat.completion",
        created: 0,
        model: "company-model",
        choices: [
          {
            index: 0,
            message: tool
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_probe",
                      type: "function",
                      function: { name: mode === "tool" ? "wrong_tool" : "enterprise_probe", arguments: "{}" },
                    },
                  ],
                }
              : { role: "assistant", content: "OK" },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  try {
    const server = await launchEnterpriseProcess({
      command: [
        process.execPath,
        fileURLToPath(new URL("../../../test/enterprise-server-entrypoint.ts", import.meta.url)),
      ],
      env: {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        PATH: process.env.PATH ?? "",
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_ENTERPRISE_OFFLINE: "1",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: endpoint.url.origin,
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
      },
      bootstrap: {
        password: "private-test-service-password",
        catalog: {
          schemaVersion: 1,
          default: { providerID: "company", modelID: "company-model" },
          providers: [
            {
              id: "company",
              name: "Company",
              baseURL: new URL("/v1", endpoint.url).href,
              models: [{ id: "company-model", name: "Company model" }],
            },
          ],
        },
        credentials: {
          schemaVersion: 3,
          providers: { company: { apiKey: "private-probe-key", headers: { "X-Gateway": "private-gateway-token" } } },
        },
      },
    })
    try {
      const response = await fetch(new URL("/api/info", server.url), {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}` },
      })
      expect(response.status).toBe(200)
      const info = await response.json()
      expect(info.urls).toContain(server.url)
      expect(info.pid).toBeGreaterThan(0)
      expect((await fetch(new URL("/api/info", server.url))).status).toBe(401)
      const headers = {
        Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
        "Content-Type": "application/json",
      }
      const diagnostic = async () => {
        const response = await fetch(new URL("/api/provider/company/diagnose", server.url), {
          method: "POST",
          headers,
          body: JSON.stringify({ modelID: "company-model", checkToolCall: true }),
        })
        expect(response.status).toBe(200)
        return response.json() as Promise<{
          data: { ok: boolean; checks: Record<string, string>; failure?: { kind: string } }
        }>
      }
      expect((await diagnostic()).data).toEqual({
        ok: true,
        checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
      })
      expect(observed.map((request) => request.stream)).toEqual([false, true, true])
      expect(
        observed.every(
          (request) =>
            request.authorization === "Bearer private-probe-key" && request.gateway === "private-gateway-token",
        ),
      ).toBe(true)
      const providers = await (await fetch(new URL("/api/provider", server.url), { headers })).text()
      expect(providers).not.toMatch(/private-probe-key|private-gateway-token/)
      const persisted = await fetch(new URL("/api/credential", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ integrationID: "company", value: { type: "key", key: "forbidden-plaintext-secret" } }),
      })
      expect(persisted.status).toBe(400)
      expect(await persisted.text()).not.toContain("forbidden-plaintext-secret")
      const credentials = await (await fetch(new URL("/api/credential", server.url), { headers })).json()
      expect(credentials.data).toEqual([])
      for (const failure of ["auth", "stream", "tool", "redirect"]) {
        mode = failure
        const result = (await diagnostic()).data
        expect(result.ok).toBe(false)
        if (failure !== "redirect") expect(result.failure?.kind).toBe(failure === "tool" ? "tool_call" : failure)
        expect(JSON.stringify(result)).not.toContain("diagnostic-secret")
      }
      expect(redirected).toBe(0)
    } finally {
      await server.stop()
    }
  } finally {
    endpoint.stop(true)
    destination.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
