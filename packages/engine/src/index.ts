/**
 * @0xhoneyjar/quests-engine — headless quest engine.
 *
 * Cycle-1 (2026-05-03) lands the substrate-step dispatch bridging
 * (Plane-3 gateway/listener logic).
 *
 * Cycle-Q (2026-05-04) lands the quest UI substrate engine layer:
 *   - Pure transition functions (`accept` · `submit` · `judge` · `finalize`)
 *     and the `transitions` aggregate
 *   - `QuestStatePort` Tag + cross-pack identity contract
 *   - Three persistence adapters:
 *       · QuestStatePortMemoryLayer  · dev/test default
 *       · QuestStatePortPostgresLayer · production default (per-world DBs)
 *       · QuestStatePortSubstrateRuntimeLayer · post-#157 stub
 *
 * Sprint-4 (2026-05-04 · this surface) lands:
 *   - AuthCheckPort (anon-allowed default · sietch-stub Layer placeholder)
 *   - BadgeIssuancePort (null-badge default · asset-pipeline-stub Layer)
 *   - EngineConfig (3-mode questAcceptanceMode enum · per-world slug)
 *   - End-to-end stub-quest integration test composing all 3 default ports
 */

// ---------------------------------------------------------------------------
// Cycle-1 (substrate-step dispatch · 2026-05-03)
// ---------------------------------------------------------------------------

export {
  dispatchEssayQuest,
  dispatchAndResolve,
  resolveVerdict,
  DispatchError,
  type EssayGraderInput,
  type EssayGraderOutput,
  type ResolutionHandlers,
} from "./dispatch.js";

// ---------------------------------------------------------------------------
// Cycle-Q (quest UI substrate engine · 2026-05-04 · SDD §4)
// ---------------------------------------------------------------------------

// State machine (§4.1) — pure transitions
export {
  accept,
  submit,
  judge,
  finalize,
  transitions,
  systemClock,
  type Clock,
} from "./quest-state-machine.js";

// Persistence port + Tag identity (§4.2)
export {
  QuestStatePort,
  QUEST_STATE_PORT_TAG_IDENTITY,
} from "./persistence/port.js";

// Persistence adapters (§4.2)
export {
  QuestStatePortMemoryLayer,
  composeKey,
} from "./persistence/adapters/memory.js";
export {
  QuestStatePortPostgresLayer,
  type PostgresAdapterConfig,
  type QuestStatePostgresPool,
  type QueryResultRow,
} from "./persistence/adapters/postgres.js";
export { QuestStatePortSubstrateRuntimeLayer } from "./persistence/adapters/substrate-runtime.js";

// ---------------------------------------------------------------------------
// Cycle-Q · sprint-4 SEAMS — Auth + Badge ports + EngineConfig (§4.3 · §4.4 · §4.5)
// ---------------------------------------------------------------------------

// AuthCheckPort (§4.3) — gates badge issuance per PRD D4
export {
  AuthCheckPort,
  AuthCheckPortAnonLayer,
  AUTH_CHECK_PORT_TAG_IDENTITY,
  type AuthCheck,
  type VerifyError,
  type VerifyErrorCode,
} from "./auth/index.js";
export { AuthCheckPortSietchStubLayer } from "./auth/sietch-stub.js";

// AuthCheckPort Sietch (cycle-B sprint-1 B-1.9) — verified-path adapter
// flips the stub Layer to a real JWT-verifying Layer. Per-interaction
// composition · honors A2 Tag identity · I6 tenant assertion enforced.
export {
  buildAuthCheckPortSietchLayer,
  TenantAssertionError,
  SietchInfrastructureError,
  type JWTVerifierPort,
  type SietchLayerInput,
  type VerifyResult,
} from "./auth/sietch.js";

// BadgeIssuancePort (§4.4) — produces BadgeArtifact for APPROVED verdicts
export {
  BadgeIssuancePort,
  BadgeIssuancePortNullLayer,
  BADGE_ISSUANCE_PORT_TAG_IDENTITY,
} from "./badge/index.js";
export { BadgeIssuancePortAssetPipelineStubLayer } from "./badge/asset-pipeline-stub.js";

// BadgeIssuancePort static-URI adapter (VB.2) — third Layer option:
// resolves a stable CDN BadgeArtifact from a static badgeId→uri map. The
// artifact payoff for the verify-badge first consumer. Additive — Null +
// asset-pipeline-stub Layers untouched; same Tag identity.
export {
  BadgeIssuancePortStaticLayer,
  STATIC_BADGE_REGISTRY,
  resolveStaticBadge,
  type StaticBadgeDescriptor,
} from "./badge/static-uri.js";

// Badge read projection (C4 · S1.6) — the read plane's badge surface. Projects
// the event stream (BadgeIssued + ActivityCompleted) into a deduplicated,
// art-resolved EarnedBadge[]. Consumed by the activities-api read routes.
export {
  projectEarnedBadges,
  type EarnedBadge,
} from "./badge/badge-projection.js";

// EngineConfig (§4.5) — per-world quest engine configuration
export {
  EngineConfig,
  QuestAcceptanceMode,
  SubmissionStyle,
  defaultEngineConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// acvp-modules-genesis · sprint-2 (2026-05-16)
// Activity substrate engine surface (SDD §3.5)
// ---------------------------------------------------------------------------

export * from "./activities/index.js";
