/**
 * The provider origin.
 *
 * One constant, imported by the six adapter modules that would otherwise repeat it as a literal.
 * It is a call target for text, PDF, and image sends, Directory reads, and lifecycle control. It
 * is also a validation boundary for media downloads and provider upload responses. Those
 * validation boundaries are why this is a single constant rather than a per-module literal: a
 * build where the call target and validated host disagree fails at a boundary, mid-operation,
 * rather than anywhere a reader would look.
 *
 * Concrete adapter constructors and fixtures retain the Wasender name because the WAPI origin
 * still implements that wire contract, including its envelopes, error shapes, and pagination.
 */
export const providerOrigin = "https://api.wapi.crafter.run";

/** Hostname used to validate provider-issued media URLs. */
export const providerMediaHostname = new URL(providerOrigin).hostname;
