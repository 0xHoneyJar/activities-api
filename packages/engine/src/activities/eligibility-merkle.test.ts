/**
 * evaluateEligibility — MerkleProof arm integration (S1.4 · GATE-SEC-1).
 *
 * Proves the gate dispatches a MerkleProof step to the merkle-membership grader
 * and preserves default-deny:
 *   - valid bulk-grant context (snapshot + member proof) → APPROVED
 *   - NO bulk-grant context (interactive path) → NEEDS_HUMAN (deny)
 *   - bad proof / non-member → NEEDS_HUMAN (grader refusal mapped to deny)
 *   - the verify path is unaffected (regression)
 *
 * S1.4 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  B1_DONATION_RAFFLE_ACTIVITY,
  B1_MERKLE_GOLDEN,
  VERIFY_ACTIVITY,
} from "@0xhoneyjar/quests-protocol";

import type { Hex } from "../badge/merkle.js";
import type { SnapshotEnvironment, SnapshotSigContext } from "../badge/snapshot-sig.js";
import { evaluateEligibility } from "./eligibility.js";

const g = B1_MERKLE_GOLDEN;

const ctx: SnapshotSigContext = {
  snapshotId: g.snapshot_id,
  badgeFamilyId: g.badge_family_id,
  activityId: g.activity_id,
  environmentId: g.environment_id,
  merkleRoot: g.merkle_root,
  leafCount: g.leaf_count,
  createdAt: g.created_at,
  signerKeyId: g.signer_key_id,
};

const merkleStepId = B1_DONATION_RAFFLE_ACTIVITY.steps[0]!.step_id;
const identity = { identity_id: "id_recipient", world: "mibera" } as const;

const baseMerkleGrant = {
  wallet: g.leaves[0]!.wallet,
  snapshot: { context: ctx, rootSignature: g.root_signature },
  proof: g.leaves[0]!.proof,
  operatorPubkeys: { [g.signer_key_id]: g.signer_pubkey },
  environmentId: "production" as SnapshotEnvironment,
};

const evalMerkle = (
  merkleGrant: typeof baseMerkleGrant | undefined,
): { status: string; graderConstructSlug: string } =>
  Effect.runSync(
    evaluateEligibility({
      activity: B1_DONATION_RAFFLE_ACTIVITY,
      stepId: merkleStepId,
      identity,
      submissionId: "sub_1",
      traceId: "trace_1",
      gradedAtProvider: () => "2026-06-08T00:00:00Z",
      ...(merkleGrant !== undefined && { merkleGrant }),
    }),
  );

describe("evaluateEligibility — MerkleProof arm (S1.4)", () => {
  it("APPROVES a member with valid bulk-grant context (snapshot + proof)", () => {
    const v = evalMerkle(baseMerkleGrant);
    expect(v.status).toBe("APPROVED");
    expect(v.graderConstructSlug).toBe("merkle-membership");
  });

  it("DENIES a MerkleProof step with NO bulk-grant context (interactive path)", () => {
    const v = evalMerkle(undefined);
    expect(v.status).toBe("NEEDS_HUMAN");
  });

  it("DENIES a non-member wallet (grader refusal → deny, never a crash)", () => {
    const v = evalMerkle({ ...baseMerkleGrant, wallet: "0x000000000000000000000000000000000000dead" });
    expect(v.status).toBe("NEEDS_HUMAN");
  });

  it("DENIES a tampered proof", () => {
    const v = evalMerkle({
      ...baseMerkleGrant,
      proof: [("0x" + "f".repeat(64)) as Hex, ...g.leaves[0]!.proof.slice(1)],
    });
    expect(v.status).toBe("NEEDS_HUMAN");
  });

  it("DENIES when the runtime environment mismatches the snapshot", () => {
    const v = evalMerkle({ ...baseMerkleGrant, environmentId: "staging" });
    expect(v.status).toBe("NEEDS_HUMAN");
  });
});

describe("evaluateEligibility — verify path regression (S1.4 leaves it intact)", () => {
  it("still APPROVES the verify step with an authenticated identity", () => {
    const verifyStepId = VERIFY_ACTIVITY.steps[0]!.step_id;
    const v = Effect.runSync(
      evaluateEligibility({
        activity: VERIFY_ACTIVITY,
        stepId: verifyStepId,
        identity,
        submissionId: "sub_2",
        traceId: "trace_2",
        gradedAtProvider: () => "2026-06-08T00:00:00Z",
      }),
    );
    expect(v.status).toBe("APPROVED");
    expect(v.graderConstructSlug).toBe("identity-proof");
  });
});
