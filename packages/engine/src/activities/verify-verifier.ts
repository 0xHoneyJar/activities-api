/**
 * verify-verifier — the authoritative APPROVED source for the verify step
 * (GATE-SEC-1 · VB.3).
 *
 * ── WHY THIS IS NOT THE HOLE ─────────────────────────────────────────────────
 *
 * The live CubQuests surface auto-completes `verificationType: "manual"` with
 * NO authoritative check, then grants. A blanket `() => APPROVED` here would
 * re-open that exact hole at a new altitude. This verifier does NOT do that.
 *
 * For the `verify` activity, the authoritative fact is *"the caller holds a
 * `requireIdentity`-validated identity-api JWT"* — and that IS the
 * verification: wallet ownership was proven at identity-api `/v1/auth/verify`
 * when the JWT was minted (HS256, iss-pinned, constant-time-verified at the
 * route's `requireIdentity` gate). This verifier maps that already-proven
 * authentication fact → an APPROVED verdict, attributing it to a NAMED,
 * auditable grader construct slug `identity-proof` (NOT a self-assertion).
 *
 * The distinction is load-bearing: a future audit can read every verify
 * completion's verdict trail and see "approved by `identity-proof`" — i.e. the
 * approval is derived from a cryptographically-verified JWT, not minted by the
 * writer.
 *
 * ── DEFAULT-DENY ─────────────────────────────────────────────────────────────
 *
 * This verifier ONLY fires for a `ManualCurator { curator_id: "verify" }` step
 * (the verify activity's single step). Any other curator_id / verification
 * method is OUT OF SCOPE and the verifier REFUSES (NEEDS_HUMAN) rather than
 * inventing an APPROVED. There is no code path where an unrecognized step
 * yields APPROVED. The default is deny.
 *
 * ── F-002 (Effect-channel-safe decode) ───────────────────────────────────────
 *
 * The constructed `SubstrateStepVerdict` is re-decoded through the sealed
 * schema before it is trusted (symmetric defense-in-depth — same discipline
 * `dispatch.ts` applies to its outbound verdict). A malformed verdict surfaces
 * as a typed {@link VerifyVerifierError} on the Effect error channel, never as
 * a thrown ParseError escaping as an Effect defect → 500.
 *
 * VB.3 · GATE-SEC-1 · 2026-05-31 · verify-badge slice.
 */

import { Data, Effect, Schema } from "effect";

import {
  type ActivityStep,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  SubstrateStepVerdict,
} from "@0xhoneyjar/quests-protocol";

/**
 * The named grader-construct slug attributed to every verify approval. It is a
 * permanent audit identity: it appears in every verify completion's verdict
 * trail. Matches `SubstrateStepVerdict.graderConstructSlug` pattern
 * `^[a-z][a-z0-9-]*$`.
 */
export const IDENTITY_PROOF_GRADER_SLUG = "identity-proof" as const;

/** The curator_id the verify activity's ManualCurator step carries. */
export const VERIFY_CURATOR_ID = "verify" as const;

/**
 * The authenticated identity the route extracted from the verified JWT. The
 * verifier consumes it as the authoritative fact backing the APPROVED verdict.
 * Mirrors `VerifiedIdentity` (apps/runtime) WITHOUT importing the runtime —
 * the engine stays I/O-free (Plane-2). Only the two scope fields are needed.
 */
export interface AuthenticatedIdentity {
  /** JWT `sub` — the proven identity. */
  readonly identity_id: string;
  /** JWT `tenant` — the world scope. */
  readonly world: string;
}

/**
 * VerifyVerifierError — sealed (never thrown). Surfaced when:
 *   - the step is NOT the verify ManualCurator step (out of scope · default-deny), or
 *   - the constructed verdict fails its own schema re-decode (F-002).
 */
export class VerifyVerifierError extends Data.TaggedError("VerifyVerifierError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * Decide whether a step is the verify ManualCurator step this verifier owns.
 * Pure; safe inside Effect.gen without yielding.
 */
export const isVerifyStep = (step: ActivityStep): boolean =>
  step.verification._tag === "ManualCurator" &&
  step.verification.curator_id === VERIFY_CURATOR_ID;

/**
 * verifyIdentityProofVerifier — map a `requireIdentity`-validated identity →
 * an APPROVED {@link SubstrateStepVerdict} for the verify step.
 *
 * NEVER auto-approves a step it does not own: a non-verify step yields a
 * sealed {@link VerifyVerifierError} (the caller maps it to a non-APPROVED
 * outcome → NO grant). Returns the APPROVED verdict ONLY for the verify
 * ManualCurator step, attributed to the named `identity-proof` grader.
 *
 * @param identity   the authenticated identity from the verified JWT (authoritative)
 * @param step       the activity step being verified
 * @param submissionId  authoritative correlation id (route-stamped, never body-supplied)
 * @param traceId       authoritative trace id (route-stamped, never body-supplied)
 */
export const verifyIdentityProofVerifier = (params: {
  readonly identity: AuthenticatedIdentity;
  readonly step: ActivityStep;
  readonly submissionId: string;
  readonly traceId: string;
  /** Injectable clock for `gradedAt` (testability). Default: wall clock. */
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, VerifyVerifierError> =>
  Effect.gen(function* () {
    const { identity, step, submissionId, traceId } = params;

    // DEFAULT-DENY: only the verify ManualCurator step is in scope. Anything
    // else is refused — NO APPROVED is ever invented for an unowned step.
    if (!isVerifyStep(step)) {
      return yield* Effect.fail(
        new VerifyVerifierError({
          reason:
            `verifyIdentityProofVerifier only approves the verify ManualCurator ` +
            `step (curator_id="${VERIFY_CURATOR_ID}"); got verification ` +
            `_tag="${step.verification._tag}". Refusing to APPROVE an unowned step.`,
        }),
      );
    }

    const gradedAt = (params.gradedAtProvider ?? (() => new Date().toISOString()))();

    // The APPROVED verdict. `confidence: 1.0` — wallet ownership is a binary
    // cryptographic fact, not a graded judgment. The reasoning bakes in the
    // identity + world for the audit trail (the only place a future auditor
    // sees WHICH authenticated identity backed this approval).
    const verdictUnchecked = {
      submissionId,
      traceId,
      status: "APPROVED" as const,
      confidence: 1,
      reasoning:
        `wallet ownership proven via identity-api JWT ` +
        `(sub=${identity.identity_id}, world=${identity.world}); ` +
        `approved by the ${IDENTITY_PROOF_GRADER_SLUG} grader.`,
      graderConstructSlug: IDENTITY_PROOF_GRADER_SLUG,
      gradedAt,
      contractVersion: SUBSTRATE_STEP_CONTRACT_VERSION,
    };

    // F-002: re-decode through the sealed schema before trusting. A drift in
    // the constructed shape surfaces as a typed error on the Effect channel,
    // never a thrown ParseError → 500.
    const verdict = yield* Schema.decodeUnknown(SubstrateStepVerdict)(
      verdictUnchecked,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new VerifyVerifierError({
            reason: "constructed verify verdict failed schema validation",
            cause,
          }),
      ),
    );

    return verdict;
  });
