/**
 * verify-attestation-verifier — the authoritative APPROVED source for a B2
 * service-attested verify completion (GATE-SEC-1 · S1.5 · HIGH-740/760/750).
 *
 * ── WHY A SERVICE-ATTESTED PATH ──────────────────────────────────────────────
 *
 * `freeside-characters` grants the verify badge AFTER a successful Discord
 * verify, but the bot holds NO user JWT — so it cannot use the user-JWT
 * eligibility gate (`evaluateEligibility` → verify-verifier). Instead it calls a
 * service-authenticated completion entry carrying a context-bound attestation,
 * and THIS grader adjudicates it. A blanket approve would let a leaked
 * verify-write token grant arbitrary verify badges — this grader does NOT do
 * that. APPROVED is derived from independently-checkable facts, ALL required:
 *
 *   (1) family allowlist  — fires ONLY for the verify step (`act_verify`);
 *   (2) correlation       — identity-api independently confirms the asserted
 *                           `identity_id` ↔ `discord_user_id` link (HIGH-740);
 *                           the ROUTE performs the resolve I/O and passes the
 *                           result; a null/mismatch is a HARD deny;
 *   (3) world allowlist   — `world` ∈ the configured allowlist (mibera);
 *   (4) idempotency shape  — `idempotency_key` === `b2:<identity_id>:<verify_event_id>`
 *                           (the §5.2.1 dedup anchor; the store collapses replays);
 *   (5) freshness         — `issued_at` within a bounded window (HIGH-760
 *                           anti-replay; generous because the C6 DLQ may retry).
 *
 * Combined, a leaked verify-write token can grant — at most — a verify badge for
 * an identity that genuinely links the asserted discord id in an allowlisted
 * world: the token's own legitimate function, not arbitrary grants.
 *
 * Stays I/O-free (Plane-2): the route verifies the service token + performs the
 * identity-api correlation read, then injects the resolved id + allowlist + clock
 * here. Mirrors {@link verifyIdentityProofVerifier} / {@link merkleMembershipVerifier}.
 *
 * S1.5 · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { Data, Effect, Schema } from "effect";

import {
  type ActivityStep,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  SubstrateStepVerdict,
} from "@0xhoneyjar/quests-protocol";

import { isVerifyStep } from "./verify-verifier.js";

/** The named grader-construct slug attributed to every B2 attested approval. */
export const VERIFY_ATTESTATION_GRADER_SLUG = "verify-attestation" as const;

/** Default freshness window for `issued_at` (24h — generous for DLQ retries). */
export const DEFAULT_ATTESTATION_FRESHNESS_SECONDS = 86_400;

/**
 * The B2 attestation payload (§1.11). Built by freeside-characters after a
 * successful verify role grant and POSTed under the verify-write service token.
 * This is the wire contract between the bot (C6) and activities-api (C3); the
 * route decodes untrusted input through {@link VerifyAttestation} before the
 * grader sees it. (Candidate to graduate to `quests-protocol` when C6 lands so
 * both repos share one schema.)
 */
export const VerifyAttestation = Schema.Struct({
  identity_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  discord_user_id: Schema.String.pipe(Schema.pattern(/^[0-9]{1,32}$/)),
  world: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  verify_event_id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  issued_at: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  idempotency_key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
});

export type VerifyAttestation = Schema.Schema.Type<typeof VerifyAttestation>;

