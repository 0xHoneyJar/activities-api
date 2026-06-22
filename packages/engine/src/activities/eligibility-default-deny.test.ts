/**
 * eligibility-evaluator — EXHAUSTIVE default-deny invariant (GATE-SEC-1 · OQ-4).
 *
 * ── THE INVARIANT THIS GUARDS ────────────────────────────────────────────────
 *
 * `evaluateEligibility` is the verdict gate that decouples reward-grant from
 * self-assertion (the hole the live CubQuests surface left open by
 * auto-completing `verificationType: "manual"` with no authoritative check).
 * Its load-bearing security property — stated in the file header — is:
 *
 *   "there is no input — known step, unknown step, missing verifier — for
 *    which this evaluator returns `status: APPROVED` other than a verify step
 *    backed by an authenticated identity [or a MerkleProof step with the
 *    bulk-grant context]. Default is deny."
 *
 * The existing suites prove the APPROVE paths (verify + merkle-with-context)
 * and a sample of denies (unknown step_id · a non-verify ManualCurator ·
 * OnChainEvent · merkle-without-context). But the `VerificationMethod` sealed
 * union has SIX variants, and three of them — SignedMemoTx · WebhookHmac ·
 * PartnerApi — had NO test asserting the gate default-denies them. A future
 * verifier branch (or a re-architected dispatch) that accidentally widened the
 * APPROVED surface to one of those shapes would not have been caught.
 *
 * This suite closes that gap: it enumerates EVERY `VerificationMethod` variant
 * (ActivityStep.ts) on the interactive path (no `merkleGrant` context) and
 * asserts that exactly ONE shape — `ManualCurator { curator_id: "verify" }` —
 * yields APPROVED, and EVERY other shape yields a non-APPROVED, schema-valid
 * verdict. The coverage tripwire (`REQUIRED_TAGS`) is grounded against the
 * `VerificationMethod["_tag"]` type, so it is real two ways: a 7th union variant
 * (CL-Step-1 requires an /architect cycle) breaks the `satisfies` at COMPILE
 * time, and a declared tag with no row in the `VARIANTS` table breaks the
 * runtime loop — either way, the gate decision for a new method must be an
 * explicit, reviewed choice rather than a silent fall-through.
 *
 * Pure Effect — no Postgres, no HTTP, no route. This is a Plane-2 invariant
 * test; the route-level "non-APPROVED cannot grant" regression lives in
 * apps/runtime/src/routes/__tests__/writes.test.ts.
 */

import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type Activity,
  type ActivityStep,
  PartnerId,
  SnapshotId,
  StepId,
  SubstrateStepVerdict,
  type VerificationMethod,
  VERIFY_ACTIVITY,
} from "@0xhoneyjar/quests-protocol";

import { evaluateEligibility } from "./eligibility.js";

const IDENTITY = { identity_id: "id_player001", world: "mibera" } as const;
const FIXED_GRADED_AT = () => "2026-06-22T12:00:00.000Z";

const stepId = (s: string) => Schema.decodeUnknownSync(StepId)(s);
const snapshotId = (s: string) => Schema.decodeUnknownSync(SnapshotId)(s);
const partnerId = (s: string) => Schema.decodeUnknownSync(PartnerId)(s);

/** A single-step activity whose only step uses the given verification method. */
const activityWithStep = (
  id: string,
  verification: VerificationMethod,
): { activity: Activity; stepIdStr: string } => {
  const baseStep = VERIFY_ACTIVITY.steps[0] as ActivityStep;
  const stepIdStr = id;
  const step: ActivityStep = {
    ...baseStep,
    step_id: stepId(stepIdStr),
    verification,
  };
  const activity = { ...VERIFY_ACTIVITY, steps: [step] } as unknown as Activity;
  return { activity, stepIdStr };
};

/**
 * The exhaustive enumeration of the 6 `VerificationMethod` variants
 * (ActivityStep.ts), each on the INTERACTIVE path (no bulk-grant context).
 * `expectApproved` is the gate's correct decision for that shape.
 *
 * Only `ManualCurator { curator_id: "verify" }` is an APPROVE — its approval is
 * DERIVED from the authenticated identity (the verify JWT), attributed to the
 * named `identity-proof` grader. Every other shape has no authoritative
 * verifier wired on the interactive path → default-deny (NEEDS_HUMAN).
 */
