import { expect, test, type Page } from "@playwright/test"

const REMOTE_DISABLED = "Remote servers are disabled in this build"
const SAFE_REMEDIATION = "Install the Company TLS CA certificate and try again."
const fixture = (scenario: string) => `/e2e/fixtures/company-llm-enterprise.html?scenario=${scenario}`
const diagnosticRequest = {
  origin: "http://127.0.0.1:5199",
  host: "127.0.0.1:5199",
  method: "POST",
  path: "/provider/company-llm/diagnostics",
  query: "",
  body: { modelID: "company-code", checkToolCall: true },
}
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

async function openCompanyGuideFromMenu(page: Page) {
  await page.getByRole("button", { name: "OpenCode menu" }).click()
  await page.getByRole("menuitem", { name: "Help" }).hover()
  await page.getByRole("menuitem", { name: "Company AI Guide" }).click()
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
  await expect.poll(() => output<string[]>(page, "credential-status-inputs")).toEqual(["company-code"])
  await expect(status).toHaveAttribute("role", "status")
  await expect(status).toHaveAttribute("aria-live", "polite")
  await expect(status).toHaveText("Ready to test Company LLM connection")

  await apiKey.fill(" secret ")
  await headerName.fill(" X-Token ")
  await headerValue.fill(" value ")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => output<unknown[]>(page, "restart-snapshots")).toHaveLength(1)
  expect(await output<unknown[]>(page, "credential-inputs")).toEqual([
    { modelID: "company-code", apiKey: "secret", headers: { "X-Token": "value" } },
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
  const failure = dialog.locator('[data-slot="company-diagnostic-result"]')
  await expect(failure).toHaveAttribute("role", "alert")
  await expect(failure.getByText("Failure (connection)", { exact: true })).toBeVisible()
  await expect(failure.getByText(SAFE_REMEDIATION, { exact: true })).toBeVisible()
  await expect(status).toHaveText("")

  await invokeFixtureControl(page, "Diagnostic network error")
  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(failure.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(failure).not.toContainText("transport failure with private detail")

  const diagnostics = (await output<Array<typeof diagnosticRequest>>(page, "requests")).filter(
    (request) => request.path === "/provider/company-llm/diagnostics",
  )
  expect(diagnostics).toEqual(Array.from({ length: 4 }, () => diagnosticRequest))
  const requests = await output<Array<{ path: string }>>(page, "requests")
  expect(requests.some((request) => request.path === "/provider/auth" || request.path.startsWith("/auth/"))).toBe(
    false,
  )
})

test("DialogCompanyProvider clears model-scoped secrets and diagnostics when switching models", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  const apiKey = page.getByLabel("API key")
  const headerName = page.getByPlaceholder("Header name")
  const headerValue = page.getByPlaceholder("Secret value")

  await expect(page.getByLabel("Base URL")).toHaveValue("https://llm.company.test/v1")
  await apiKey.fill("code-secret")
  await headerName.fill("X-Code-Token")
  await headerValue.fill("code-header")
  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(page.getByRole("button", { name: /Company LLM model/ })).toBeDisabled()
  await invokeFixtureControl(page, "Resolve diagnostic")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).toBeVisible()

  await page.getByRole("button", { name: /Company LLM model/ }).click()
  await page.getByText("Company Reasoning", { exact: true }).click()

  await expect(apiKey).toHaveValue("")
  await expect(headerName).toHaveValue("")
  await expect(headerValue).toHaveValue("")
  await expect(page.getByLabel("Base URL")).toHaveValue("https://reasoning.company.test/v1")
  await expect(dialog.locator('[data-slot="company-diagnostic-result"]')).toHaveCount(0)
  await expect(dialog.locator('[data-slot="company-diagnostic-status"]')).toHaveText(
    "Ready to test Company LLM connection",
  )
})

