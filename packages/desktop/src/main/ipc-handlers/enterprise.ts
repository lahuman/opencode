import { ipcMain } from "electron"
import { Option, Schema } from "effect"
import { EnterpriseChannel } from "../../shared/enterprise"
import { enterpriseDesktop } from "../lifecycle/enterprise"
import { parseEnterpriseProviderDiagnostic } from "../enterprise-readiness"
import { isTrustedRendererDocument } from "../windows/scheme"

const Model = Schema.Struct({ id: Schema.String })
const Provider = Schema.Struct({ id: Schema.String, baseURL: Schema.String, models: Schema.mutable(Schema.Array(Model)) })
const Credentials = Schema.Struct({ apiKey: Schema.optionalKey(Schema.String), headers: Schema.Record(Schema.String, Schema.String) })
const Ref = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

export async function registerEnterpriseHandlers() {
  const enterprise = await enterpriseDesktop()
  const api = enterprise.api
  const handler = <S extends Schema.ConstraintDecoder<ReadonlyArray<unknown>>>(
    schema: S,
    run: (...args: S["Type"]) => unknown,
  ) => {
    const decode = Schema.decodeUnknownOption(schema)
    return (args: unknown) => {
      const decoded = decode(args)
      if (Option.isNone(decoded)) throw new Error("Invalid enterprise request")
      return run(...decoded.value)
    }
  }
  const handlers = new Map([
    ["providerCatalog", handler(Schema.Tuple([]), api.providerCatalog)],
    ["createProvider", handler(Schema.Tuple([Schema.Struct({ provider: Provider, credentials: Schema.optionalKey(Credentials) })]), api.createProvider)],
    ["updateProvider", handler(Schema.Tuple([Schema.Struct({ providerID: Schema.String, baseURL: Schema.String, credentials: Schema.optionalKey(Credentials), clearCredentials: Schema.optionalKey(Schema.Literal(true)) })]), api.updateProvider)],
    ["deleteProvider", handler(Schema.Tuple([Schema.String]), api.deleteProvider)],
    ["createModel", handler(Schema.Tuple([Schema.Struct({ providerID: Schema.String, model: Model })]), api.createModel)],
    ["deleteModel", handler(Schema.Tuple([Ref]), api.deleteModel)],
    ["setDefaultModel", handler(Schema.Tuple([Ref]), api.setDefaultModel)],
    ["replaceProviderCredentials", handler(Schema.Tuple([Schema.Struct({ providerID: Schema.String, credentials: Credentials })]), api.replaceProviderCredentials)],
    ["clearProviderCredentials", handler(Schema.Tuple([Schema.String]), api.clearProviderCredentials)],
    ["readGuide", handler(Schema.Tuple([]), api.readGuide)],
    ["readiness", handler(Schema.Tuple([Schema.Unknown]), (input) => api.readiness(parseEnterpriseProviderDiagnostic(input)))],
    ["stateBackups", handler(Schema.Tuple([]), api.stateBackups)],
    ["restoreStateBackup", handler(Schema.Tuple([Schema.String]), api.restoreStateBackup)],
    ["skillPacks", handler(Schema.Tuple([]), api.skillPacks)],
    ["setSkillPackEnabled", handler(Schema.Tuple([Schema.String, Schema.Boolean]), api.setSkillPackEnabled)],
    ["openSkillPackSource", handler(Schema.Tuple([Schema.String]), api.openSkillPackSource)],
  ])
  ipcMain.handle(EnterpriseChannel, (event, method: unknown, args: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !event.senderFrame || !isTrustedRendererDocument(event.senderFrame.url))
      throw new Error("Untrusted enterprise request")
    const run = typeof method === "string" ? handlers.get(method) : undefined
    if (!run) throw new Error("Unknown enterprise operation")
    return run(args)
  })
}