const VARIANTS: ReadonlyArray<{
  readonly name: string;
  readonly stepIdStr: string;
  readonly verification: VerificationMethod;
  readonly expectApproved: boolean;
}> = [
  {
    name: 'ManualCurator { curator_id: "verify" }',
    stepIdStr: "step_verify",
    verification: { _tag: "ManualCurator", curator_id: "verify" },
    expectApproved: true,
  },
  {
    name: 'ManualCurator { curator_id: "moderator" } (non-verify)',
    stepIdStr: "step_moderator",
    verification: { _tag: "ManualCurator", curator_id: "moderator" },
    expectApproved: false,
  },
  {
    name: "SignedMemoTx",
    stepIdStr: "step_signedmemo",
    verification: { _tag: "SignedMemoTx", chain: "berachain" },
    expectApproved: false,
  },
  {
    name: "MerkleProof (interactive path · no bulk-grant context)",
    stepIdStr: "step_merkle",
    verification: { _tag: "MerkleProof", snapshot_id: snapshotId("snap_test1") },
    expectApproved: false,
  },
  {
    name: "WebhookHmac",
    stepIdStr: "step_webhook",
    verification: {
      _tag: "WebhookHmac",
      source: "partner-x",
      secret_env: "HMAC_SECRET",
    },
    expectApproved: false,
  },
  {
    name: "PartnerApi",
    stepIdStr: "step_partner",
    verification: {
      _tag: "PartnerApi",
      partner_id: partnerId("partner-x"),
      endpoint: "https://partner.example/verify",
    },
    expectApproved: false,
  },
  {
    name: "OnChainEvent",
    stepIdStr: "step_onchain",
    verification: { _tag: "OnChainEvent", contract: "0xabc", event: "Minted", vm: "evm" },
    expectApproved: false,
  },
];

const evalVariant = (v: (typeof VARIANTS)[number]): SubstrateStepVerdict => {
  const { activity, stepIdStr } = activityWithStep(v.stepIdStr, v.verification);
  return Effect.runSync(
    evaluateEligibility({
      activity,
      stepId: stepIdStr,
      identity: IDENTITY,
      submissionId: `sub:${v.stepIdStr}`,
      traceId: `trace:${v.stepIdStr}`,
      gradedAtProvider: FIXED_GRADED_AT,
    }),
  );
};

/**
 * REQUIRED_TAGS — the coverage tripwire, grounded against the SOURCE type.
 *
 * `satisfies Record<VerificationMethod["_tag"], true>` makes this a COMPILE-time
 * mirror of the sealed union (ActivityStep.ts:85-94): add a 7th variant to
 * `VerificationMethod` and this object no longer satisfies the Record → tsc
 * fails until the new tag is listed here. The runtime loop below then fails
 * until that tag also has a row in `VARIANTS`. Both halves are needed because a
 * single ManualCurator tag carries TWO rows (verify→approve, moderator→deny),
 * so `VARIANTS` cannot be keyed by `_tag` directly (duplicate key) — the table
 * stays an array for `it.each`, and this map is the separate exhaustiveness key.
 */
const REQUIRED_TAGS = {
  ManualCurator: true,
  SignedMemoTx: true,
  MerkleProof: true,
  WebhookHmac: true,
  PartnerApi: true,
  OnChainEvent: true,
} satisfies Record<VerificationMethod["_tag"], true>;

describe("evaluateEligibility — exhaustive default-deny across all VerificationMethod variants (GATE-SEC-1 · OQ-4)", () => {
  it("covers EVERY VerificationMethod variant in the sealed union (no shape is untested)", () => {
    const covered = new Set(VARIANTS.map((v) => v.verification._tag));
    // Every tag the SOURCE type declares (REQUIRED_TAGS is compile-pinned to
    // VerificationMethod["_tag"]) must have at least one VARIANTS row. A new
    // union variant fails the `satisfies` at compile time; a declared tag with
    // no row fails here at runtime.
    for (const tag of Object.keys(REQUIRED_TAGS) as Array<
      VerificationMethod["_tag"]
    >) {
      expect(covered.has(tag)).toBe(true);
    }
  });

  it.each(VARIANTS)(
    "$name → expectApproved=$expectApproved (never an unintended APPROVE)",
    (v) => {
      const verdict = evalVariant(v);
      if (v.expectApproved) {
        expect(verdict.status).toBe("APPROVED");
      } else {
        // The core invariant: any unwired verification shape MUST NOT grant.
        expect(verdict.status).not.toBe("APPROVED");
        expect(verdict.status).toBe("NEEDS_HUMAN");
      }
      // F-002: every verdict the gate emits — approve OR deny — is a real,
      // schema-valid SubstrateStepVerdict (no untyped verdict escapes).
      const decoded = Schema.decodeUnknownEither(SubstrateStepVerdict)(verdict);
      expect(Either.isRight(decoded)).toBe(true);
    },
  );

  it("EXACTLY ONE variant is an APPROVE on the interactive path (the verify step)", () => {
    const approved = VARIANTS.filter((v) => evalVariant(v).status === "APPROVED");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.verification._tag).toBe("ManualCurator");
  });
});
