/**
 * eligibility-evaluator — the verdict gate that decouples grant from
 * self-assertion (GATE-SEC-1 · VB.3 · the `.23` binding).
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * The merged write engine (`complete.ts`) grants on a pre-built
 * `ActivityCompleted` event with NO APPROVED gate anywhere in its body — the
 * grant machinery and the verdict machinery are DECOUPLED. The route MUST NOT
 * construct that event until an authoritative verifier has APPROVED. This
 * evaluator IS that gate: it returns a {@link SubstrateStepVerdict}, and only
 * an APPROVED one entitles the caller to build the completion event.
 *
 * ── DISPATCH (default-deny) ──────────────────────────────────────────────────
 *
 *   - `ManualCurator { curator_id: "verify" }`  → verify-verifier (the
 *     identity-proof grader; APPROVED iff the route holds a verified JWT).
 *   - any other step                            → NEEDS_HUMAN verdict (NO
 *     APPROVED). Substrate-graded steps (essay/url/structured) route to the
 *     existing `dispatchEssayQuest` in the FULL cycle — out of scope for the
 *     GATE-SEC-1 verify slice, which ships ONE verifier. The evaluator NEVER
 *     invents an APPROVED for a step it has no verifier for.
 *
 * The invariant: there is no input — known step, unknown step, missing
 * verifier — for which this evaluator returns `status: "APPROVED"` other than a
 * verify step backed by an authenticated identity. Default is deny.
 *
 * ── F-002 ────────────────────────────────────────────────────────────────────
 *
 * Every verdict this evaluator emits is schema-validated (the verify path
 * re-decodes inside the verifier; the deny path constructs through the sealed
 * schema here). No untyped verdict escapes.
 *
 * VB.3 · GATE-SEC-1 · 2026-05-31 · verify-badge slice.
 */

import { Data, Effect, Schema } from "effect";

import {
  type Activity,
  type ActivityStep,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  SubstrateStepVerdict,
} from "@0xhoneyjar/quests-protocol";

import {
  type AuthenticatedIdentity,
  isVerifyStep,
  verifyIdentityProofVerifier,
  VerifyVerifierError,
} from "./verify-verifier.js";

/**
 * EligibilityError — sealed (never thrown). Wraps a verifier failure or a
 * deny-verdict construction fault.
 */
export class EligibilityError extends Data.TaggedError("EligibilityError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * Resolve the step the verdict is being requested for. The verify activity has
 * exactly one step; the caller passes the step_id it is completing. Returns
 * `null` when no such step exists on the activity (the caller treats that as
 * a non-APPROVED — you cannot complete a step the activity does not declare).
 */
export const resolveStep = (
  activity: Activity,
  stepId: string,
): ActivityStep | null => {
  for (const s of activity.steps) {
    if (s.step_id === stepId) return s;
  }
  return null;
};

/**
 * Build a NEEDS_HUMAN (non-APPROVED) verdict for a step this evaluator has no
 * authoritative verifier for. Default-deny: the route grants NOTHING on this.
 * Constructed through the sealed schema (F-002).
 */
const denyVerdict = (params: {
  readonly submissionId: string;
  readonly traceId: string;
  readonly reason: string;
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, EligibilityError> =>
  Effect.gen(function* () {
    const gradedAt = (params.gradedAtProvider ?? (() => new Date().toISOString()))();
    const unchecked = {
      submissionId: params.submissionId,
      traceId: params.traceId,
      status: "NEEDS_HUMAN" as const,
      confidence: 0,
      reasoning: params.reason,
      // Same named grader owns the deny decision so the audit trail is uniform:
      // "the eligibility gate declined to auto-approve this step."
      graderConstructSlug: "identity-proof",
      gradedAt,
      contractVersion: SUBSTRATE_STEP_CONTRACT_VERSION,
    };
    return yield* Schema.decodeUnknown(SubstrateStepVerdict)(unchecked).pipe(
      Effect.mapError(
        (cause) =>
          new EligibilityError({
            reason: "constructed deny verdict failed schema validation",
            cause,
          }),
      ),
    );
  });

/**
 * evaluateEligibility — the gate. Dispatches the step to its authoritative
 * verifier and returns the resulting {@link SubstrateStepVerdict}.
 *
 * The route MUST guard on `verdict.status === "APPROVED"` before constructing
 * any `ActivityCompleted` event. This function NEVER side-effects (no DB, no
 * grant, no HTTP) — it only adjudicates eligibility (Plane-2 / Plane-3
 * air-gap, mirroring `dispatch.ts`).
 *
 * @param activity   the resolved Activity (e.g. VERIFY_ACTIVITY)
 * @param stepId     the step the caller is completing
 * @param identity   the authenticated identity from the verified JWT (authoritative)
 * @param submissionId  authoritative correlation id (route-stamped)
 * @param traceId       authoritative trace id (route-stamped)
 */
export const evaluateEligibility = (params: {
  readonly activity: Activity;
  readonly stepId: string;
  readonly identity: AuthenticatedIdentity;
  readonly submissionId: string;
  readonly traceId: string;
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, EligibilityError> =>
  Effect.gen(function* () {
    const { activity, stepId, identity, submissionId, traceId, gradedAtProvider } =
      params;

    const step = resolveStep(activity, stepId);
    if (step === null) {
      // Cannot complete a step the activity does not declare → deny.
      return yield* denyVerdict({
        submissionId,
        traceId,
        reason: `activity "${activity.id}" declares no step "${stepId}" — refusing.`,
        ...(gradedAtProvider !== undefined && { gradedAtProvider }),
      });
    }

    // The verify ManualCurator step → the identity-proof verifier (the ONLY
    // path to APPROVED in this slice).
    if (isVerifyStep(step)) {
      return yield* verifyIdentityProofVerifier({
        identity,
        step,
        submissionId,
        traceId,
        ...(gradedAtProvider !== undefined && { gradedAtProvider }),
      }).pipe(
        Effect.catchTag("VerifyVerifierError", (e: VerifyVerifierError) =>
          // A verify-verifier refusal is a deny (NEEDS_HUMAN), never a crash.
          denyVerdict({
            submissionId,
            traceId,
            reason: `verify verifier declined: ${e.reason}`,
            ...(gradedAtProvider !== undefined && { gradedAtProvider }),
          }),
        ),
      );
    }

    // DEFAULT-DENY: every other step shape (substrate-graded essay/url, other
    // ManualCurator ids, on-chain, etc.) has no authoritative verifier wired in
    // this slice → NEEDS_HUMAN. Substrate-graded steps join via dispatchEssayQuest
    // in the full cycle; until then the gate denies rather than auto-approves.
    return yield* denyVerdict({
      submissionId,
      traceId,
      reason:
        `no authoritative verifier is wired for step "${stepId}" ` +
        `(verification _tag="${step.verification._tag}") — defaulting to ` +
        `NEEDS_HUMAN. Substrate-graded steps route through dispatchEssayQuest ` +
        `in the full cycle; this GATE-SEC-1 slice ships only the verify verifier.`,
      ...(gradedAtProvider !== undefined && { gradedAtProvider }),
    });
  });
