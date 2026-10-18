import { expect, test } from "bun:test"
import { ProviderDiagnostic } from "../src/provider-diagnostic"

test("classifies structured HTTP and transport failures without reading error messages", () => {
  for (const input of [
    {
      codes: [
        "ConnectionClosed",
        "FailedToOpenSocket",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EPIPE",
      ],
      kind: "connection",
    },
    { codes: ["ENOTFOUND", "EAI_AGAIN"], kind: "dns" },
    {
      codes: [
        "CERT_AUTHORITY_INVALID",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ],
      kind: "tls",
    },
    { codes: ["ETIMEDOUT", "ABORT_ERR", "AbortError", "TimeoutError", "UND_ERR_CONNECT_TIMEOUT"], kind: "timeout" },
  ] as const)
    for (const code of input.codes) expect(ProviderDiagnostic.classify({ codes: [code] }), code).toBe(input.kind)
  expect(ProviderDiagnostic.classify({ statusCode: 401, codes: ["ENOTFOUND"] })).toBe("auth")
  expect(ProviderDiagnostic.classify({ statusCode: 403 })).toBe("auth")
  expect(ProviderDiagnostic.classify({ statusCode: 404, modelCode: "model_not_found", codes: ["ENOTFOUND"] })).toBe(
    "model",
  )
  expect(ProviderDiagnostic.classify({ statusCode: 408 })).toBe("timeout")
  expect(ProviderDiagnostic.classify({ statusCode: 504 })).toBe("timeout")
  expect(ProviderDiagnostic.classify({ codes: ["this message mentions a timeout"] })).toBe("response")
  expect(ProviderDiagnostic.classify({ stage: "streaming" })).toBe("stream")
  expect(ProviderDiagnostic.classify({ stage: "toolCall" })).toBe("tool_call")
})
