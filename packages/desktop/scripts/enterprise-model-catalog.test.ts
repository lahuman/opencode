import { expect, test } from "bun:test"
import { enterpriseModelEnvironment } from "./enterprise-model-catalog"

test("enterprise builds force the packaged model catalog", () => {
  expect(
    enterpriseModelEnvironment(
      { OPENCODE_ENTERPRISE: "1", MODELS_DEV_API_JSON: "C:/tmp/public-models.json" },
      "C:/repo/packages/desktop/resources/enterprise/models.json",
    ),
  ).toMatchObject({
    OPENCODE_ENTERPRISE: "1",
    MODELS_DEV_API_JSON: "C:/repo/packages/desktop/resources/enterprise/models.json",
  })
})

test("ordinary builds preserve the caller environment", () => {
  const env = { MODELS_DEV_API_JSON: "C:/tmp/models.json" }
  expect(enterpriseModelEnvironment(env, "C:/enterprise/models.json")).toEqual(env)
})
