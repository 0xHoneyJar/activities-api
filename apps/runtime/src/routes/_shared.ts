/**
 * Shared helpers for the activity-supertype READ routes.
 *
 *  - `degraded(...)` — the `completeness: { status: "degraded" }` envelope the
 *    SDD mandates (§8 + §12.4 / IMP-008): when no DB is wired, data routes
 *    return 200 with an explicit degraded envelope rather than 500ing or
 *    silently serving empty. Consumers MUST surface degraded reads.
 *
 *  - `runRead(...)` — bridge a port Effect (an Effect<A, E>) to a Hyper handler
 *    return. On success → 200 with `{ items|record, completeness: full }`. On a
 *    sealed port error → mapped HTTP status carrying the `_tag`. Hyper handlers
 *    are plain async (they `Effect.runPromise` the engine) — there is NO
 *    Hyper↔Effect friction (OQ-2): Hyper coerces handler return values to
 *    Responses; the engine stays Effect-native behind the boundary.
 */

import { Cause, Effect, Exit, Option, Schema } from "effect";
import { badRequest, notFound, ok, unprocessable, jsonResponse } from "@hyper/core";
import { IdentityId, PartitionKey } from "@0xhoneyjar/quests-protocol";

// ===========================================================================
// Composite-partition codec — the LOAD-BEARING cross-plane contract (Fix 2).
//
// The write route ENCODES an identity-scoped composite partition value
// (`<identity-half>::<substep-half>`); the read plane PARSES the same shape to
// scope reads to exactly what the write side wrote. This codec is the SINGLE
// source of truth for that join/hash logic — it MUST NOT be duplicated in
// writes.ts or reads.ts. Keep the encoding behavior identical (a dedupe, not a
// re-encoding): a half is hashed iff it would exceed the 120-char composite cap.
// ===========================================================================

/** The PartitionKey composite cap per half (mirrors PartitionKey.ts). */
export const COMPOSITE_HALF_MAX = 120;

/**
 * Slug-safe digest of an over-long composite half. Deterministic (SHA-256 hex,
 * truncated) so a retry reproduces the same partition. Used ONLY when a half
 * would exceed the 120-char composite cap (operator decision #1).
 */
const shortHash = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
};

/**
 * Encode the identity half of the composite. `id_…` already starts `[a-z]` and
 * uses only [a-z0-9]; hash only when it would blow the 120-char half cap.
 */
const encodeIdentityHalf = async (identityId: string): Promise<string> =>
  identityId.length <= COMPOSITE_HALF_MAX
    ? identityId
    : `id_h${await shortHash(identityId)}`;

/**
 * Encode the substep half — single slug joining activity/period/step with `-`
 * (NOT `::`, which would create a second separator the pattern rejects).
 */
const encodeSubstepHalf = async (
  activityId: string,
  stepId: string,
  periodKey: string | null,
): Promise<string> => {
  const substepRaw = [activityId, periodKey ?? "noperiod", stepId].join("-");
  return substepRaw.length <= COMPOSITE_HALF_MAX
    ? substepRaw
    : `sub_h${await shortHash(substepRaw)}`;
};

/**
 * encodeCompositePartition — build the identity-scoped composite partition
 * value (the G-4 / `.20` finding). Two users completing the SAME activity must
 * NEVER CAS against a shared tip, so the partition is IDENTITY-first:
 *
 *     value = "<identity-half>::<substep-half>"
 *
 * Each half is slug-shaped (`[a-z][a-z0-9_-]{0,119}`) and ≤120 chars; both are
 * derived deterministically so a genuine retry hits the same partition
 * (→ idempotent duplicate-reject). The assembled value is decoded through the
 * REAL PartitionKey schema (composite-scope `<a>::<b>` filter) at the boundary —
 * a non-conforming value never escapes the codec as an unchecked cast.
 *
 * OPERATOR DECISION #1 (flagged): an `IdentityId` can be up to 131 chars
 * (`id_` + 128) — longer than the 120-char half cap. When that happens the
 * identity half is replaced by `id_h<short-hash>` (still slug-shaped, ≤120). The
 * substep half is hashed the same way when over length.
 */
