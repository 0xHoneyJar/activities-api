/**
 * eligibility-evaluator + verify-verifier tests (VB.3 · GATE-SEC-1).
 *
 * These prove the verdict gate that closes the auto-complete hole:
 *   - the verify ManualCurator step backed by an authenticated identity →
 *     APPROVED, attributed to the NAMED `identity-proof` grader (NOT a blanket
 *     auto-approve);
 *   - EVERY other input (unknown step, non-verify ManualCurator, substrate-
 *     graded step, wrong step_id) → a non-APPROVED verdict (default-deny);
 *   - the verdict is always a schema-valid SubstrateStepVerdict (F-002).
 *
 * Pure Effect — no Postgres, no HTTP. The route-level "non-APPROVED cannot
 * grant" regression lives in apps/runtime/src/routes/__tests__/writes.test.ts.
 *
 * VB.3 · GATE-SEC-1 · 2026-05-31 · verify-badge slice.
 */

import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type Activity,
  type ActivityStep,
  StepId,
  SubstrateStepVerdict,
  VERIFY_ACTIVITY,
} from "@0xhoneyjar/quests-protocol";

import {
  evaluateEligibility,
  resolveStep,
} from "../eligibility.js";
import {
  IDENTITY_PROOF_GRADER_SLUG,
  isVerifyStep,
  verifyIdentityProofVerifier,
} from "../verify-verifier.js";

const IDENTITY = { identity_id: "id_player001", world: "mibera" } as const;
const FIXED_GRADED_AT = () => "2026-05-31T12:00:00.000Z";

/** The verify activity's single step (the ManualCurator verify step). */
const verifyStep = VERIFY_ACTIVITY.steps[0] as ActivityStep;

const stepId = (s: string) => Schema.decodeUnknownSync(StepId)(s);

/** A non-verify ManualCurator step (different curator_id). */
const otherCuratorStep: ActivityStep = {
  ...verifyStep,
  step_id: stepId("step_other"),
  verification: { _tag: "ManualCurator", curator_id: "moderator" },
};

/** A substrate-graded (essay) style step via a different verification method. */
const onChainStep: ActivityStep = {
  ...verifyStep,
  step_id: stepId("step_onchain"),
  verification: { _tag: "OnChainEvent", contract: "0xabc", event: "Minted", vm: "evm" },
};

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff as Effect.Effect<A, never>);

describe("verifyIdentityProofVerifier — the identity-proof grader (VB.3)", () => {
  it("APPROVES the verify ManualCurator step, attributed to identity-proof", async () => {
    const verdict = await run(
      verifyIdentityProofVerifier({
        identity: IDENTITY,
        step: verifyStep,
        submissionId: "sub-1",
        traceId: "trace-1",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.status).toBe("APPROVED");
    expect(verdict.graderConstructSlug).toBe(IDENTITY_PROOF_GRADER_SLUG);
    expect(verdict.confidence).toBe(1);
    // The audit trail bakes in the authenticated identity + world.
    expect(verdict.reasoning).toContain("id_player001");
    expect(verdict.reasoning).toContain("mibera");
    // The emitted verdict is a real, schema-valid SubstrateStepVerdict (F-002).
    const decoded = Schema.decodeUnknownEither(SubstrateStepVerdict)(verdict);
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("stamps submissionId + traceId AUTHORITATIVELY (route-supplied, never body)", async () => {
    const verdict = await run(
      verifyIdentityProofVerifier({
        identity: IDENTITY,
        step: verifyStep,
        submissionId: "authoritative-sub",
        traceId: "authoritative-trace",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.submissionId).toBe("authoritative-sub");
    expect(verdict.traceId).toBe("authoritative-trace");
  });

  it("REFUSES (errors) a non-verify ManualCurator step — never auto-approves it", async () => {
    const result = await Effect.runPromise(
      verifyIdentityProofVerifier({
        identity: IDENTITY,
        step: otherCuratorStep,
        submissionId: "sub-2",
        traceId: "trace-2",
        gradedAtProvider: FIXED_GRADED_AT,
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("VerifyVerifierError");
    }
  });

  it("isVerifyStep is true ONLY for ManualCurator curator_id=verify", () => {
    expect(isVerifyStep(verifyStep)).toBe(true);
    expect(isVerifyStep(otherCuratorStep)).toBe(false);
    expect(isVerifyStep(onChainStep)).toBe(false);
  });
});

describe("evaluateEligibility — the verdict gate (default-deny)", () => {
  it("verify step + authenticated identity → APPROVED (the ONLY approval path)", async () => {
    const verdict = await run(
      evaluateEligibility({
        activity: VERIFY_ACTIVITY,
        stepId: "step_verify",
        identity: IDENTITY,
        submissionId: "sub-3",
        traceId: "trace-3",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.status).toBe("APPROVED");
    expect(verdict.graderConstructSlug).toBe(IDENTITY_PROOF_GRADER_SLUG);
  });

  it("UNKNOWN step_id on the activity → NEEDS_HUMAN (never APPROVED)", async () => {
    const verdict = await run(
      evaluateEligibility({
        activity: VERIFY_ACTIVITY,
        stepId: "step_does_not_exist",
        identity: IDENTITY,
        submissionId: "sub-4",
        traceId: "trace-4",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.status).not.toBe("APPROVED");
    expect(verdict.status).toBe("NEEDS_HUMAN");
  });

  it("a non-verify step shape → NEEDS_HUMAN (default-deny, no verifier wired)", async () => {
    // Build an activity whose single step is a non-verify verification method.
    const denyActivity = {
      ...VERIFY_ACTIVITY,
      steps: [onChainStep],
    } as unknown as Activity;
    const verdict = await run(
      evaluateEligibility({
        activity: denyActivity,
        stepId: "step_onchain",
        identity: IDENTITY,
        submissionId: "sub-5",
        traceId: "trace-5",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.status).not.toBe("APPROVED");
    expect(verdict.status).toBe("NEEDS_HUMAN");
  });

  it("a non-verify ManualCurator step → NEEDS_HUMAN (refusal becomes a deny)", async () => {
    const denyActivity = {
      ...VERIFY_ACTIVITY,
      steps: [otherCuratorStep],
    } as unknown as Activity;
    const verdict = await run(
      evaluateEligibility({
        activity: denyActivity,
        stepId: "step_other",
        identity: IDENTITY,
        submissionId: "sub-6",
        traceId: "trace-6",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    expect(verdict.status).not.toBe("APPROVED");
    expect(verdict.status).toBe("NEEDS_HUMAN");
  });

  it("every deny verdict is a schema-valid SubstrateStepVerdict (F-002)", async () => {
    const verdict = await run(
      evaluateEligibility({
        activity: VERIFY_ACTIVITY,
        stepId: "nope",
        identity: IDENTITY,
        submissionId: "sub-7",
        traceId: "trace-7",
        gradedAtProvider: FIXED_GRADED_AT,
      }),
    );
    const decoded = Schema.decodeUnknownEither(SubstrateStepVerdict)(verdict);
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("resolveStep finds the verify step and returns null for an unknown id", () => {
    expect(resolveStep(VERIFY_ACTIVITY, "step_verify")?.step_id).toBe("step_verify");
    expect(resolveStep(VERIFY_ACTIVITY, "missing")).toBeNull();
  });
});
