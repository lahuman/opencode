export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class PlanReadOnlyError extends Schema.TaggedErrorClass<PlanReadOnlyError>()("PermissionPlanReadOnlyError", {
  reason: Schema.String,
  alternative: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Plan read-only denial: ${this.reason}. Safe alternative: ${this.alternative ?? "continue planning with read-only tools and ask the user to perform the mutation"}. The Plan agent must not retry an equivalent request.`
  }
}

export class ReviewedDeniedError extends Schema.TaggedErrorClass<ReviewedDeniedError>()(
  "PermissionReviewedDeniedError",
  {
    reason: Schema.String,
    alternative: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return `Automatic-review denial: ${this.reason}. Safe alternative: ${this.alternative ?? "ask the user to review the request manually or choose a safer action"}. The Plan agent must not retry an equivalent request.`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError | PlanReadOnlyError | ReviewedDeniedError
