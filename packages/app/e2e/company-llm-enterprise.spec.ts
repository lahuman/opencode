import { expect, test, type Page } from "@playwright/test"

const REMOTE_DISABLED = "Remote servers are disabled in this build"
const fixture = (scenario: string) => `/e2e/fixtures/company-llm-enterprise.html?scenario=${scenario}`
const responsiveViewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]

async function output<T>(page: Page, id: string) {
  return page.getByTestId(id).evaluate((node) => JSON.parse(node.textContent ?? "null") as T)
}

async function invokeFixtureControl(page: Page, name: string) {
  const button = page.getByTestId("company-controls").locator("button").filter({ hasText: name })
  await expect(button).toBeEnabled()
  await button.evaluate((node: HTMLButtonElement) => node.click())
}

test("mounted ServerProvider excludes persisted remotes before health polling", async ({ page }) => {
  await page.goto(fixture("server"))

  await expect(page.getByTestId("server-list")).toHaveText("sidecar")
  await expect(page.getByTestId("active-server")).toHaveText("sidecar")
  await expect.poll(() => output<unknown[]>(page, "persisted-servers")).toEqual([])
  await expect
    .poll(async () =>
      (await output<Array<{ host: string; path: string }>>(page, "requests"))
        .filter((request) => request.path === "/global/health")
        .map((request) => request.host),
    )
    .toEqual(["127.0.0.1:5199"])

  const requests = await output<Array<{ host: string }>>(page, "requests")
  expect(requests.some((request) => request.host === "remote.example.test")).toBe(false)
})

test("mounted management controller rejects before storage, navigation, probes, or activation", async ({ page }) => {
  await page.goto(fixture("controller"))
  await expect(page.getByTestId("controller-ready")).toHaveText("true")
  await expect
    .poll(async () =>
      (await output<Array<{ path: string }>>(page, "requests")).filter(
        (request) => request.path === "/global/health",
      ).length,
    )
    .toBe(1)

  const probes = (await output<Array<{ path: string }>>(page, "requests")).filter(
    (request) => request.path === "/global/health",
  ).length
  const writes = (await output<unknown[]>(page, "storage-writes")).length

  await page.getByRole("button", { name: "Invoke add" }).click()
  await page.getByRole("button", { name: "Invoke select" }).click()
  await page.getByRole("button", { name: "Invoke remove" }).click()
  await page.getByRole("button", { name: "Invoke default" }).click()

  await expect
    .poll(() => output<Record<string, string>>(page, "controller-results"))
    .toEqual({ add: REMOTE_DISABLED, select: REMOTE_DISABLED, remove: REMOTE_DISABLED, default: "resolved" })
  await expect(page.getByText(REMOTE_DISABLED, { exact: true })).toBeVisible()
  expect(
    (await output<Array<{ path: string }>>(page, "requests")).filter(
      (request) => request.path === "/global/health",
    ),
  ).toHaveLength(probes)
  expect(await output<unknown[]>(page, "storage-writes")).toHaveLength(writes)
  expect(await output<unknown[]>(page, "default-writes")).toEqual([])
  await expect(page.getByTestId("controller-location")).toHaveText("/")
  await expect(page.getByTestId("controller-active")).toHaveText("sidecar")
  await expect(page.getByTestId("controller-close-calls")).toHaveText("0")
})

test("DialogConnectProvider diverts enterprise mode directly to Company LLM", async ({ page }) => {
  await page.goto(fixture("connect"))

  await expect(page.getByRole("dialog")).toContainText("Company LLM")
  await expect(page.getByLabel("API key")).toBeVisible()
  await expect(page.locator("[data-component=list]")).toHaveCount(0)
  await expect(page.getByText("Custom provider", { exact: true })).toHaveCount(0)

  const requests = await output<Array<{ path: string }>>(page, "requests")
  expect(requests.some((request) => request.path === "/provider/auth" || request.path.startsWith("/auth/"))).toBe(
    false,
  )
})

test("DialogCompanyProvider keeps credentials local and drives generated diagnostics accessibly", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  const apiKey = page.getByLabel("API key")
  const headerName = page.getByPlaceholder("Header name")
  const headerValue = page.getByPlaceholder("Secret value")
  const status = dialog.locator('[data-slot="company-diagnostic-status"]')

  await expect(dialog).toContainText("Credentials not configured")
  await expect(status).toHaveAttribute("role", "status")
  await expect(status).toHaveAttribute("aria-live", "polite")
  await expect(status).toHaveText("Ready to test Company LLM connection")

  await apiKey.fill(" secret ")
  await headerName.fill(" X-Token ")
  await headerValue.fill(" value ")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => output<unknown[]>(page, "restart-snapshots")).toHaveLength(1)
  expect(await output<unknown[]>(page, "credential-inputs")).toEqual([
    { apiKey: "secret", headers: { "X-Token": "value" } },
  ])
  expect(await output<unknown[]>(page, "restart-snapshots")).toEqual([["", "", ""]])

  await invokeFixtureControl(page, "Credentials no restart")
  await apiKey.fill("second")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => output<unknown[]>(page, "credential-inputs")).toHaveLength(2)
  expect(await output<unknown[]>(page, "restart-snapshots")).toHaveLength(1)

  await invokeFixtureControl(page, "Credentials error")
  await apiKey.fill("keep-local")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(apiKey).toHaveValue("keep-local")
  expect(await output<unknown[]>(page, "restart-snapshots")).toHaveLength(1)

  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(status).toHaveText("Testing Company LLM connection")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).toHaveCount(0)
  await invokeFixtureControl(page, "Resolve diagnostic")
  await expect(status).toHaveText("Company LLM connection test completed successfully")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).not.toHaveAttribute("role")

  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(status).toHaveText("Testing Company LLM connection")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).toHaveCount(0)
  await invokeFixtureControl(page, "Resolve diagnostic")
  await expect(status).toHaveText("Company LLM connection test completed successfully")
  await expect(dialog.locator('[data-slot="company-diagnostic-status"]')).toHaveCount(1)

  await invokeFixtureControl(page, "Diagnostic failure")
  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(status).toHaveText("Testing Company LLM connection")
  await invokeFixtureControl(page, "Resolve diagnostic")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).toHaveAttribute("role", "alert")
  await expect(status).toHaveText("")

  const diagnostics = (await output<Array<{ path: string; body?: unknown }>>(page, "requests")).filter(
    (request) => request.path === "/provider/company-llm/diagnostics",
  )
  expect(diagnostics.map((request) => request.body)).toEqual([
    { modelID: "company-code", checkToolCall: true },
    { modelID: "company-code", checkToolCall: true },
    { modelID: "company-code", checkToolCall: true },
  ])
  const requests = await output<Array<{ path: string }>>(page, "requests")
  expect(requests.some((request) => request.path === "/provider/auth" || request.path.startsWith("/auth/"))).toBe(
    false,
  )
})

responsiveViewports.forEach((viewport) => {
  test(`Company LLM dialog fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(fixture("company"))
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await page.getByTestId("company-controls").evaluate((node) => node.setAttribute("hidden", ""))

    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.x).toBeGreaterThanOrEqual(0)
    expect(box?.y).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height)
    expect(
      await dialog.evaluate((node) => ({
        horizontal: node.scrollWidth > node.clientWidth,
        vertical: node.scrollHeight > node.clientHeight,
      })),
    ).toEqual({ horizontal: false, vertical: false })

    await page.screenshot({ path: testInfo.outputPath(`company-llm-${viewport.name}.png`) })
  })
})
