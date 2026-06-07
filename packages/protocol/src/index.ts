/**
 * @0xhoneyjar/quests-protocol — sealed wire-format schemas for quest engagement.
 *
 * Cycle-1 (2026-05-03) lands the substrate-step submission/verdict pair —
 * the over-the-wire envelope for substrate-graded activity steps in
 * cubquests-interface (instance-N of the substrate-mental-model doctrine).
 *
 * Cycle-Q (2026-05-04) lands the quest entity + state + envelopes:
 *   - Quest, QuestId, NpcId, RubricPointer, BadgeSpec
 *   - QuestState, QuestPhase, PlayerIdentity, PlayerWallet, DiscordId
 *   - SubmissionEnvelope, ContextMessage, SubmissionId
 *   - QuestVerdict, VerdictStatus
 *   - BadgeArtifact, BadgeURI
 *   - tagged errors (QuestNotFoundError · InvalidPhaseTransitionError ·
 *     StateDecodeError · PersistenceError · NotImplementedError)
 *
 * Future cycles will land:
 *   - quest-completion event schema (Kafka envelope)
 *   - webhook payload schema
 *   - additional branded types (BadgeId, CompletionEventId, PartnerSlug)
 */

// ---------------------------------------------------------------------------
// Cycle-1 (substrate-step ABI · 2026-05-03)
// ---------------------------------------------------------------------------

export {
  SubstrateStepPayload,
  SubstrateStepSubmission,
  SubstrateStepVerdict,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  // Re-exported as `SubstrateStepVerdictStatus` to disambiguate from Cycle-Q's
  // `VerdictStatus` (they share shape today; namespace separation lets either
  // side evolve without breaking the other).
  VerdictStatus as SubstrateStepVerdictStatus,
} from "./substrate-step.js";

// ---------------------------------------------------------------------------
// Cycle-Q (quest UI substrate · 2026-05-04 · SDD §3)
// ---------------------------------------------------------------------------

// Quest entity (§3.1)
export {
  Quest,
  QuestId,
  NpcId,
  BadgeFamilyId,
  WorldSlug,
  RubricPointer,
  BadgeSpec,
  QUEST_CONTRACT_VERSION,
} from "./quest.js";

// Quest state (§3.2)
export {
  QuestState,
  QuestPhase,
  PlayerIdentity,
  PlayerWallet,
  DiscordId,
  VerdictSnapshot,
} from "./quest-state.js";

// Submission envelope (§3.3)
export {
  SubmissionEnvelope,
  SubmissionId,
  ContextMessage,
} from "./submission.js";

// Quest verdict (§3.4)
export { QuestVerdict, VerdictStatus } from "./quest-verdict.js";

// Badge artifact (§3.5)
export { BadgeArtifact, BadgeURI } from "./badge-artifact.js";

// Errors (§3.6)
export {
  QuestNotFoundError,
  InvalidPhaseTransitionError,
  StateDecodeError,
  PersistenceError,
  NotImplementedError,
} from "./errors.js";
export type { QuestEngineError } from "./errors.js";

// ---------------------------------------------------------------------------
// acvp-modules-genesis · Sprint 1 (2026-05-15)
// Activity substrate branded types (SDD §5.2 + §3.1)
// ---------------------------------------------------------------------------

export {
  ActivityId,
  CycleId,
  EventId,
  IdentityId,
  ISOWeek,
  MintIntentId,
  PartitionKey,
  PartitionScope,
  PartnerId,
  PeriodKey,
  SnapshotId,
  StepId,
  WorldDefinedKey,
  WorldId,
} from "./branded/index.js";

// Activity substrate (FR-1 + FR-2 + FR-3 · cycle acvp-modules-genesis · sprint-1)
export {
  Activity,
  ActivityKind,
  ActivityLifecycleState,
  ActivityReward,
  ActivityStep,
  OnChainVmKind,
  RESERVED_KIND_PREFIXES,
  StepCompletion,
  VerificationManualCurator,
  VerificationMerkleProof,
  VerificationMethod,
  VerificationOnChainEvent,
  VerificationPartnerApi,
  VerificationSignedMemoTx,
  VerificationWebhookHmac,
  WorldDefinedKindId,
  WorldSubSchemaId,
} from "./activity/index.js";

