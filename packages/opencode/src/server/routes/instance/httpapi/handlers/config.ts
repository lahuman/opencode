import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConfigEnterprise } from "@/config/enterprise"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return ConfigEnterprise.publicInfo(yield* configSvc.get())
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const payload = ConfigEnterprise.sanitizeWrite(ctx.payload)
      const result = yield* configSvc.update(payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ConfigEnterprise.publicInfo(result)
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map((provider) =>
          Provider.toPublicInfo(provider, { redactSecrets: ConfigEnterprise.settings().enabled }),
        ),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
