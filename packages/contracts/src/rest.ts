import { Schema } from "effect";
import { ConnectionId } from "./handles";
import { makePublicObjectContract, UtcTimestamp } from "./mcp-schema";

export const RestConnectionState = Schema.Literal(
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
);

export const RestConnection = Schema.Struct({
  connection_id: ConnectionId,
  display_name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  number_last_four: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
  ),
  state: RestConnectionState,
  state_changed_at: UtcTimestamp,
});
export type RestConnection = typeof RestConnection.Type;

export const RestPagination = Schema.Struct({
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
});
export type RestPagination = typeof RestPagination.Type;

export const RestConnectionListContract = makePublicObjectContract({
  data: Schema.Array(RestConnection).pipe(Schema.maxItems(3)),
  pagination: RestPagination,
});
export type RestConnectionList = typeof RestConnectionListContract.schema.Type;

export const ProblemStatus = Schema.Literal(400, 401, 403, 404, 409, 429, 503);

export const ProblemCode = Schema.Literal(
  "invalid_credentials",
  "insufficient_permission",
  "not_found",
  "rate_limited",
  "unavailable",
);
export type ProblemCode = typeof ProblemCode.Type;

export const ProblemDetailsContract = makePublicObjectContract({
  code: ProblemCode,
  detail: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  retry_after_seconds: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  retryable: Schema.optional(Schema.Boolean),
  resets_at: Schema.optional(UtcTimestamp),
  status: ProblemStatus,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  type: Schema.String.pipe(
    Schema.pattern(/^https:\/\/docs\.normal\.fast\/problems\/[a-z_]+$/),
  ),
});
export type ProblemDetails = typeof ProblemDetailsContract.schema.Type;

export const problemType = (code: ProblemCode): ProblemDetails["type"] =>
  `https://docs.normal.fast/problems/${code}` as ProblemDetails["type"];

export const decodeRestConnectionList = Schema.decodeUnknownSync(
  RestConnectionListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeProblemDetails = Schema.decodeUnknownSync(
  ProblemDetailsContract.schema,
  { onExcessProperty: "error" },
);
