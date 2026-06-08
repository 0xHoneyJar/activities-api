/**
 * The B1 `donation-raffle` Activity — authored as DATA (S1.3).
 *
 * Same fixture idiom as `./verify-activity.ts` (VB.1): a typed CONSTANT with a
 * stable id, decoded at module-load through the real sealed {@link Activity}
 * schema so it can never silently drift out of shape. activities-api is purely
 * event-sourced — there is no activity-catalog surface — so the B1 activity
 * lives here beside the golden vectors.
 *
 * It is a valid {@link Activity} value:
 *   - kind   = BadgeClaim   → a snapshot-eligibility claim. `period_key: null`
 *              at the kind level — the snapshot binding lives on the STEP's
 *              MerkleProof verification (where the grader reads it), not the kind.
 *   - steps  = one MerkleProof step bound to the B1 snapshot
 *              ({@link B1_DONATION_RAFFLE_SNAPSHOT_ID}) — the same snapshot_id the
 *              §1.10 golden vector and the S3 snapshot store bind.
 *   - reward = None         → off-chain-first: "completion IS the badge". The
 *              artifact resolves via the engine's BadgeIssuancePort
 *              (`STATIC_BADGE_REGISTRY["donation-raffle"]`), never a reward _tag.
 *              Graduates to BadgeMint when mint-api ships (NFR-4).
 *
 * The companion test (`./b1-donation-raffle-activity.test.ts`) decodes this
 * constant through the real schema AND cross-checks the step snapshot_id against
 * the golden vector — so the activity, the crypto, and the store can never drift
 * apart on the bound snapshot.
 *
 * S1.3 · 2026-06-08 · mibera-badge-surface.
 */

import { Schema } from "effect";

import { Activity } from "../Activity.js";

const ACTIVITY_SCHEMA_ID = "https://schemas.freeside.thj/activity/v1.0.0" as const;
const ACTIVITY_COMPLETED_SCHEMA_ID = "https://schemas.freeside.thj/activity-completed/v1.0.0";

/** Stable ActivityId for the B1 donation-raffle activity (`^act_[a-z0-9]+$`). */
export const B1_DONATION_RAFFLE_ACTIVITY_ID = "act_donationraffle";

/**
 * The B1 snapshot the MerkleProof step verifies against. MUST equal the
 * `snapshot_id` bound by the §1.10 golden vector (`B1_MERKLE_GOLDEN`) and the S3
 * snapshot store — the companion test asserts this. (`^snap_[a-z0-9]+$`.)
 */
export const B1_DONATION_RAFFLE_SNAPSHOT_ID = "snap_donationraffle2026q2";

/** The badge family this activity grants — the STATIC_BADGE_REGISTRY key. */
export const B1_DONATION_RAFFLE_FAMILY_ID = "donation-raffle";

/**
 * Raw (pre-decode) B1 Activity value. Kept as a plain object so the companion
 * test can feed it through `Schema.decodeUnknownSync(Activity)` and prove it
 * satisfies the sealed schema. Mirrors F-003 (GATE-SEC-1 hardening): this raw
 * shape is NOT re-exported across the package boundary — only the decoded,
 * branded {@link B1_DONATION_RAFFLE_ACTIVITY} is importable, so no caller can
 * construct a completion off the unvalidated pre-decode object.
 */
const __B1_DONATION_RAFFLE_ACTIVITY_INPUT_FOR_TEST = {
  id: B1_DONATION_RAFFLE_ACTIVITY_ID,
  // BadgeClaim = snapshot-eligibility claim. period_key null — the snapshot is
  // carried by the step's MerkleProof verification, not the kind.
  kind: { _tag: "BadgeClaim", period_key: null },
  period_key: null,
  steps: [
    {
      step_id: "step_donationclaim",
      description:
        "Claim the donation-raffle badge by proving membership in the operator-signed donation snapshot.",
      verification: { _tag: "MerkleProof", snapshot_id: B1_DONATION_RAFFLE_SNAPSHOT_ID },
      required: true,
      order: 0,
    },
  ],
  // None = completion IS the badge. The artifact is issued by the engine's
  // BadgeIssuancePort static adapter, NOT carried in the reward.
  reward: { _tag: "None" },
  reward_state_id: null,
  completion_event_schema: ACTIVITY_COMPLETED_SCHEMA_ID,
  // Wallet-eligibility, not world-bound at the activity level.
  world: null,
  schema_version: "1.0.0",
  lifecycle_state: "DEFINED",
  $id: ACTIVITY_SCHEMA_ID,
} as const;

/**
 * The decoded, branded B1 donation-raffle Activity. Decoding at module-load
 * throws if the shape ever drifts out of the sealed schema. Consumers import
 * this typed value.
 */
export const B1_DONATION_RAFFLE_ACTIVITY: Activity = Schema.decodeUnknownSync(Activity)(
  __B1_DONATION_RAFFLE_ACTIVITY_INPUT_FOR_TEST,
);

/**
 * Package-private re-export of the raw pre-decode shape, for the companion
 * fixture test ONLY (F-003). NOT re-exported from any barrel — do NOT add it to
 * one, that would re-open the F-003 surface.
 */
export { __B1_DONATION_RAFFLE_ACTIVITY_INPUT_FOR_TEST };