test("settings diagnostics display the authenticated server remediation", async ({ page }) => {
  await page.goto(fixture("settings"))
  await expect(page.getByTestId("settings-credential-status")).toHaveText("Credentials not configured")
  await expect.poll(() => output<string[]>(page, "credential-status-inputs")).toEqual(["company-code"])
  await invokeFixtureControl(page, "Diagnostic failure")

  await page.getByRole("button", { name: "Settings test connection" }).click()
  await expect(page.getByRole("button", { name: "Testing settings connection" })).toBeDisabled()
  await invokeFixtureControl(page, "Resolve diagnostic")

  await expect(page.getByText(SAFE_REMEDIATION, { exact: true })).toBeVisible()
  const diagnostics = (await output<Array<typeof diagnosticRequest>>(page, "requests")).filter(
    (request) => request.path === "/provider/company-llm/diagnostics",
  )
  expect(diagnostics).toEqual([diagnosticRequest])
})

test("enterprise fatal error offers the local company guide without public reporting UI", async ({ page }) => {
  await page.goto(fixture("error-enterprise"))

  const guide = page.getByRole("button", { name: "Open Company AI Guide" })
  await expect(guide).toBeVisible()
  await expect(guide.locator('use[href="#opencode-icon-help"]')).toHaveCount(1)
  await expect(page.getByText("Please report this error to the OpenCode team", { exact: true })).toHaveCount(0)
  await expect(page.getByText("on Discord", { exact: true })).toHaveCount(0)

  await guide.click()
  await expect(page.getByRole("dialog")).toContainText("Company AI Guide")
  expect(await output<string[]>(page, "external-links")).toEqual([])
})

test("public fatal error preserves the localized Discord reporting action", async ({ page }) => {
  await page.goto(fixture("error-public"))

  await expect(page.getByText("Please report this error to the OpenCode team")).toBeVisible()
  const discord = page.getByRole("button", { name: "on Discord" })
  await expect(discord).toBeVisible()
  await expect(discord.locator('use[href="#opencode-icon-discord"]')).toHaveCount(1)
  await expect(page.getByText("Company AI Guide", { exact: true })).toHaveCount(0)

  await discord.click()
  await expect.poll(() => output<string[]>(page, "external-links")).toEqual(["https://opencode.ai/desktop-feedback"])
})

