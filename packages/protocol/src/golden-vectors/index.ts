/**
 * Golden vectors (T1.11 · §5.7 · cycle acvp-modules-genesis · sprint-1).
 *
 * 21 frozen fixtures (3 per event type × 7 event types) that lock the
 * canonical preimage encoding + event_id hash for cross-runtime conformance.
 *
 * Each fixture binds a deterministic `input` event to:
 *   - `expected_event_id` — SHA-256 of the canonical preimage (CL-Event-3)
 *   - `expected_preimage_jcs` — RFC 8785 JCS encoding of the preimage
 *
 * Cross-runtime ports (Rust · Python · etc.) MUST reproduce these values
 * exactly. The TS reference implementation (`computeEventId` +
 * `canonicalizeJCS`) is the source-of-truth.
 *
 * Re-seeding (when adding new vectors or changing reference algorithm):
 *   bun run packages/protocol/src/golden-vectors/_seed.ts
 *
 * IMP-013 decimal edge cases are covered in the RewardPending vectors
 * (1 wei · 256-bit max).
 */

export { ACTIVITY_COMPLETED_VECTORS } from "./activity-completed.fixtures.js";
export { BADGE_ISSUED_VECTORS } from "./badge-issued.fixtures.js";
export { PROGRESS_ADVANCED_VECTORS } from "./progress-advanced.fixtures.js";
export { RAFFLE_DRAWN_VECTORS } from "./raffle-drawn.fixtures.js";
export { REWARD_FAILED_VECTORS } from "./reward-failed.fixtures.js";
export { REWARD_GRANTED_VECTORS } from "./reward-granted.fixtures.js";
export { REWARD_PENDING_VECTORS } from "./reward-pending.fixtures.js";
export type { GoldenVector } from "./types.js";

// B1 merkle + snapshot-signature golden vectors (§1.10.3 · S1.2 · CRITICAL-870).
export {
  B1_MERKLE_GOLDEN,
  B1_MERKLE_SINGLE_LEAF,
  B1_STAGING_REPLAY_SIGNATURE,
  B1_WRONG_SIGNER_PUBKEY,
  type Hex,
  KECCAK256_EMPTY,
  type MerkleGoldenLeaf,
  type MerkleSingleLeafGoldenVector,
  type MerkleSnapshotGoldenVector,
} from "./merkle.fixtures.js";
