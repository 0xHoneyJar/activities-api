/**
 * Activities substrate engine surface (sprint-2 · SDD §3.5).
 *
 * Exposed:
 *   - Port Tag identities (T2.6 · cross-pack via A2)
 *   - Default Effect Layer composing in-memory adapters
 *   - Activity lifecycle state machine (T2.7)
 *   - Reward retry orchestrator (T2.8)
 */

// Port Tags + identities
export {
  ACTIVITY_PORT_TAG_IDENTITIES,
  COMPLETION_EVENT_PORT_TAG_IDENTITY,
  CompletionEventPortTag,
  IDENTITY_RESOLVER_PORT_TAG_IDENTITY,
  IdentityResolverPortTag,
  PROGRESS_PORT_TAG_IDENTITY,
  ProgressPortTag,
  REWARD_PORT_TAG_IDENTITY,
  RewardPortTag,
} from "./ports.js";

// Composition
export {
  buildDefaultActivitiesLayer,
  type ActivitiesLayerHandles,
  type DefaultActivitiesLayerConfig,
} from "./compose.js";

// Lifecycle
export {
  advance,
  InvalidTransition,
  isTerminal,
  legalTransitionsFrom,
  TerminalState,
  type LifecycleError,
} from "./lifecycle.js";

// Retry
export {
  retryGrant,
  RetriesExhausted,
  TerminalGrantFailure,
  type RetryError,
  type RetryPolicy,
} from "./retry.js";

// Wired completion unit-of-work (T-A2.5 · cq.16 — the write-path wire)
export {
  makeActivityCompletion,
  resolveResourceTier,
  translateResourceReward,
  CompletionGranted,
  CompletionDeferred,
  UnknownResourceKind,
  IdentityResolutionFailed,
  AtomicGrantFailed,
  DeferredRecordingFailed,
  type ActivityCompletionConfig,
  type ActivityCompletionHandle,
  type CompleteActivityInput,
  type CompletionError,
  type CompletionOutcome,
  type ResourceTier,
} from "./complete.js";

// Verify→APPROVED verdict binding (VB.3 · GATE-SEC-1 — the verdict gate)
export {
  verifyIdentityProofVerifier,
  isVerifyStep,
  VerifyVerifierError,
  IDENTITY_PROOF_GRADER_SLUG,
  VERIFY_CURATOR_ID,
  type AuthenticatedIdentity,
} from "./verify-verifier.js";

export {
  evaluateEligibility,
  resolveStep,
  EligibilityError,
} from "./eligibility.js";
