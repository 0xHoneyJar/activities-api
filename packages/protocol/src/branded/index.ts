/**
 * Branded type registry for the freeside-activities protocol.
 *
 * Constructor discipline (architectural lock A1 · A2):
 *   - All identifiers cross the substrate boundary as branded strings.
 *   - Raw strings are rejected at every Schema decode boundary.
 *   - Brands are sealed at the protocol layer — adapters cannot mint new
 *     branded values without going through Effect.Schema.
 *
 * Pattern source-of-truth: SDD §5.2 + §3.1.
 */

export { ActivityId } from "./ActivityId.js";
export { CosmeticId } from "./CosmeticId.js";
export { CycleId } from "./CycleId.js";
export { EventId } from "./EventId.js";
export { IdentityId, spineUserIdToIdentityId } from "./IdentityId.js";
export { MintIntentId } from "./MintIntentId.js";
export { PartitionKey, PartitionScope } from "./PartitionKey.js";
export { PartnerId } from "./PartnerId.js";
export { ISOWeek, PeriodKey, WorldDefinedKey } from "./PeriodKey.js";
export { SnapshotId } from "./SnapshotId.js";
export { StepId } from "./StepId.js";
export { TokenId } from "./TokenId.js";
export { WorldId } from "./WorldId.js";
