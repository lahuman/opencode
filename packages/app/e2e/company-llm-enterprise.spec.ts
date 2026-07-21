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
  await page.getByRole("menuitem", { name: "Kernexa AI 가이드" }).click()
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
    .poll(
      async () =>
        (await output<Array<{ path: string }>>(page, "requests")).filter((request) => request.path === "/global/health")
          .length,
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
    (await output<Array<{ path: string }>>(page, "requests")).filter((request) => request.path === "/global/health"),
  ).toHaveLength(probes)
  expect(await output<unknown[]>(page, "storage-writes")).toHaveLength(writes)
  expect(await output<unknown[]>(page, "default-writes")).toEqual([])
  await expect(page.getByTestId("controller-location")).toHaveText("/")
  await expect(page.getByTestId("controller-active")).toHaveText("sidecar")
  await expect(page.getByTestId("controller-close-calls")).toHaveText("0")
})

test("DialogConnectProvider diverts enterprise mode directly to provider management", async ({ page }) => {
  await page.goto(fixture("connect"))

  await expect(page.getByRole("dialog")).toContainText("Enterprise providers")
  await expect(page.getByRole("button", { name: "Create provider" })).toBeVisible()
  await expect(page.locator("[data-component=list]")).toHaveCount(0)
  await expect(page.getByText("Custom provider", { exact: true })).toHaveCount(0)

  const requests = await output<Array<{ path: string }>>(page, "requests")
  expect(requests.some((request) => request.path === "/provider/auth" || request.path.startsWith("/auth/"))).toBe(false)
})

test("New Session stays editable while Enterprise providers load, then disables for an empty catalog", async ({
  page,
}) => {
  await page.goto(fixture("composer-enterprise-empty"))

  const loadingEditor = page.getByRole("textbox", { name: "Prompt" })
  await expect(loadingEditor).toHaveAttribute("contenteditable", "true")
  await page.getByRole("button", { name: "Refresh providers" }).click()
  await expect(page.getByRole("button", { name: "Resolve providers" })).toBeEnabled()
  await expect(loadingEditor).toHaveAttribute("contenteditable", "true")
  await expect(page.getByRole("button", { name: "Manage providers" })).toHaveCount(0)

  await page.getByRole("button", { name: "Resolve providers" }).click()

  const emptyEditor = page.getByRole("textbox", { name: "Add a provider and model to start chatting" })
  await expect(emptyEditor).toHaveAttribute("contenteditable", "false")
  await expect(emptyEditor).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled()

  await page
    .getByRole("button", { name: "Manage providers" })
    .evaluate((node: HTMLButtonElement) => node.click())
  await expect(page.getByRole("dialog")).toContainText("Enterprise providers")
})

test("New Session preserves the ordinary composer with an empty provider catalog", async ({ page }) => {
  await page.goto(fixture("composer-ordinary-empty"))

  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
    "contenteditable",
    "true",
  )
  await expect(page.getByRole("button", { name: "Manage providers" })).toHaveCount(0)
})

test("provider editor defaults credentials by operation", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")

  await dialog.getByRole("button", { name: "Create provider" }).click()
  await expect(page.getByLabel("Credential action")).toHaveValue("replace")
  await expect(page.getByLabel("API key")).toBeVisible()
  await expect(page.getByPlaceholder("Header name")).toBeVisible()
  await expect(page.getByPlaceholder("Secret value")).toBeVisible()
  await page.getByLabel("Provider ID").fill("gateway")
  await page.getByLabel("Provider name").fill("Gateway")
  await page.getByLabel("Base URL").fill("https://gateway.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()

  const provider = page.getByTestId("enterprise-provider-gateway")
  await expect(provider).toContainText("Credentials not configured")
  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await expect(page.getByLabel("Credential action")).toHaveValue("preserve")
  await expect(page.getByLabel("API key")).toBeHidden()
  await expect(page.getByPlaceholder("Header name")).toBeHidden()
  await expect(page.getByPlaceholder("Secret value")).toBeHidden()
})