/** VerifyAttestationError — sealed (never thrown). `reason` is audit-facing. */
export class VerifyAttestationError extends Data.TaggedError("VerifyAttestationError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** The expected server-verifiable idempotency-key shape (§1.11 / §5.2.1). */
export const attestationIdempotencyKey = (a: VerifyAttestation): string =>
  `b2:${a.identity_id}:${a.verify_event_id}`;

/**
 * verifyAttestationVerifier — APPROVED iff ALL §1.11 binds hold. Any failure →
 * sealed {@link VerifyAttestationError} (→ caller denies, NO grant).
 *
 * @param attestation         the decoded §1.11 payload
 * @param resolvedIdentityId  identity-api's answer for `discord_user_id` (route
 *                            supplies via the resolve read); `null` = 404/error
 * @param step                the activity step (MUST be the verify step)
 * @param worldAllowlist      the configured allowed worlds (env, §1.11.2)
 * @param nowMsProvider       injectable clock (epoch ms) for the freshness check
 * @param freshnessSeconds    bounded `issued_at` window (default 24h)
 */
export const verifyAttestationVerifier = (params: {
  readonly attestation: VerifyAttestation;
  readonly resolvedIdentityId: string | null;
  readonly step: ActivityStep;
  readonly worldAllowlist: readonly string[];
  readonly nowMsProvider?: () => number;
  readonly freshnessSeconds?: number;
  readonly submissionId: string;
  readonly traceId: string;
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, VerifyAttestationError> =>
  Effect.gen(function* () {
    const { attestation: a, resolvedIdentityId, step, worldAllowlist } = params;
    const deny = (reason: string) => Effect.fail(new VerifyAttestationError({ reason }));

    // (1) FAMILY ALLOWLIST: fires only for the verify step. A service token is
    // scoped to act_verify; refuse anything else.
    if (!isVerifyStep(step)) {
      return yield* deny(
        `verify-attestation only approves the verify step; got verification ` +
          `_tag="${step.verification._tag}". Refusing an unowned step.`,
      );
    }

    // (2) CORRELATION (HIGH-740): identity-api MUST independently confirm the
    // asserted identity_id ↔ discord_user_id. The route resolved it; null or a
    // mismatch is a hard deny — the caller's identity_id is never trusted alone.
    if (resolvedIdentityId === null) {
      return yield* deny(
        `identity-api did not resolve discord_user_id "${a.discord_user_id}" to any identity.`,
      );
    }
    if (resolvedIdentityId !== a.identity_id) {
      return yield* deny(
        `correlation mismatch: discord_user_id "${a.discord_user_id}" resolves to a ` +
          `different identity than the asserted "${a.identity_id}".`,
      );
    }

    // (3) WORLD ALLOWLIST (§1.11.2): the world must be configured-allowlisted.
    if (!worldAllowlist.includes(a.world)) {
      return yield* deny(`world "${a.world}" is not in the activities world allowlist.`);
    }

    // (4) IDEMPOTENCY SHAPE (§5.2.1): server-verifiable b2:<id>:<event>. The
    // store collapses replays; here we reject a malformed/forged key.
    const expectedKey = attestationIdempotencyKey(a);
    if (a.idempotency_key !== expectedKey) {
      return yield* deny(
        `idempotency_key does not match the server-verifiable shape ` +
          `"b2:<identity_id>:<verify_event_id>".`,
      );
    }

    // (5) FRESHNESS (HIGH-760): issued_at within the bounded window, and not
    // implausibly in the future (clock-skew-tolerant). A malformed timestamp
    // is a deny, not a crash.
    const issuedMs = Date.parse(a.issued_at);
    if (Number.isNaN(issuedMs)) {
      return yield* deny(`issued_at "${a.issued_at}" is not a parseable timestamp.`);
    }
    // Fail-CLOSED on a non-finite clock or freshness window: a misconfigured
    // window parsed to NaN/Infinity would make the comparisons below evaluate
    // false and let a STALE attestation approve (FAGAN S1.5 — anti-replay
    // fail-open). Reject before the arithmetic. (NaN/Infinity comparisons are
    // always false, which is exactly the fail-open direction.)
    const nowMs = (params.nowMsProvider ?? (() => Date.now()))();
    if (!Number.isFinite(nowMs)) {
      return yield* deny(`freshness clock returned a non-finite timestamp.`);
    }
    const freshnessSeconds = params.freshnessSeconds ?? DEFAULT_ATTESTATION_FRESHNESS_SECONDS;
    if (!Number.isFinite(freshnessSeconds) || freshnessSeconds <= 0) {
      return yield* deny(`freshness window must be a positive finite number of seconds.`);
    }
    const windowMs = freshnessSeconds * 1000;
    const skewMs = 5 * 60 * 1000; // tolerate 5m of forward clock skew
    if (issuedMs > nowMs + skewMs) {
      return yield* deny(`issued_at "${a.issued_at}" is in the future.`);
    }
    if (nowMs - issuedMs > windowMs) {
      return yield* deny(`issued_at "${a.issued_at}" is stale (outside the freshness window).`);
    }

    const gradedAt = (params.gradedAtProvider ?? (() => new Date().toISOString()))();

    const verdictUnchecked = {
      submissionId: params.submissionId,
      traceId: params.traceId,
      status: "APPROVED" as const,
      confidence: 1,
      reasoning:
        `service-attested verify: identity-api confirmed identity "${a.identity_id}" ↔ ` +
        `discord "${a.discord_user_id}" in world "${a.world}" (verify_event=${a.verify_event_id}); ` +
        `approved by the ${VERIFY_ATTESTATION_GRADER_SLUG} grader.`,
      graderConstructSlug: VERIFY_ATTESTATION_GRADER_SLUG,
      gradedAt,
      contractVersion: SUBSTRATE_STEP_CONTRACT_VERSION,
    };

    // F-002: re-decode through the sealed schema before trusting.
    return yield* Schema.decodeUnknown(SubstrateStepVerdict)(verdictUnchecked).pipe(
      Effect.mapError(
        (cause) =>
          new VerifyAttestationError({
            reason: "constructed verify-attestation verdict failed schema validation",
            cause,
          }),
      ),
    );
  });