export const encodeCompositePartition = async (
  identityId: string,
  activityId: string,
  stepId: string,
  periodKey: string | null,
): Promise<PartitionKey> => {
  const identityHalf = await encodeIdentityHalf(identityId);
  const substepHalf = await encodeSubstepHalf(activityId, stepId, periodKey);
  // Decode through the REAL PartitionKey schema — never an unchecked cast.
  return Schema.decodeUnknownSync(PartitionKey)({
    scope: "composite",
    value: `${identityHalf}::${substepHalf}`,
  });
};

/**
 * parseCompositePartition — the READ-side mirror: derive the EXACT composite
 * partition the write side encoded for a given (identity, activity, step,
 * period) tuple, so a read can scope to precisely what was written. Same join +
 * hash + PartitionKey decode as {@link encodeCompositePartition}; this is the
 * single shared codec both planes consume (Fix 2 — no duplicate join/hash).
 */
export const parseCompositePartition = encodeCompositePartition;

/**
 * compositeIdentityHalf — the identity-half slug a read plane would predicate
 * on to find all of one identity's composite partitions (the `id_…` or hashed
 * `id_h<hash>` left of `::`). Shares the SINGLE encodeIdentityHalf logic so the
 * read scope can never drift from the write encoding.
 */
export const compositeIdentityHalf = (identityId: string): Promise<string> =>
  encodeIdentityHalf(identityId);

/**
 * decodeIdentityScope — DECODE-AT-BOUNDARY for the read plane (Fix 1 + Fix 2).
 *
 * The read routes scope every query to the AUTHENTICATED identity (the JWT
 * `sub`), which arrives as an opaque string. Rather than an unchecked
 * `identity.identity_id as IdentityId` cast, the read plane decodes it through
 * the REAL IdentityId schema — the SAME boundary the write-side codec keys
 * partitions on — so the read scopes to EXACTLY what the write side encodes. A
 * non-conforming sub is rejected (`Either.left`) instead of silently widening
 * the SQL predicate. Returns an Either so callers can route a left to 422/empty.
 */
export const decodeIdentityScope = (rawIdentityId: string) =>
  Schema.decodeUnknownEither(IdentityId)(rawIdentityId);

export type Completeness =
  | { readonly status: "full" }
  | { readonly status: "degraded"; readonly reason: string; readonly fallback_source: string };

export const FULL: Completeness = { status: "full" };

/** Build the degraded envelope payload (200, empty items). */
export const degraded = (reason: string): Response =>
  ok({
    items: [] as ReadonlyArray<never>,
    next_cursor: null,
    total_count: null,
    completeness: {
      status: "degraded" as const,
      reason,
      fallback_source: "none (cubquest-db not bound)",
    } satisfies Completeness,
  });

/** Degraded single-record variant (for get-progress shape). */
export const degradedRecord = (reason: string): Response =>
  jsonResponse(503, {
    record: null,
    completeness: {
      status: "degraded" as const,
      reason,
      fallback_source: "none (cubquest-db not bound)",
    } satisfies Completeness,
  });

const HTTP_FOR_TAG: Record<string, number> = {
  ActivityNotFound: 404,
  IdentityNotFound: 404,
  AlreadyGranted: 200,
  IdentityUnresolvable: 422,
  AdapterUnavailable: 503,
  ConcurrentUpdate: 409,
  // EventError variants
  DuplicateEvent: 409,
  CASFailed: 409,
  SchemaValidation: 422,
  PartitionScopeMismatch: 400,
  NonceRequired: 400,
  NonceCollision: 409,
  CanonicalizationFailed: 422,
  // Defect #21.8: infra-transient event-store fault → 503 (retryable),
  // distinct from SchemaValidation's 422 (permanent bad input). Previously a
  // retry-exhausted serialization storm returned SchemaValidation → 422,
  // telling the client the input was permanently bad when the store was just
  // momentarily unreachable.
  EventStoreUnavailable: 503,
  // ── Write-path CompletionError variants (GATE-SEC-1 · VB.3) ──────────────
  // The engine's makeActivityCompletion().complete() never throws — every
  // failure is one of these sealed tags. Map each to the HTTP status that
  // tells the client whether to retry. UnknownResourceKind / IdentityResolution
  // are permanent bad-input (422); AtomicGrantFailed wraps an inner cause whose
  // own _tag the route unwraps before reaching this table; DeferredRecording
  // is a transient record failure (503).
  UnknownResourceKind: 422,
  IdentityResolutionFailed: 422,
  AtomicGrantFailed: 500,
  DeferredRecordingFailed: 503,
  // Eligibility-evaluator + verifier (the verdict gate) faults — schema drift
  // in a constructed verdict is a server-side bug, surface as 500 (never a
  // silent grant).
  EligibilityError: 500,
  VerifyVerifierError: 500,
};