test("Company AI Guide restores the Windows menu trigger after both close paths", async ({ page }) => {
  await page.goto(fixture("guide"))
  const trigger = page.getByRole("button", { name: "OpenCode menu" })

  await openCompanyGuideFromMenu(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(trigger).toBeFocused()

  await openCompanyGuideFromMenu(page)
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(trigger).toBeFocused()
})

responsiveViewports.forEach((viewport) => {
  test(`Company AI Guide dialog fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(fixture("guide"))
    await openCompanyGuideFromMenu(page)

    const dialog = page.getByRole("dialog")
    const body = dialog.getByRole("region", { name: "Company AI Guide content" })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute("aria-labelledby", /.+/)
    await expect(body).toHaveAttribute("tabindex", "0")
    await expect(body).toBeFocused()
    await expect(dialog.getByText("Company AI Guide", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Version 2026.07", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Internal AI guide", level: 1 })).toBeVisible()
    await expect(dialog.locator("a")).toHaveCount(0)
    expect(await output<string[]>(page, "external-links")).toEqual([])

    const metrics = await dialog.evaluate((node) => {
      const content = node.getBoundingClientRect()
      const body = node.querySelector<HTMLElement>('[data-component="company-guide"]')
      if (!body) throw new Error("Missing company guide body")
      const bodyRect = body.getBoundingClientRect()
      return {
        content: { top: content.top, right: content.right, bottom: content.bottom, left: content.left },
        body: { top: bodyRect.top, right: bodyRect.right, bottom: bodyRect.bottom, left: bodyRect.left },
        dialogHorizontalOverflow: node.scrollWidth > node.clientWidth,
        bodyHorizontalOverflow: body.scrollWidth > body.clientWidth,
        bodyVerticalOverflow: body.scrollHeight > body.clientHeight,
      }
    })
    expect(metrics.dialogHorizontalOverflow).toBe(false)
    expect(metrics.bodyHorizontalOverflow).toBe(false)
    expect(metrics.bodyVerticalOverflow).toBe(true)
    expect(metrics.content.left).toBeGreaterThanOrEqual(0)
    expect(metrics.content.top).toBeGreaterThanOrEqual(0)
    expect(metrics.content.right).toBeLessThanOrEqual(viewport.width)
    expect(metrics.content.bottom).toBeLessThanOrEqual(viewport.height)
    expect(metrics.body.left).toBeGreaterThanOrEqual(metrics.content.left)
    expect(metrics.body.right).toBeLessThanOrEqual(metrics.content.right)
    expect(metrics.body.bottom).toBeLessThanOrEqual(metrics.content.bottom)

    const pageDownStart = await body.evaluate((node) => node.scrollTop)
    await page.keyboard.press("PageDown")
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(pageDownStart)
    const arrowStart = await body.evaluate((node) => node.scrollTop)
    await page.keyboard.press("ArrowDown")
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(arrowStart)
    await page.keyboard.press("Shift+Tab")
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(body).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`company-guide-${viewport.name}.png`) })
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })

  test(`Company LLM dialog fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(fixture("company"))
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await page.getByTestId("company-controls").evaluate((node) => node.setAttribute("hidden", ""))
    await page.screenshot({ path: testInfo.outputPath(`company-llm-${viewport.name}.png`) })
    await invokeFixtureControl(page, "Diagnostic failure")
    await dialog.getByRole("button", { name: "Test connection" }).click()
    await invokeFixtureControl(page, "Resolve diagnostic")
    const remediation = dialog.getByText(SAFE_REMEDIATION, { exact: true })
    const remediationVisible = () =>
      remediation.evaluate((node) => {
        const content = node.closest('[role="dialog"]')?.getBoundingClientRect()
        const value = node.getBoundingClientRect()
        return Boolean(content && value.top >= content.top && value.bottom <= content.bottom)
      })
    if (!(await remediationVisible())) await remediation.scrollIntoViewIfNeeded()
    expect(await remediationVisible()).toBe(true)
    const rows = await dialog.locator('[data-slot="company-diagnostic-result"]').evaluate((node) => {
      const children = [...node.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
      return Array.from({ length: children.length / 2 }, (_, index) => {
        const label = children[index * 2]
        const value = children[index * 2 + 1]
        const textRects = (element: HTMLElement) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          return [...range.getClientRects()].map((rect) => ({
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          }))
        }
        const labelRects = textRects(label)
        const valueRects = textRects(value)
        const sharedLines = labelRects.flatMap((labelRect) =>
          valueRects
            .filter((valueRect) => labelRect.top < valueRect.bottom && labelRect.bottom > valueRect.top)
            .map((valueRect) => valueRect.left - labelRect.right),
        )
        return {
          label: label.textContent,
          value: value.textContent,
          labelOverflows: label.scrollWidth > label.clientWidth,
          valueOverflows: value.scrollWidth > value.clientWidth,
          textIntersects: sharedLines.some((gap) => gap < 0),
          sharedLineGap: sharedLines.length ? Math.min(...sharedLines) : undefined,
        }
      })
    })
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Basic response", value: "fail" }),
        expect.objectContaining({ label: "Streaming", value: "skipped" }),
        expect.objectContaining({ label: "Tool calling", value: "skipped" }),
        expect.objectContaining({ label: "Failure (connection)", value: SAFE_REMEDIATION }),
      ]),
    )
    expect(rows.every((row) => !row.labelOverflows && !row.valueOverflows)).toBe(true)
    expect(rows.every((row) => !row.textIntersects)).toBe(true)
    expect(rows.every((row) => row.sharedLineGap === undefined || row.sharedLineGap >= 8)).toBe(true)

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

    await page.screenshot({ path: testInfo.outputPath(`company-llm-${viewport.name}-failure.png`) })
  })
})
