import { mock } from "bun:test"
mock.module("electron", () => ({ app: { isPackaged: true, getVersion: () => "2.0.30" } }))
const { desktopIdentity } = await import("../src/main/constants")
process.stdout.write(JSON.stringify({
  enterpriseProd: desktopIdentity({ channel: "prod", enterprise: true }),
  enterpriseDev: desktopIdentity({ channel: "dev", enterprise: true }),
  dev: desktopIdentity({ channel: "dev", enterprise: false }),
  beta: desktopIdentity({ channel: "beta", enterprise: false }),
  prod: desktopIdentity({ channel: "prod", enterprise: false }),
}))