/**
 * Run a read Effect and shape the HTTP response. `wrap` maps the success value
 * into the response body (e.g. into an `items` page or a `record`).
 */
export const runRead = async <A>(
  effect: Effect.Effect<A, { readonly _tag: string }>,
  wrap: (value: A) => unknown,
): Promise<Response> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return ok(wrap(exit.value));
  }
  // Defect (non-Fail) — surface as 500 with no internal leak.
  const failure = Exit.causeOption(exit);
  const err = extractTaggedFailure(failure);
  if (err === null) {
    return jsonResponse(500, { error: "internal", completeness: { status: "degraded", reason: "adapter defect" } });
  }
  const status = HTTP_FOR_TAG[err._tag] ?? 500;
  const body = { error: err._tag, detail: err, completeness: FULL };
  if (status === 404) return notFound(body as { code?: string });
  if (status === 400) return badRequest(body as { code?: string });
  if (status === 422) return unprocessable(body as { code?: string });
  return jsonResponse(status, body);
};

const extractTaggedFailure = (
  causeOpt: Option.Option<Cause.Cause<{ readonly _tag: string }>>,
): { readonly _tag: string } | null => {
  if (Option.isNone(causeOpt)) return null;
  const failureOpt = Cause.failureOption(causeOpt.value);
  if (Option.isNone(failureOpt)) return null;
  const first = failureOpt.value;
  if (typeof first === "object" && first !== null && "_tag" in first) {
    return first as { readonly _tag: string };
  }
  return null;
};

/**
 * Resolve the HTTP status for a sealed error tag. `AtomicGrantFailed` wraps an
 * inner `cause` (a sealed AtomicCompletionError — CASFailed / DuplicateEvent /
 * RewardAdapterUnavailable / …); we unwrap one level so the client gets the
 * RIGHT retry signal (a CAS race is 409, an adapter outage is 503) rather than
 * a blanket 500. The mapping table is the single source of truth.
 */
const statusForError = (err: { readonly _tag: string; readonly cause?: unknown }): number => {
  if (
    err._tag === "AtomicGrantFailed" &&
    typeof err.cause === "object" &&
    err.cause !== null &&
    "_tag" in err.cause
  ) {
    const innerTag = (err.cause as { readonly _tag: string })._tag;
    const innerStatus = HTTP_FOR_TAG[innerTag];
    if (innerStatus !== undefined) return innerStatus;
  }
  return HTTP_FOR_TAG[err._tag] ?? 500;
};

/**
 * runWrite — bridge a write-path Effect to a Hyper handler return.
 *
 * Distinct from {@link runRead} in two ways that matter for GATE-SEC-1:
 *
 *   1. It unwraps `AtomicGrantFailed.cause._tag` (via {@link statusForError}),
 *      so a CAS race / duplicate / outage maps to the correct retryable status
 *      instead of a blanket 500.
 *
 *   2. An idempotent-replay outcome — `DuplicateEvent` from the seam (the same
 *      completion already appended) — is NOT a client error: it is the
 *      idempotency contract working. The caller's `wrap` decides the success
 *      body; the seam's DuplicateEvent surfaces as 409 with the tag so the
 *      client can recognise the no-op replay.
 *
 * `wrap` maps the success value (a CompletionOutcome) into the response body.
 */
export const runWrite = async <A>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly cause?: unknown }>,
  wrap: (value: A) => unknown,
): Promise<Response> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return ok(wrap(exit.value));
  }
  const failure = Exit.causeOption(exit);
  const err = extractTaggedFailure(failure);
  if (err === null) {
    return jsonResponse(500, {
      error: "internal",
      completeness: { status: "degraded", reason: "write defect" },
    });
  }
  const status = statusForError(err as { _tag: string; cause?: unknown });
  const body = { error: err._tag, detail: err, completeness: FULL };
  if (status === 404) return notFound(body as { code?: string });
  if (status === 400) return badRequest(body as { code?: string });
  if (status === 422) return unprocessable(body as { code?: string });
  return jsonResponse(status, body);
};
