/**
 * merkle-membership-verifier tests (S1.4 · GATE-SEC-1).
 *
 * Exercises the grader against the §1.10 golden vector (`B1_MERKLE_GOLDEN`) and
 * the real B1 activity's MerkleProof step:
 *   - happy path: every snapshot member → APPROVED (attributed to the named grader)
 *   - every failure class denies (NO APPROVED is ever invented):
 *     wrong step · snapshot/step mismatch · unknown signer · env mismatch ·
 *     bad signature · non-member wallet · tampered proof.
 *
 * S1.4 · 2026-06-08 · mibera-badge-surface.
 */

import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

import {
  B1_DONATION_RAFFLE_ACTIVITY,
  B1_MERKLE_GOLDEN,
  B1_STAGING_REPLAY_SIGNATURE as B1_MERKLE_GOLDEN_STAGING_SIG,
  B1_WRONG_SIGNER_PUBKEY as B1_WRONG_PUBKEY,
  VERIFY_ACTIVITY,
} from "@0xhoneyjar/quests-protocol";

import type { Hex } from "../badge/merkle.js";
import type { SnapshotSigContext } from "../badge/snapshot-sig.js";
import {
  MERKLE_MEMBERSHIP_GRADER_SLUG,
  type OperatorPubkeys,
  type ResolvedSnapshot,
  isMerkleStep,
  merkleMembershipVerifier,
} from "./merkle-membership-verifier.js";

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
const snapshot: ResolvedSnapshot = { context: ctx, rootSignature: g.root_signature };
const operatorPubkeys: OperatorPubkeys = { [g.signer_key_id]: g.signer_pubkey };

const merkleStep = B1_DONATION_RAFFLE_ACTIVITY.steps[0]!; // MerkleProof, bound to the golden snapshot
const verifyStep = VERIFY_ACTIVITY.steps[0]!; // ManualCurator (an unowned step)

const identity = { identity_id: "id_recipient001", world: "mibera" } as const;

const run = (overrides: Partial<Parameters<typeof merkleMembershipVerifier>[0]>) =>
  Effect.runSync(
    Effect.either(
      merkleMembershipVerifier({
        identity,
        step: merkleStep,
        wallet: g.leaves[0]!.wallet,
        snapshot,
        proof: g.leaves[0]!.proof,
        operatorPubkeys,
        environmentId: "production",
        submissionId: "sub_1",
        traceId: "trace_1",
        gradedAtProvider: () => "2026-06-08T00:00:00Z",
        ...overrides,
      }),
    ),
  );

describe("isMerkleStep", () => {
  it("recognizes a MerkleProof step and rejects a ManualCurator step", () => {
    expect(isMerkleStep(merkleStep)).toBe(true);
    expect(isMerkleStep(verifyStep)).toBe(false);
  });
});

describe("merkleMembershipVerifier — happy path (every snapshot member)", () => {
  for (const leaf of g.leaves) {
    it(`APPROVES wallet ${leaf.wallet}`, () => {
      const result = run({ wallet: leaf.wallet, proof: leaf.proof });
      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.status).toBe("APPROVED");
        expect(result.right.confidence).toBe(1);
        expect(result.right.graderConstructSlug).toBe(MERKLE_MEMBERSHIP_GRADER_SLUG);
      }
    });
  }
});

describe("merkleMembershipVerifier — failure classes (MUST deny, never APPROVE)", () => {
  const denies = (label: string, overrides: Partial<Parameters<typeof merkleMembershipVerifier>[0]>) =>
    it(label, () => {
      const result = run(overrides);
      expect(Either.isLeft(result)).toBe(true);
    });

  denies("wrong step (ManualCurator)", { step: verifyStep });

  denies("snapshot/step mismatch (snapshot for a different snapshot_id)", {
    snapshot: {
      ...snapshot,
      context: { ...ctx, snapshotId: "snap_othersnapshot" },
    },
  });

  denies("unknown signer key (empty rotation set)", { operatorPubkeys: {} });

  denies("environment mismatch (runtime=staging, snapshot=production)", {
    environmentId: "staging",
  });

  denies("bad signature (staging-signed replay presented as production)", {
    snapshot: { ...snapshot, rootSignature: B1_MERKLE_GOLDEN_STAGING_SIG },
  });

  denies("non-member wallet (valid proof, wrong leaf)", {
    wallet: "0x000000000000000000000000000000000000dead",
  });

  denies("tampered proof element", {
    proof: [
      ("0x" + "f".repeat(64)) as Hex,
      ...g.leaves[0]!.proof.slice(1),
    ],
  });

  denies("wrong pubkey for the signer (verifies false)", {
    operatorPubkeys: { [g.signer_key_id]: B1_WRONG_PUBKEY },
  });
});