// verify Activity fixture (VB.1) — `verify` authored as DATA (Quest ·
// one-time · reward None). A typed constant; activities-api is event-sourced
// with no catalog surface — see verify-activity.ts header for the rationale.
//
// F-003 (GATE-SEC-1): the raw pre-decode `VERIFY_ACTIVITY_INPUT` is NO LONGER
// exported — only the decoded, branded VERIFY_ACTIVITY (+ its stable id) is
// importable, so a completion can never be built off the unvalidated shape.
export {
  VERIFY_ACTIVITY,
  VERIFY_ACTIVITY_ID,
} from "./activity/index.js";

// Canonical encoding helpers (T1.12 · D14 · §5.3 + §5.8)
export {
  bigintFromDecimal,
  bigintToDecimal,
  canonicalizeJCS,
  dateFromRFC3339,
  dateToRFC3339,
  DecimalValue,
  RFC3339Date,
  sha256JCS,
} from "./encoding/index.js";

// ActivityReward + RewardState (T1.6 · FR-4 · CL-Reward-1..3)
export {
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
} from "./activity/index.js";

// Forward-compat reward branded types
export { CosmeticId, TokenId } from "./branded/index.js";

// Typed ports + ProgressRecord + EventStoreContract (T1.13 + T1.14 + T1.15 · FR-8 + FR-11)
export {
  AppendOptions,
  ChainAddress,
  EventFilter,
  IdentityChainNotSupported,
  IdentityResolverError,
  IdentityResolverUnavailable,
  IdentityUnresolvableIdentity,
  ProgressActivityNotFound,
  ProgressAdapterUnavailable,
  ProgressConcurrentUpdate,
  ProgressError,
  ProgressIdentityNotFound,
  ProgressLifecycleState,
  ProgressRecord,
  RewardAdapterUnavailable,
  RewardAlreadyGranted,
  RewardError,
  RewardGrantFailed,
  RewardIdentityUnresolvable,
  TipDescriptor,
} from "./ports/index.js";
export type {
  CompletionEventPort,
  EventStoreContract,
  IdentityResolverPort,
  ProgressPort,
  RewardPort,
} from "./ports/index.js";

// Auth + pagination (T1.16 + T1.17 + T1.18 + T1.19 · Fix-A3/A4 + D22/D26)
export {
  AuditPermission,
  Cursor,
  CursorError,
  CursorPayload,
  ExpiredCursor,
  InvalidCursor,
  MCPBearerToken,
  MCPToolPermission,
  paginatedResponse,
  TOKEN_KEY_DISCOVERY_ENDPOINT,
  TOKEN_REPLAY_WINDOW_SECONDS,
  TOKEN_SKEW_TOLERANCE_SECONDS,
  WORLD_PAYLOAD_MAX_BYTES,
  WORLD_PAYLOAD_MAX_DEPTH,
  WorldDefinedPayload,
  WorldScope,
  WorldScopeAudit,
  WorldScopeMulti,
  WorldScopeSingle,
} from "./auth/index.js";

// Event-stream schemas + EventError + computeEventId (T1.7 + T1.9 + T1.10 · FR-5 + Fix-A1/A2)
export {
  ActivityCompleted,
  BadgeIssued,
  CanonicalizationFailed,
  CASFailed,
  computeEventId,
  computeEventIdSync,
  DuplicateEvent,
  EventEnvelope,
  EventError,
  EventStoreUnavailable,
  eventEnvelopeFields,
  isMutatingEvent,
  NonceCollision,
  NonceRequired,
  PartitionScopeMismatch,
  ProgressAdvanced,
  RaffleDrawn,
  RewardFailedEvent,
  RewardGrantedEvent,
  RewardPendingEvent,
  SchemaValidation,
} from "./events/index.js";

// Canonical preimage schemas (T1.8 · §5.6 · per CL-Event-3)
export {
  ActivityCompletedPreimage,
  BadgeIssuedPreimage,
  PreimageEnvelope,
  preimageEnvelopeFields,
  ProgressAdvancedPreimage,
  RaffleDrawnPreimage,
  RewardFailedPreimage,
  RewardGrantedPreimage,
  RewardPendingPreimage,
} from "./preimage/index.js";

// Auth port surfaces (S1.T1.16b + sprint-2 review C1/C2 — Fix-S4/Fix-S6/Fix-S7/IMP-005)
export {
  KeyExpired,
  KeyProviderUnavailable,
  KeyRevoked,
  KeyRotationState,
  KeyState,
  KidNotFound,
  ReplayStoreUnavailable,
} from "./auth-ports/index.js";
export type {
  AuthReplayStore,
  KeyProviderError,
  KeyProviderPort,
  RecordOutcome,
  ReplayStoreError,
} from "./auth-ports/index.js";
