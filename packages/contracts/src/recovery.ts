import { Schema } from "effect";

export const weeklyRecoveryChecks = [
  "schema_compatible",
  "rls_isolated",
  "sampled_keys_usable",
  "invariants_valid",
  "quotas_valid",
  "audit_valid",
  "current_time_expiry_applied",
  "deletion_markers_replayed",
  "recipient_transitions_replayed",
  "recipient_purge_cutoffs_applied",
  "prepared_recipient_transitions_drained",
  "object_deletion_intents_drained",
  "deleted_identifiers_absent",
  "api_keys_revoked",
  "api_key_digests_cleared",
  "api_key_hmac_rotated",
  "predecessor_hmac_rejected",
] as const;

export const quarterlyRecoveryChecks = [
  "endpoint_rotation",
  "oauth_kv_reconstructed",
  "immutable_queue_replay",
  "kms_access",
  "r2_access",
  "media_loss_failed_closed",
  "alert_delivered",
  "deletion_gate_bypass_denied",
] as const;
export const quarterlyExecutorChecks = [
  "oauth_kv_reconstructed",
  "immutable_queue_replay",
  "kms_access",
  "r2_access",
  "media_loss_failed_closed",
  "alert_delivered",
] as const;

const UtcTimestamp = Schema.String.pipe(
  Schema.filter((value) => {
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    );
  }),
);
const Operation = Schema.String.pipe(
  Schema.pattern(/^recovery_operation_[a-f0-9]{32}$/u),
);
const Branch = Schema.String.pipe(Schema.pattern(/^br-[a-z0-9-]{1,57}$/u));
const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const NonnegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);
const Percentage = Schema.Number.pipe(
  Schema.finite(),
  Schema.filter((value) => value >= 0 && value <= 100),
);
const PassingAvailability = Percentage.pipe(
  Schema.filter((value) => value >= 99.5),
);

export const ReplayEvidenceSchema = Schema.Struct({
  deletion_markers_enumerated: NonnegativeInteger,
  deletion_marker_failures: Schema.Literal(0),
  deleted_entities_repurged: NonnegativeInteger,
  deleted_identifiers_remaining: Schema.Literal(0),
  recipient_transitions_replayed: NonnegativeInteger,
  recipient_transition_failures: Schema.Literal(0),
  unresolved_recipient_prefixes: NonnegativeInteger,
  expired_records_purged: NonnegativeInteger,
  api_keys_revoked: NonnegativeInteger,
  api_key_digests_cleared: NonnegativeInteger,
  object_deletion_intents_simulated: NonnegativeInteger,
  object_deletion_failures: Schema.Literal(0),
});

const WeeklyChecksSchema = Schema.Struct(
  Object.fromEntries(
    weeklyRecoveryChecks.map((check) => [check, Schema.Literal(true)]),
  ) as Record<(typeof weeklyRecoveryChecks)[number], Schema.Literal<[true]>>,
);
const QuarterlyChecksSchema = Schema.Struct({
  ...WeeklyChecksSchema.fields,
  ...Object.fromEntries(
    quarterlyRecoveryChecks.map((check) => [check, Schema.Literal(true)]),
  ),
});

const VerificationIdentity = {
  version: Schema.Literal(1),
  operation: Operation,
  recovery_branch_id: Branch,
  source_point_at: UtcTimestamp,
  started_at: UtcTimestamp,
  verification_nonce: Digest,
  replay_digest: Digest,
} as const;

const VerificationRequestBase = {
  ...VerificationIdentity,
  environment: Schema.Literal("production"),
  serving: Schema.Literal(false),
  replay: ReplayEvidenceSchema,
} as const;

export const RecoveryVerificationRequestSchema = Schema.Union(
  Schema.Struct({
    ...VerificationRequestBase,
    drill: Schema.Literal("weekly_restore"),
  }),
  Schema.Struct({
    ...VerificationRequestBase,
    drill: Schema.Literal("quarterly_game_day"),
  }),
);

const VerificationResponseBase = {
  ...VerificationIdentity,
  achieved_rpo_seconds: Schema.Number.pipe(
    Schema.finite(),
    Schema.nonNegative(),
    Schema.filter((value) => value <= 300),
  ),
  achieved_first_party_availability_percent: PassingAvailability,
  dependencies: Schema.Struct({
    wasender_percent: Percentage,
    whatsapp_percent: Percentage,
  }),
} as const;

export const RecoveryVerificationResponseSchema = Schema.Union(
  Schema.Struct({
    ...VerificationResponseBase,
    drill: Schema.Literal("weekly_restore"),
    checks: WeeklyChecksSchema,
  }),
  Schema.Struct({
    ...VerificationResponseBase,
    drill: Schema.Literal("quarterly_game_day"),
    checks: QuarterlyChecksSchema,
  }),
);

const strictDecode = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

export const decodeRecoveryVerificationRequest = strictDecode(
  RecoveryVerificationRequestSchema,
);
export const decodeRecoveryVerificationResponse = strictDecode(
  RecoveryVerificationResponseSchema,
);

const QuarterlyExecutionIdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  operation: Operation,
  recoveryBranchId: Branch,
  verificationNonce: Digest,
  replayDigest: Digest,
});
const QuarterlyExecutionReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation: Operation,
  receipt: Schema.String.pipe(
    Schema.pattern(/^quarterly_receipt_[a-f0-9]{64}$/u),
  ),
});

export const decodeQuarterlyRecoveryExecutionRequest = strictDecode(
  QuarterlyExecutionIdentitySchema,
);
export const decodeQuarterlyRecoveryExecutionReceipt = strictDecode(
  QuarterlyExecutionReceiptSchema,
);
export const decodeQuarterlyRecoveryVerificationRequest = strictDecode(
  Schema.Struct({
    ...QuarterlyExecutionIdentitySchema.fields,
    receipt: QuarterlyExecutionReceiptSchema.fields.receipt,
  }),
);
export const decodeQuarterlyRecoveryChecks = strictDecode(
  Schema.Struct(
    Object.fromEntries(
      quarterlyExecutorChecks.map((check) => [check, Schema.Literal(true)]),
    ),
  ),
);

export type ReplayEvidence = typeof ReplayEvidenceSchema.Type;
export type RecoveryVerificationRequest =
  typeof RecoveryVerificationRequestSchema.Type;
export type RecoveryVerificationResponse =
  typeof RecoveryVerificationResponseSchema.Type;

export type QuarterlyRecoveryExecutionRequest =
  typeof QuarterlyExecutionIdentitySchema.Type;

export type QuarterlyRecoveryExecutionReceipt =
  typeof QuarterlyExecutionReceiptSchema.Type;

export interface QuarterlyRecoveryExecutorService {
  readonly execute: (
    request: QuarterlyRecoveryExecutionRequest,
  ) => Promise<QuarterlyRecoveryExecutionReceipt>;
  readonly verify: (
    request: QuarterlyRecoveryExecutionRequest & {
      readonly receipt: string;
    },
  ) => Promise<
    Readonly<Record<(typeof quarterlyExecutorChecks)[number], true>>
  >;
}
