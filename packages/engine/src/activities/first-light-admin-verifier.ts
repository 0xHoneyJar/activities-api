/**
 * first-light-admin-verifier — the authoritative APPROVED source for an
 * operator-attested First Light grant (GATE-SEC-1 · mirrors verify-verifier).
 *
 * ── WHY ADMIN-ATTESTED ───────────────────────────────────────────────────────
 *
 * First Light recognizes a hand-picked founding cohort — there is no self-proof
 * (no JWT, no merkle snapshot, no correlation). The OPERATOR is the authority:
 * the route gates on the `admin-grant` service token (§1.12), and THAT admin
 * authorization is the authoritative fact this verifier maps → APPROVED. The
 * recipient `identity_id` is operator-supplied (the operator hand-picks who) —
 * the route decodes it through the real IdentityId boundary before the grant.
 *
 * The approval is attributed to the NAMED grader slug `first-light-admin` so a
 * future audit reads every First Light completion's verdict trail and sees the
 * approval was operator-attested, not self-minted.
 *
 * ── DEFAULT-DENY ─────────────────────────────────────────────────────────────
 *
 * Fires ONLY for the first-light ManualCurator step (`curator_id "first-light"`).
 * Any other step → sealed {@link FirstLightAdminError} (caller denies, NO grant).
 * There is no path where an unowned step yields APPROVED.
 *
 * I/O-free (Plane-2): the route enforces the admin token + supplies the
 * recipient; this verifier only adjudicates the step + constructs the verdict.
 *
 * First Light · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { Data, Effect, Schema } from "effect";

import {
  type ActivityStep,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  SubstrateStepVerdict,
} from "@0xhoneyjar/quests-protocol";

/** The named grader-construct slug attributed to every First Light approval. */
export const FIRST_LIGHT_GRADER_SLUG = "first-light-admin" as const;

/** The curator_id the first-light activity's ManualCurator step carries. */
export const FIRST_LIGHT_CURATOR_ID = "first-light" as const;

/** FirstLightAdminError — sealed (never thrown). `reason` is audit-facing. */
export class FirstLightAdminError extends Data.TaggedError(
  "FirstLightAdminError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** Decide whether a step is the first-light ManualCurator step this verifier owns. */
export const isFirstLightStep = (step: ActivityStep): boolean =>
  step.verification._tag === "ManualCurator" &&
  step.verification.curator_id === FIRST_LIGHT_CURATOR_ID;

/**
 * firstLightAdminVerifier — map an operator-attested admin grant → an APPROVED
 * {@link SubstrateStepVerdict} for the first-light step.
 *
 * NEVER auto-approves a step it does not own (default-deny). The admin AUTHORITY
 * is established UPSTREAM by the route's `admin-grant` token gate; this verifier
 * confirms the step is the first-light step and constructs the APPROVED verdict,
 * baking the recipient + weight into the reasoning for the audit trail.
 *
 * @param step          the activity step (MUST be the first-light step)
 * @param recipientId   operator-supplied recipient identity_id (route-decoded)
 * @param weight        founding=2 / supporting=1 — recorded as metadata, NOT power
 * @param submissionId  route-stamped correlation id (never body-supplied)
 * @param traceId       route-stamped trace id (never body-supplied)
 */
export const firstLightAdminVerifier = (params: {
  readonly step: ActivityStep;
  readonly recipientId: string;
  readonly weight: number;
  readonly submissionId: string;
  readonly traceId: string;
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, FirstLightAdminError> =>
  Effect.gen(function* () {
    const { step, recipientId, weight, submissionId, traceId } = params;

    // DEFAULT-DENY: only the first-light ManualCurator step is in scope.
    if (!isFirstLightStep(step)) {
      return yield* Effect.fail(
        new FirstLightAdminError({
          reason:
            `firstLightAdminVerifier only approves the first-light ManualCurator ` +
            `step (curator_id="${FIRST_LIGHT_CURATOR_ID}"); got verification ` +
            `_tag="${step.verification._tag}". Refusing to APPROVE an unowned step.`,
        }),
      );
    }

    // WEIGHT INVARIANT: founding=2 / supporting=1 are the only valid weights.
    // Enforced HERE (the authoritative APPROVED source), not just at the HTTP
    // body schema — so a direct/future caller can never mint an APPROVED verdict
    // with an out-of-contract weight (0, 999, NaN). Fail-closed.
    if (weight !== 1 && weight !== 2) {
      return yield* Effect.fail(
        new FirstLightAdminError({
          reason:
            `firstLightAdminVerifier only approves founding weights 1 or 2; ` +
            `got weight=${weight}. Refusing an out-of-contract grant weight.`,
        }),
      );
    }

    const gradedAt = (params.gradedAtProvider ?? (() => new Date().toISOString()))();

    const verdictUnchecked = {
      submissionId,
      traceId,
      status: "APPROVED" as const,
      confidence: 1,
      reasoning:
        `operator-attested First Light founding grant for identity "${recipientId}" ` +
        `(weight=${weight}); approved by the ${FIRST_LIGHT_GRADER_SLUG} grader.`,
      graderConstructSlug: FIRST_LIGHT_GRADER_SLUG,
      gradedAt,
      contractVersion: SUBSTRATE_STEP_CONTRACT_VERSION,
    };

    // F-002: re-decode through the sealed schema before trusting.
    return yield* Schema.decodeUnknown(SubstrateStepVerdict)(verdictUnchecked).pipe(
      Effect.mapError(
        (cause) =>
          new FirstLightAdminError({
            reason: "constructed first-light verdict failed schema validation",
            cause,
          }),
      ),
    );
  });