test("DialogCompanyProvider manages provider, model, credentials, defaults, diagnostics, and deletion", async ({
  page,
}) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  const status = dialog.locator('[data-slot="company-diagnostic-status"]')
  await expect(dialog.getByText("No enterprise providers configured", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Create provider" }).click()
  await page.getByLabel("Provider ID").fill("gateway")
  await page.getByLabel("Provider name").fill("Gateway")
  await page.getByLabel("Base URL").fill("https://gateway.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()

  const provider = page.getByTestId("enterprise-provider-gateway")
  await expect(provider).toContainText("Gateway")
  await expect(provider).toContainText("https://gateway.example/v1")
  await expect(provider).toContainText("0 models")
  await expect(provider).toContainText("Credentials not configured")

  await dialog.getByRole("button", { name: "Add model" }).click()
  await page.getByLabel("Model ID").fill("chat")
  await page.getByLabel("Model name").fill("Chat")
  await dialog.getByRole("button", { name: "Save model" }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await page.getByLabel("Model ID").fill("reasoning")
  await page.getByLabel("Model name").fill("Reasoning")
  await dialog.getByRole("button", { name: "Save model" }).click()

  const chat = page.getByTestId("enterprise-model-gateway-chat")
  const reasoning = page.getByTestId("enterprise-model-gateway-reasoning")
  await expect(chat).toBeVisible()
  await expect(reasoning).toBeVisible()
  await dialog.getByRole("button", { name: "Set default" }).click()
  await expect(reasoning).toContainText("Default")

  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await expect(page.getByLabel("Provider ID")).toBeDisabled()
  await page.getByLabel("Credential action").selectOption("replace")
  await page.getByLabel("API key").fill("top-secret-api-key")
  await page.getByPlaceholder("Header name").fill("X-Token")
  await page.getByPlaceholder("Secret value").fill("top-secret-header")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(provider).toContainText("Credentials configured")
  await expect(dialog).not.toContainText("top-secret-api-key")
  await expect(dialog).not.toContainText("top-secret-header")
  expect(await output<unknown[]>(page, "credential-inputs")).toEqual([
    { providerID: "gateway", hasApiKey: true, headerNames: ["X-Token"] },
  ])

  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await expect(page.getByLabel("Provider ID")).toBeDisabled()
  await page.getByLabel("Credential action").selectOption("replace")
  await expect(page.getByLabel("API key")).toHaveValue("")
  await expect(page.getByPlaceholder("Header name")).toHaveValue("")
  await expect(page.getByPlaceholder("Secret value")).toHaveValue("")
  await dialog.getByRole("button", { name: "Cancel edit" }).click()

  await invokeFixtureControl(page, "Credentials error")
  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await page.getByLabel("Provider name").fill("Gateway Replace Reconciled")
  await page.getByLabel("Credential action").selectOption("replace")
  await page.getByLabel("API key").fill("failed-replacement-secret")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Request failed")
  await expect(provider).toContainText("Gateway")
  await expect(provider).not.toContainText("Gateway Replace Reconciled")
  await expect(provider).toContainText("Credentials configured")
  await expect(dialog).not.toContainText("failed-replacement-secret")
  await dialog.getByRole("button", { name: "Dismiss error" }).click()

  await invokeFixtureControl(page, "Credentials error")
  await page.getByLabel("Provider name").fill("Gateway Clear Reconciled")
  await page.getByLabel("Credential action").selectOption("clear")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Request failed")
  await expect(provider).not.toContainText("Gateway Clear Reconciled")
  await dialog.getByRole("button", { name: "Dismiss error" }).click()
  await invokeFixtureControl(page, "Credentials no restart")
  await page.getByLabel("Credential action").selectOption("clear")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(provider).toContainText("Gateway Clear Reconciled")
  await expect(provider).toContainText("Credentials not configured")
  expect(await output<string[]>(page, "credential-clear-inputs")).toEqual([])
  expect(await output<unknown[]>(page, "standalone-credential-inputs")).toEqual([])
  expect(await output<unknown[]>(page, "provider-update-inputs")).toEqual([
    {
      providerID: "gateway",
      name: "Gateway",
      hasApiKey: true,
      headerNames: ["X-Token"],
      clearCredentials: false,
    },
    {
      providerID: "gateway",
      name: "Gateway Replace Reconciled",
      hasApiKey: true,
      headerNames: [],
      clearCredentials: false,
    },
    {
      providerID: "gateway",
      name: "Gateway Clear Reconciled",
      hasApiKey: false,
      headerNames: [],
      clearCredentials: true,
    },
    {
      providerID: "gateway",
      name: "Gateway Clear Reconciled",
      hasApiKey: false,
      headerNames: [],
      clearCredentials: true,
    },
  ])

  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await expect(page.getByLabel("Provider ID")).toBeDisabled()
  await page.getByLabel("Provider name").fill("Gateway Updated")
  await page.getByLabel("Base URL").fill("https://gateway-updated.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(provider).toContainText("Gateway Updated")
  await expect(provider).toContainText("https://gateway-updated.example/v1")

  await reasoning.click()
  await dialog.getByRole("button", { name: "Edit model" }).click()
  await expect(page.getByLabel("Model ID")).toBeDisabled()
  await page.getByLabel("Model name").fill("Reasoning Updated")
  await dialog.getByRole("button", { name: "Save model" }).click()
  await dialog.getByRole("button", { name: "Test connection" }).click()
  await expect(status).toHaveText("Testing Gateway Updated / Reasoning Updated connection")
  await invokeFixtureControl(page, "Resolve diagnostic")
  await expect(status).toHaveText("Gateway Updated / Reasoning Updated connection test completed successfully")

  await dialog.getByRole("button", { name: "Delete model" }).click()
  await expect(dialog).toContainText("Conversation history remains available")
  await dialog.getByRole("button", { name: "Confirm delete model" }).click()
  await expect(reasoning).toHaveCount(0)
  await expect(chat).toContainText("Default")

  await dialog.getByRole("button", { name: "Delete provider" }).click()
  await expect(dialog).toContainText("All models and credentials for this provider will be removed")
  await dialog.getByRole("button", { name: "Confirm delete provider" }).click()
  await expect(dialog.getByText("No enterprise providers configured", { exact: true })).toBeVisible()
  await expect(provider).toHaveCount(0)
})

test("provider recovery failure keeps its code and shows restart guidance", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Create provider" }).click()
  await page.getByLabel("Provider ID").fill("recovery")
  await page.getByLabel("Provider name").fill("Recovery")
  await page.getByLabel("Base URL").fill("https://recovery.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()

  await invokeFixtureControl(page, "Credentials recovery failure")
  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await page.getByLabel("Provider name").fill("Must Roll Back")
  await page.getByLabel("Credential action").selectOption("replace")
  await page.getByLabel("API key").fill("recovery-secret")
  await dialog.getByRole("button", { name: "Save provider" }).click()

  await expect(dialog.getByRole("alert")).toContainText(
    "The local server and rollback both failed. Restart the app to recover.",
  )
  await expect(page.getByTestId("enterprise-provider-recovery")).not.toContainText("Must Roll Back")
  await expect(dialog).not.toContainText("recovery-secret")
})

test("pending provider mutations lock every dialog close path", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Create provider" }).click()
  await page.getByLabel("Provider ID").fill("pending")
  await page.getByLabel("Provider name").fill("Pending")
  await page.getByLabel("Base URL").fill("https://pending.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await invokeFixtureControl(page, "Credentials pending")
  await dialog.getByRole("button", { name: "Edit provider" }).click()
  await page.getByLabel("Credential action").selectOption("replace")
  await page.getByLabel("API key").fill("pending-secret")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await expect(
    page.getByTestId("company-controls").locator("button").filter({ hasText: "Resolve credentials" }),
  ).toBeEnabled()

  const headerClose = dialog.locator('[data-slot="dialog-close-button"]')
  const footerClose = dialog.locator('[data-slot="dialog-body"]').getByRole("button", { name: "Close" })
  await expect(headerClose).toBeDisabled()
  await expect(footerClose).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await page.locator('[data-component="dialog-overlay"]').click({ force: true })
  await expect(dialog).toBeVisible()

  await invokeFixtureControl(page, "Resolve credentials")
  await expect(headerClose).toBeEnabled()
  await expect(footerClose).toBeEnabled()
  await expect(dialog).not.toContainText("pending-secret")
})

test("delete confirmation is an accessible modal interaction within provider management", async ({ page }) => {
  await page.goto(fixture("company"))
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Create provider" }).click()
  await page.getByLabel("Provider ID").fill("confirm")
  await page.getByLabel("Provider name").fill("Confirm")
  await page.getByLabel("Base URL").fill("https://confirm.example/v1")
  await dialog.getByRole("button", { name: "Save provider" }).click()
  await dialog.getByRole("button", { name: "Add model" }).click()
  await page.getByLabel("Model ID").fill("code")
  await page.getByLabel("Model name").fill("Code")
  await dialog.getByRole("button", { name: "Save model" }).click()

  await dialog.getByRole("button", { name: "Test connection" }).click()
  await invokeFixtureControl(page, "Resolve diagnostic")
  const readiness = dialog.getByText(/Offline readiness:/)
  await expect(readiness).toBeVisible()

  await dialog.getByRole("button", { name: "Edit model" }).click()
  await page.getByLabel("Model name").fill("")
  await dialog.getByRole("button", { name: "Save model" }).click()
  const dismissError = dialog.getByRole("button", { name: "Dismiss error" })
  await expect(dismissError).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel edit" }).click()

  const deleteModel = dialog.getByRole("button", { name: "Delete model" })
  await deleteModel.click()
  const confirmation = dialog.getByRole("alertdialog", { name: "Delete model Code" })
  const confirm = confirmation.getByRole("button", { name: "Confirm delete model" })
  await expect(confirmation).toHaveAttribute("aria-describedby", "enterprise-delete-description")
  await expect(confirm).toBeFocused()
  await expect(page.getByTestId("enterprise-provider-confirm")).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Add model" })).toBeDisabled()
  await expect(dialog.locator('[data-slot="dialog-close-button"]')).toBeDisabled()
  await expect(dismissError).toBeDisabled()
  await expect(readiness).toHaveAttribute("tabindex", "-1")
  const cancel = confirmation.getByRole("button", { name: "Cancel delete" })
  await page.keyboard.press("Shift+Tab")
  await expect(cancel).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(confirm).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(cancel).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(confirmation).toBeVisible()

  await cancel.click()
  await expect(confirmation).toHaveCount(0)
  await expect(deleteModel).toBeFocused()
})

for (const scenario of ["settings-layout", "settings-v2-layout"]) {
  test(`${scenario} summarizes the Enterprise catalog and opens provider management`, async ({ page }) => {
    await page.goto(fixture(scenario))

    await expect(page.getByText("1 provider", { exact: true })).toBeVisible()
    await expect(page.getByText("Company LLM / Company Code", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Test connection" })).toBeEnabled()
    await page.getByRole("button", { name: "Manage providers" }).click()
    await expect(page.getByRole("dialog")).toContainText("Enterprise providers")
  })
}

test("settings diagnostics display the authenticated server remediation", async ({ page }) => {
  await page.goto(fixture("settings"))
  await expect(page.getByTestId("settings-credential-status")).toHaveText("Credentials not configured")
  await expect.poll(() => output<string[]>(page, "credential-status-inputs")).toEqual([])
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

test("settings success toast creates its icon inside the Solid render owner", async ({ page }) => {
  const warnings: string[] = []
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text())
  })
  await page.goto(fixture("settings"))

  await page.getByRole("button", { name: "Settings test connection" }).click()
  await invokeFixtureControl(page, "Resolve diagnostic")

  await expect(page.getByText("Enterprise provider connection succeeded", { exact: true })).toBeVisible()
  expect(warnings.filter((warning) => warning.includes("cleanups created outside"))).toEqual([])
})

test("enterprise fatal error offers the local company guide without public reporting UI", async ({ page }) => {
  await page.goto(fixture("error-enterprise"))

  const guide = page.getByRole("button", { name: "Kernexa AI 가이드 열기" })
  await expect(guide).toBeVisible()
  await expect(guide.locator('use[href="#opencode-icon-help"]')).toHaveCount(1)
  await expect(page.getByText("Please report this error to the OpenCode team", { exact: true })).toHaveCount(0)
  await expect(page.getByText("on Discord", { exact: true })).toHaveCount(0)

  await guide.click()
  await expect(page.getByRole("dialog")).toContainText("Kernexa AI 가이드")
  expect(await output<string[]>(page, "external-links")).toEqual([])
})

test("public fatal error preserves the localized Discord reporting action", async ({ page }) => {
  await page.goto(fixture("error-public"))

  await expect(page.getByText("Please report this error to the OpenCode team")).toBeVisible()
  const discord = page.getByRole("button", { name: "on Discord" })
  await expect(discord).toBeVisible()
  await expect(discord.locator('use[href="#opencode-icon-discord"]')).toHaveCount(1)
  await expect(page.getByText("Kernexa AI 가이드", { exact: true })).toHaveCount(0)

  await discord.click()
  await expect.poll(() => output<string[]>(page, "external-links")).toEqual(["https://opencode.ai/desktop-feedback"])
})

test("Kernexa AI 가이드 restores the Windows menu trigger after both close paths", async ({ page }) => {
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
  test(`Kernexa AI 가이드 dialog fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(fixture("guide"))
    await openCompanyGuideFromMenu(page)

    const dialog = page.getByRole("dialog")
    const body = dialog.getByRole("region", { name: "Kernexa AI 가이드 내용" })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute("aria-labelledby", /.+/)
    await expect(body).toHaveAttribute("tabindex", "0")
    await expect(body).toBeFocused()
    await expect(dialog.getByText("Kernexa AI 가이드", { exact: true })).toBeVisible()
    await expect(dialog.getByText("버전 kernexa-1", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Kernexa AI 사용 가이드", level: 1 })).toBeVisible()
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
    await body.evaluate((node) => {
      node.scrollTop = 0
    })
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

  test(`Enterprise provider dialog fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(fixture("company"))
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await page.getByTestId("company-controls").evaluate((node) => node.setAttribute("hidden", ""))
    await dialog.getByRole("button", { name: "Create provider" }).click()
    await page.getByLabel("Provider ID").fill("compact-gateway")
    await page.getByLabel("Provider name").fill("Compact Gateway")
    await page.getByLabel("Base URL").fill("https://gateway.example/v1")
    await expect(dialog.getByRole("button", { name: "Save provider" })).toBeVisible()

    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.x).toBeGreaterThanOrEqual(0)
    expect(box?.y).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height)
    expect(
      await dialog.evaluate((node) => ({
        horizontal: node.scrollWidth > node.clientWidth,
      })),
    ).toEqual({ horizontal: false })

    await page.screenshot({ path: testInfo.outputPath(`enterprise-providers-${viewport.name}.png`) })
  })
})
