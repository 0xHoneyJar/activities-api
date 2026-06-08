/**
 * B1 donation-raffle Activity fixture test (S1.3).
 *
 * Proves the hand-authored B1 Activity DATA decodes through the real sealed
 * `Activity` schema and carries the load-bearing contract:
 *   - BadgeClaim kind (snapshot-eligibility claim)
 *   - exactly one MerkleProof step bound to the B1 snapshot
 *   - reward None → "completion IS the badge" (off-chain-first)
 *   - ids honor the branded patterns (`^act_[a-z0-9]+$` / `^snap_[a-z0-9]+$`)
 *
 * AND the cross-check that ties the activity, the §1.10 crypto, and (eventually)
 * the S3 snapshot store to ONE snapshot_id — so they can never drift apart.
 *
 * S1.3 · 2026-06-08 · mibera-badge-surface.
 */

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { B1_MERKLE_GOLDEN } from "../../golden-vectors/merkle.fixtures.js";
import { Activity } from "../Activity.js";
import {
  B1_DONATION_RAFFLE_ACTIVITY,
  B1_DONATION_RAFFLE_ACTIVITY_ID,
  B1_DONATION_RAFFLE_FAMILY_ID,
  B1_DONATION_RAFFLE_SNAPSHOT_ID,
  __B1_DONATION_RAFFLE_ACTIVITY_INPUT_FOR_TEST,
} from "./b1-donation-raffle-activity.js";

describe("B1 donation-raffle Activity fixture (S1.3 · authored as data)", () => {
  it("decodes through the real Activity schema", () => {
    const result = Schema.decodeUnknownEither(Activity)(__B1_DONATION_RAFFLE_ACTIVITY_INPUT_FOR_TEST);
    expect(Either.isRight(result)).toBe(true);
  });

  it("exposes a pre-decoded, branded value with the stable id", () => {
    const reencoded = Schema.encodeSync(Activity)(B1_DONATION_RAFFLE_ACTIVITY);
    const redecoded = Schema.decodeUnknownSync(Activity)(reencoded);
    expect(redecoded.id).toBe(B1_DONATION_RAFFLE_ACTIVITY_ID);
  });

  it("ids honor the branded patterns (no separators after the prefix)", () => {
    expect(B1_DONATION_RAFFLE_ACTIVITY_ID).toMatch(/^act_[a-z0-9]+$/);
    expect(B1_DONATION_RAFFLE_SNAPSHOT_ID).toMatch(/^snap_[a-z0-9]+$/);
  });

  it("is a BadgeClaim kind (period_key null — snapshot lives on the step)", () => {
    expect(B1_DONATION_RAFFLE_ACTIVITY.kind._tag).toBe("BadgeClaim");
    expect(B1_DONATION_RAFFLE_ACTIVITY.period_key).toBeNull();
    expect(B1_DONATION_RAFFLE_ACTIVITY.kind).toMatchObject({ _tag: "BadgeClaim", period_key: null });
  });

  it("has exactly one MerkleProof step bound to the B1 snapshot", () => {
    expect(B1_DONATION_RAFFLE_ACTIVITY.steps).toHaveLength(1);
    const step = B1_DONATION_RAFFLE_ACTIVITY.steps[0]!;
    expect(step.required).toBe(true);
    expect(step.verification._tag).toBe("MerkleProof");
    expect(step.verification).toMatchObject({
      _tag: "MerkleProof",
      snapshot_id: B1_DONATION_RAFFLE_SNAPSHOT_ID,
    });
  });

  it("rewards None → completion IS the badge (artifact NOT in the reward _tag)", () => {
    expect(B1_DONATION_RAFFLE_ACTIVITY.reward._tag).toBe("None");
  });

  it("CROSS-CHECK: the step snapshot_id, activity_id, and family match the §1.10 golden vector", () => {
    // The single source of truth for the B1 crypto is B1_MERKLE_GOLDEN. The
    // activity that points at it MUST bind the SAME ids — otherwise the grader
    // would verify proofs against a snapshot the activity never references.
    expect(B1_DONATION_RAFFLE_SNAPSHOT_ID).toBe(B1_MERKLE_GOLDEN.snapshot_id);
    expect(B1_DONATION_RAFFLE_ACTIVITY_ID).toBe(B1_MERKLE_GOLDEN.activity_id);
    expect(B1_DONATION_RAFFLE_FAMILY_ID).toBe(B1_MERKLE_GOLDEN.badge_family_id);
  });
});
