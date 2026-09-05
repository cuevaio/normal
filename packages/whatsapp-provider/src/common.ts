import type { Effect, Redacted } from "effect";

declare const providerNeutralReference: unique symbol;
declare const protectedAdapterValue: unique symbol;
declare const boundedRetryAfter: unique symbol;

/**
 * Adapter-produced references are safe equality or routing tokens. A concrete
 * adapter must not use a raw provider identifier as the runtime value.
 */
export type AdapterReference<Name extends string> = string & {
  readonly [providerNeutralReference]: Name;
};

export type ProtectedAdapterValue<Name extends string> = Redacted.Redacted<
  string & {
    readonly [protectedAdapterValue]: Name;
  }
>;

export type UtcTimestamp = string;

export type OperationClass =
  | "safe-read"
  | "text-send"
  | "lifecycle-write"
  | "media-metadata"
  | "media-download"
  | "webhook-normalization";

export type AdapterFailureCode =
  | "authentication_failed"
  | "integrity_failed"
  | "invalid_response"
  | "response_too_large"
  | "source_rejected"
  | "throttled"
  | "timed_out"
  | "unavailable";

export type RetryDecision =
  | "defer_to_ingestion_retry"
  | "do_not_retry"
  | "reconcile_before_repeat"
  | "restart_media_from_byte_zero"
  | "retry_within_safe_read_budget";

export const maximumJsonResponseBytes = 1_048_576;
export const maximumRetryAfterMs = 5_000;
export const maximumMediaDownloadBytes = 100_000_000;

export type BoundedRetryAfterMs = number & {
  readonly [boundedRetryAfter]: "BoundedRetryAfterMs";
};

/**
 * Converts a validated non-negative delay into the only Retry-After value that
 * may cross the seam. Longer provider delays are capped by the read policy.
 */
export const makeBoundedRetryAfterMs = (value: number): BoundedRetryAfterMs => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Retry-After delay must be a non-negative integer");
  }
  return Math.min(value, maximumRetryAfterMs) as BoundedRetryAfterMs;
};

/**
 * The error channel deliberately has no message, cause, status text, response
 * body, URL, or provider identifier. Concrete transport errors are translated
 * to this closed classification at the adapter boundary.
 */
interface ProviderNeutralFailureBase<
  Operation extends OperationClass,
  Decision extends RetryDecision,
> {
  readonly _tag: "ProviderNeutralFailure";
  readonly code: AdapterFailureCode;
  readonly operation: Operation;
  readonly retryDecision: Decision;
}

/**
 * Failure decisions are coupled to their operation class so a generic caller
 * cannot apply the safe-read retry policy to a write or partial media stream.
 * Text sends use `TextSendResult` instead of the error channel because every
 * post-attempt transport outcome must remain a non-retryable operation result.
 */
export type ProviderNeutralFailure =
  | (ProviderNeutralFailureBase<
      "safe-read",
      "do_not_retry" | "retry_within_safe_read_budget"
    > & {
      readonly retryAfterMs: BoundedRetryAfterMs | null;
    })
  | (ProviderNeutralFailureBase<
      "lifecycle-write",
      "do_not_retry" | "reconcile_before_repeat"
    > & {
      readonly retryAfterMs: null;
    })
  | (ProviderNeutralFailureBase<"media-metadata", "do_not_retry"> & {
      readonly retryAfterMs: null;
    })
  | (ProviderNeutralFailureBase<
      "media-download",
      "do_not_retry" | "restart_media_from_byte_zero"
    > & {
      readonly retryAfterMs: null;
    })
  | (ProviderNeutralFailureBase<
      "webhook-normalization",
      "defer_to_ingestion_retry" | "do_not_retry"
    > & {
      readonly retryAfterMs: null;
    });

export type AdapterEffect<Value> = Effect.Effect<Value, ProviderNeutralFailure>;
