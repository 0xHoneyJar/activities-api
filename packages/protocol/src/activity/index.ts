/**
 * Activity substrate exports for the freeside-activities protocol.
 *
 * Sealed-schema authorities (FR-1 + FR-2 · architectural lock A1):
 *   - Activity              — the supertype struct (FR-1)
 *   - ActivityKind          — the sealed TaggedEnum with WorldDefined seam (FR-2)
 *   - ActivityLifecycleState - the 5-state lifecycle (DEFINED→ACTIVE→...) (CL-Activity-4)
 *   - ActivityStep          - minimal scaffold (T1.5 lands the full schema)
 *   - ActivityReward        - minimal scaffold (T1.6 lands the full sealed-enum)
 *
 * Namespace-governance helpers (D19 · §9.1):
 *   - WorldDefinedKindId    — substrate-validated `<world_id>:<kind>` shape
 *   - WorldSubSchemaId      — URI shape for world-supplied sub_schema_id
 *   - RESERVED_KIND_PREFIXES - prefixes the substrate reserves for itself
 */

export {
  Activity,
  ActivityLifecycleState,
} from "./Activity.js";
export {
  ActivityKind,
  RESERVED_KIND_PREFIXES,
  WorldDefinedKindId,
  WorldSubSchemaId,
} from "./ActivityKind.js";
export {
  ActivityReward,
  ActivityRewardBadgeMint,
  ActivityRewardCosmetic,
  ActivityRewardExternal,
  ActivityRewardNone,
  ActivityRewardResource,
  ActivityRewardTokenAmount,
  RewardFailed,
  RewardGranted,
  RewardPending,
  RewardState,
} from "./ActivityReward.js";
export {
  ActivityStep,
  OnChainVmKind,
  StepCompletion,
  VerificationManualCurator,
  VerificationMerkleProof,
  VerificationMethod,
  VerificationOnChainEvent,
  VerificationPartnerApi,
  VerificationSignedMemoTx,
  VerificationWebhookHmac,
} from "./ActivityStep.js";

// verify Activity fixture (VB.1) — the `verify` activity authored as DATA
// (Quest · one-time · reward None; artifact via engine BadgeIssuancePort).
// A typed constant, NOT a catalog — activities-api is purely event-sourced.
//
// F-003 (GATE-SEC-1): only the decoded, branded VERIFY_ACTIVITY (+ its id) is
// re-exported. The raw pre-decode object is deliberately NOT surfaced here so
// no caller can build a completion off the unvalidated shape.
export {
  VERIFY_ACTIVITY,
  VERIFY_ACTIVITY_ID,
} from "./fixtures/verify-activity.js";
