import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readEnterpriseGuide } from "./enterprise-guide"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("enterprise guide IPC", () => {
  test("rejects reads when enterprise mode is disabled", async () => {
    await expect(
      readEnterpriseGuide({ enabled: false, path: join(tmpdir(), "missing-company-guide.md"), version: "2026.07" }),
    ).rejects.toThrow("Company guide is unavailable")
  })

  test("returns only the configured version and UTF-8 markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enterprise-guide-"))
    directories.push(directory)
    const path = join(directory, "company-guide.md")
    await writeFile(path, "# Company guide\n\nUse café settings.\n", "utf8")

    const guide = await readEnterpriseGuide({ enabled: true, path, version: "2026.07" })

    expect(guide).toEqual({ version: "2026.07", markdown: "# Company guide\n\nUse café settings.\n" })
    expect(Object.keys(guide)).toEqual(["version", "markdown"])
  })

  test("registerIpcHandlers registers and dispatches the enterprise guide read handler", async () => {
    const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/../../test/ipc-entrypoint.ts`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe(
      JSON.stringify({
        registered: true,
        credentialCatalog: {
          defaultModelID: "company-code",
          models: [
            {
              id: "company-code",
              name: "Company Code",
              baseURL: "https://llm.corp.example/v1",
              credentialStatus: { configured: false },
            },
          ],
        },
        guide: { version: "2026.08", markdown: "# Registered guide\n" },
        shellOpenExternalURLs: ["https://llm.corp.example/docs"],
      }),
    )
  })

  test("rejects read failures without exposing the resolved guide path", async () => {
    const path = join(tmpdir(), "private-enterprise", "company-guide.md")
    const failure = await readEnterpriseGuide({ enabled: true, path, version: "2026.07" }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) return
    expect(failure.message).toBe("Company guide could not be read")
    expect(failure.message).not.toContain(path)
  })
})
