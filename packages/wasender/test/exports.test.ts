import { describe, expect, test } from "bun:test";
import packageManifest from "../package.json";
import { lifecycleWritePolicy } from "../src/control";
import * as sessionExports from "../src/session";
import {
  guardedMediaDownloadPolicy,
  jsonReadPolicy,
  mediaDecryptMetadataPolicy,
  textSendPolicy,
} from "../src/session";
import { webhookNormalizationPolicy } from "../src/webhook";

describe("@whatsapp-mcp/wasender boundaries", () => {
  test("exports focused provider seams without a catch-all barrel", () => {
    expect(Object.keys(packageManifest.exports).sort()).toEqual([
      "./control",
      "./media",
      "./session",
      "./webhook",
      "./webshare",
    ]);
    expect(packageManifest.exports).not.toHaveProperty(".");
    expect(sessionExports).toHaveProperty("makeWasenderTextSending");
    expect(sessionExports).toHaveProperty("makeWasenderTextSendingLayer");
    expect(sessionExports).toHaveProperty("makeWasenderPdfSending");
    expect(sessionExports).toHaveProperty("makeWasenderPdfSendingLayer");
    expect(sessionExports).toHaveProperty("makeWasenderImageSending");
    expect(sessionExports).toHaveProperty("makeWasenderImageSendingLayer");
    expect(sessionExports).not.toHaveProperty(
      "makeWasenderTextSendingWithRuntime",
    );
    expect(sessionExports).not.toHaveProperty(
      "makeWasenderPdfSendingWithRuntime",
    );
    expect(sessionExports).not.toHaveProperty(
      "makeWasenderImageSendingWithRuntime",
    );
  });

  test("keeps retry policy operation-specific", () => {
    expect(jsonReadPolicy).toEqual({
      ambiguity: "safe-to-repeat",
      attemptTimeoutMs: 10_000,
      jittered: true,
      maxAttempts: 3,
      maxResponseBytes: 1_048_576,
      maxRetryAfterMs: 5_000,
      operationClass: "safe-read",
      reconciliation: "not-required",
      retryHttpStatuses: [408, 429, "5xx"],
      retryNetworkErrors: true,
      totalTimeoutMs: 25_000,
    });
    expect(textSendPolicy).toEqual({
      ambiguity: "acceptance-may-be-unknown",
      attemptTimeoutMs: 15_000,
      maxAttempts: 1,
      maxResponseBytes: 1_048_576,
      operationClass: "text-send",
      reconciliation: "exact-identity-evidence-only",
      retryAmbiguousResult: false,
    });
    expect(lifecycleWritePolicy).toEqual({
      ambiguity: "provider-state-may-have-changed",
      attemptTimeoutMs: 15_000,
      maxAttemptsBeforeReconciliation: 1,
      maxResponseBytes: 1_048_576,
      operationClass: "lifecycle-write",
      reconciliation: "required-before-repeat",
      repeatStrategy: "reconcile-before-repeat",
    });
    expect(mediaDecryptMetadataPolicy).toEqual({
      ambiguity: "safe-to-repeat",
      attemptTimeoutMs: 30_000,
      maxAttempts: 1,
      maxResponseBytes: 1_048_576,
      operationClass: "media-metadata",
      reconciliation: "not-required",
    });
    expect(guardedMediaDownloadPolicy).toEqual({
      ambiguity: "partial-bytes-must-be-discarded",
      attemptTimeoutMs: 60_000,
      maxAttempts: 1,
      maxResponseBytes: 100_000_000,
      operationClass: "media-download",
      reconciliation: "restart-from-byte-zero",
    });
    expect(webhookNormalizationPolicy).toEqual({
      maximumPayloadBytes: 1_048_576,
      operationClass: "webhook-normalization",
    });
  });
});
