/**
 * Activity completion unit-of-work — the wired write path (Lane A · T-A2.5 · cq.16).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The atomic seam `makePostgresAtomicCompletion(...).grantAndComplete(...)`
 * (packages/adapters/src/postgres/atomic-completion.ts) restores the legacy
 * stored proc's single-transaction atomicity for {CAS event-append →
 * reward_grants → apply_resource_mutation}. It is proven by the T-A2 crash-
 * injection + idempotency suites. But NO engine caller invoked it — the engine
 * shipped only the standalone lifecycle / retry / port surface, so a real
 * completion still had only the NAÏVE two-transaction append-then-grant.
 *
 * This file is the missing caller. It takes a completion, computes the canonical
 * `ActivityCompleted` event, dispatches on the {@link ActivityReward} tag, and:
 *
 *   - **Resource** → resolves recipient → userAddress via {@link IdentityResolverPort}
 *     BEFORE the txn opens (the seam must hold the txn open as briefly as
 *     possible — identity resolution may be a network call), translates the
 *     reward → {@link ResourceMutationDelta}, and calls `grantAndComplete` with
 *     `resourceIdempotencyKey = event_id` (the seam enforces this by default).
 *     The event-append + grant + ledger mutation become durable together, in
 *     ONE SERIALIZABLE transaction. Idempotent on replay (same event_id).
 *
 *   - **BadgeMint / TokenAmount / Cosmetic / External** → delivery is NOT yet
 *     wired (BadgeMint forwards to the future freeside-mint sibling; the others
 *     have no delivery seam at all). We DO NOT crash and we DO NOT report a
 *     false grant. Instead we append the `ActivityCompleted` event and record a
 *     {@link RewardPendingEvent} (the wire envelope around RewardState.Pending),
 *     then return a sealed {@link CompletionDeferred} outcome. The completion is
 *     durable; the reward is parked in Pending for a future delivery wave.
 *
 *   - **None** → "completion is the reward" (CL-Reward-1). Routed through the
 *     atomic seam with a `{0,0,0}` delta — the proc short-circuits (no ledger
 *     row) but the event appends and a grant row is still recorded.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * - NOT an HTTP write route. GATE-SEC-1 gates the network write surface; this is
 *   an INVOKABLE engine function (Effect) so Phase-3 can wire it behind whatever
 *   the gate requires. No express / fastify / route handler is added here.
 * - NOT a replacement for the standalone ports. The read path
 *   (CompletionEventPort.query, RewardPort.query) and the standalone seams stay
 *   intact and untouched.
 * - NOT a place that hardcodes "every reward is a Resource". The dispatch is on
 *   the reward `_tag`; the Resource branch is the only one with a wired delivery
 *   TODAY, and the design makes adding the BadgeMint delivery later a localized
 *   change (replace the deferred branch's body).
 */
import { Data, Effect } from "effect";

import {
  type ActivityCompleted,
  type ActivityReward,
  type ChainAddress,
  computeEventId,
  type EventEnvelope,
  type EventError,
  type EventId,
  type IdentityId,
  type IdentityResolverError,
  type IdentityResolverPort,
  type PartitionKey,
  type RewardGranted,
} from "@0xhoneyjar/quests-protocol";

import {
  type AtomicCompletionError,
  type PostgresAtomicCompletionHandle,
  type ResourceMutationDelta,
} from "@0xhoneyjar/freeside-activities-adapters/postgres";

import type { EventStoreContract } from "@0xhoneyjar/quests-protocol";

import type { Schema } from "effect";

type RewardGrantedRecord = Schema.Schema.Type<typeof RewardGranted>;

/**
 * The three canonical resource tiers backing the cubquest-db ledger
 * (`user_resources.{common,rare,legendary}` columns).
 *
 * GROUNDED: cubquests-interface/constants/resources/tiers.ts — the DATABASE
 * schema IS `common`/`rare`/`legendary`; the display names (Cores / Essences /
 * Crystals, or a world's own branding) are a presentation layer over these
 * three columns. cubquests-interface/lib/activities/service.ts:580-593 confirms
 * a completed activity's reward is stored tier-keyed as `{common,rare,legendary}`
 * and handed straight to `complete_activity_step_tx` as
 * `p_reward_{common,rare,legendary}` — there is no `resource_kind` string in the
 * legacy write path; the tier IS the kind.
 */
export type ResourceTier = "common" | "rare" | "legendary";

/**
 * resourceKindToTier — translate the protocol's world-defined `resource_kind`
 * string into a ledger tier.
 *
 * The ActivityRewardResource variant carries ONE `{ resource_kind, amount }`
 * (packages/protocol/src/activity/ActivityReward.ts). `resource_kind` is a
 * WORLD-DEFINED slug (`^[a-z][a-z0-9_-]{0,127}$`), so the substrate cannot
 * assume cubquests' vocabulary. Two resolution layers:
 *
 *   1. The canonical tier names (`common`/`rare`/`legendary`) map to themselves
 *      — a world MAY emit tier-keyed rewards directly (this is what cubquests'
 *      legacy ledger stores).
 *   2. A world MAY supply an `aliases` map for its own short-names
 *      (cubquests: `cores`→common, `essences`→rare, `crystals`→legendary,
 *      grounded in tiers.ts RESOURCE_SHORT_NAMES). Aliases are matched
 *      case-insensitively after the canonical check.
 *
 * An UNKNOWN kind returns null — the caller surfaces a sealed
 * {@link UnknownResourceKind} error rather than silently dropping the reward to
 * a `{0,0,0}` delta (which would commit a completed-WITHOUT-reward).
 */
const CANONICAL_TIERS: ReadonlySet<string> = new Set([
  "common",
  "rare",
  "legendary",
]);

export const resolveResourceTier = (
  resourceKind: string,
  aliases?: Readonly<Record<string, ResourceTier>>,
): ResourceTier | null => {
  const lowered = resourceKind.toLowerCase();
  if (CANONICAL_TIERS.has(lowered)) return lowered as ResourceTier;
  if (aliases !== undefined) {
    const direct = aliases[resourceKind] ?? aliases[lowered];
    if (direct !== undefined) return direct;
  }
  return null;
};

/**
 * translateResourceReward — map an `ActivityRewardResource` to the
 * `{common,rare,legendary}` delta the atomic seam applies via
 * apply_resource_mutation. The single resource tier receives `amount`; the other
 * two are zero. Returns null on an unknown `resource_kind`.
 */
export const translateResourceReward = (
  resourceKind: string,
  amount: number,
  aliases?: Readonly<Record<string, ResourceTier>>,
): ResourceMutationDelta | null => {
  const tier = resolveResourceTier(resourceKind, aliases);
  if (tier === null) return null;
  return {
    common: tier === "common" ? amount : 0,
    rare: tier === "rare" ? amount : 0,
    legendary: tier === "legendary" ? amount : 0,
  };
};

/* ── Outcomes (sealed) ─────────────────────────────────────────────────────── */

/**
 * CompletionGranted — a Resource (or None) reward whose delivery is wired: the
 * event appended, the grant recorded, and (for non-zero deltas) the ledger
 * mutated, all in ONE atomic transaction. Carries the RewardGranted record the
 * atomic seam returned.
 */
export class CompletionGranted extends Data.TaggedClass("CompletionGranted")<{
  readonly grant: RewardGrantedRecord;
  /** The resolved ledger address the grant landed on. */
  readonly userAddress: string;
  /** The delta actually applied (audit). */
  readonly delta: ResourceMutationDelta;
}> {}

/**
 * CompletionDeferred — a reward variant with NO wired delivery yet (BadgeMint /
 * TokenAmount / Cosmetic / External). The `ActivityCompleted` event is durable
 * and a RewardPendingEvent is recorded (delivery deferred). NOT a grant, NOT a
 * crash, NOT a silent success — an explicit "delivery-unwired" sealed outcome.
 */
export class CompletionDeferred extends Data.TaggedClass("CompletionDeferred")<{
  /** Tag of the reward variant whose delivery is not yet wired. */
  readonly rewardTag: ActivityReward["_tag"];
  /** event_id of the appended ActivityCompleted. */
  readonly completionEventId: EventId;
  /** event_id of the recorded RewardPendingEvent. */
  readonly pendingEventId: EventId;
  /** Human-readable reason the delivery is deferred. */
  readonly reason: string;
}> {}

/**
 * CompletionRecorded — an OFF-CHAIN completion (reward None / "completion is the
 * reward", CL-Reward-1). The `ActivityCompleted` event is appended to the
 * identity partition and THAT is the whole grant — no ledger mutation, no chain
 * address resolved, no RewardPendingEvent. This is the off-chain-first badge
 * path: a commemorative badge has no economic value, so it must NOT require the
 * recipient to be resolvable to a chain address (the identity resolver is for
 * ledger-addressed rewards only). The read plane surfaces it by querying the
 * partition's ActivityCompleted events — identical to how a granted badge reads.
 */
export class CompletionRecorded extends Data.TaggedClass("CompletionRecorded")<{
  /** event_id of the appended ActivityCompleted (the badge itself). */
  readonly completionEventId: EventId;
  /** The recipient the badge was recorded for (substrate-opaque identity). */
  readonly recipient: IdentityId;
}> {}

export type CompletionOutcome =
  | CompletionGranted
  | CompletionDeferred
  | CompletionRecorded;

/* ── Errors (sealed; never thrown) ─────────────────────────────────────────── */

/**
 * UnknownResourceKind — a Resource reward named a `resource_kind` the world's
 * translation can't map to a ledger tier. Surfaced (not silently zeroed) because
 * a `{0,0,0}` delta would commit a completed-WITHOUT-reward.
 */
export class UnknownResourceKind extends Data.TaggedError("UnknownResourceKind")<{
  readonly resource_kind: string;
  readonly reason: string;
}> {}

/**
 * IdentityResolutionFailed — the recipient could not be resolved to a ledger
 * address BEFORE the txn. Wraps the resolver's sealed error. No partial write
 * occurs (resolution runs before any event append).
 */
export class IdentityResolutionFailed extends Data.TaggedError(
  "IdentityResolutionFailed",
)<{
  readonly recipient: IdentityId;
  readonly chain: string;
  readonly cause: IdentityResolverError;
}> {}

/**
 * AtomicGrantFailed — the atomic seam returned a sealed AtomicCompletionError
 * (CAS failure, duplicate, resource-mutation failure, adapter-unavailable, …).
 * The transaction rolled back; no partial write.
 */
export class AtomicGrantFailed extends Data.TaggedError("AtomicGrantFailed")<{
  readonly cause: AtomicCompletionError;
}> {}

/**
 * DeferredRecordingFailed — appending the ActivityCompleted event OR recording
 * the RewardPendingEvent failed on the deferred (non-Resource) path. Wraps the
 * event-store error. The completion event MAY or MAY NOT be durable depending on
 * which append failed — the caller treats this as retryable (no value was
 * granted, so a retry is a clean duplicate-reject / re-record).
 */
export class DeferredRecordingFailed extends Data.TaggedError(
  "DeferredRecordingFailed",
)<{
  readonly stage: "append-completion" | "record-pending";
  readonly cause: EventError;
}> {}

export type CompletionError =
  | UnknownResourceKind
  | IdentityResolutionFailed
  | AtomicGrantFailed
  | DeferredRecordingFailed;

/* ── Input ─────────────────────────────────────────────────────────────────── */

export interface CompleteActivityInput {
  /**
   * The canonical ActivityCompleted event to append. Its `event_id` MUST be the
   * canonical hash (the atomic seam re-verifies via computeEventId by default).
   */
  readonly event: ActivityCompleted;
  /** The reward intent emitted by this completion (dispatched on its `_tag`). */
  readonly reward: ActivityReward;
  /** The grant recipient (substrate-opaque identity). */
  readonly recipient: IdentityId;
  /** Partition + CAS tip for the event append (same shape EventStore.append takes). */
  readonly partition_key: PartitionKey;
  readonly expected_tip_hash: EventId | null;
  /** source_type recorded on the ledger row (e.g. "mission_completion"). */
  readonly sourceType: string;
  /** Optional source_id (e.g. the activity_id) recorded on the ledger row. */
  readonly sourceId?: string;
  /**
   * Provenance merged into the ledger row metadata (mirrors legacy
   * `{ period_key, step_id }`). Forwarded verbatim to the seam.
   */
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
}

export interface ActivityCompletionConfig {
  /** The proven atomic seam (Resource + None delivery). */
  readonly atomic: PostgresAtomicCompletionHandle;
  /** Identity boundary — recipient → ledger address (A5). */
  readonly identityResolver: IdentityResolverPort;
  /**
   * Event-store seam for the DEFERRED (non-Resource) path: appends the
   * ActivityCompleted + the RewardPendingEvent. The Resource path does NOT use
   * this (the atomic seam appends inside its own txn).
   */
  readonly eventStore: EventStoreContract;
  /**
   * The chain the recipient is resolved on for ledger addressing. A
   * world-defined constant (e.g. cubquests' EVM chain). Default "evm".
   */
  readonly resolutionChain?: string;
  /**
   * World-defined `resource_kind` → tier aliases (e.g. cubquests
   * `cores`→common). Canonical tier names always resolve without an alias.
   */
  readonly resourceKindAliases?: Readonly<Record<string, ResourceTier>>;
  /** Injectable clock + nonce for the RewardPendingEvent (testability). */
  readonly timestampProvider?: () => string;
  readonly noncePrefix?: string;
}

export interface ActivityCompletionHandle {
  /**
   * complete — the wired completion unit-of-work. NEVER throws out of the
   * Effect: every failure mode is a sealed {@link CompletionError}; every
   * success is a sealed {@link CompletionOutcome}.
   */
  readonly complete: (
    input: CompleteActivityInput,
  ) => Effect.Effect<CompletionOutcome, CompletionError>;
}

const REWARD_PENDING_ID =
  "https://schemas.freeside.thj/reward-pending/v1.0.0" as const;
const REWARD_PENDING_PREIMAGE_ID =
  "https://schemas.freeside.thj/preimage/reward-pending/v1.0.0" as const;

/**
 * makeActivityCompletion — composition root for the wired completion path.
 *
 * Binds the atomic seam + identity resolver + event-store contract into a single
 * `complete(input)` Effect. World composition roots construct this once and call
 * it per completion.
 */
export const makeActivityCompletion = (
  config: ActivityCompletionConfig,
): ActivityCompletionHandle => {
  const {
    atomic,
    identityResolver,
    eventStore,
    resourceKindAliases,
  } = config;
  const resolutionChain = config.resolutionChain ?? "evm";
  const timestampProvider =
    config.timestampProvider ?? (() => new Date().toISOString());
  const noncePrefix = config.noncePrefix ?? "reward-pending";

  /**
   * The DEFERRED path: append the ActivityCompleted event, then record a
   * RewardPendingEvent on the SAME partition (chained off the completion). No
   * reward is delivered — delivery is parked in Pending for a future wave.
   */
  const deferredRecord = (
    input: CompleteActivityInput,
    reason: string,
  ): Effect.Effect<CompletionDeferred, CompletionError> =>
    Effect.gen(function* () {
      // 1. Append the completion event (CAS off the caller's expected tip).
      const completionTip = yield* eventStore
        .append(input.event as unknown as EventEnvelope, {
          partition_key: input.partition_key,
          expected_tip_hash: input.expected_tip_hash,
        })
        .pipe(
          Effect.mapError(
            (cause): CompletionError =>
              new DeferredRecordingFailed({ stage: "append-completion", cause }),
          ),
        );

      // 2. Build + append the RewardPendingEvent, chained off the completion
      //    (source_event_hash = completion event_id, CL-Reward-3). The pending
      //    event is non-mutating, so a null nonce is permitted — but we supply a
      //    deterministic nonce so two distinct completions never collide.
      const ts = timestampProvider();
      const nonce = `${noncePrefix}:${String(input.event.event_id)}`;
      const pendingPreimage = {
        $id: REWARD_PENDING_ID,
        preimage_schema_id: REWARD_PENDING_PREIMAGE_ID,
        ts,
        source_event_hash: input.event.event_id,
        nonce,
        schema_version: "1.0.0" as const,
        originating_event_id: input.event.event_id,
        recipient: input.recipient,
        reward_intent: input.reward,
        attempts: 0,
      };
      const pendingEventId = yield* computeEventId(
        pendingPreimage as unknown as Record<string, unknown> & {
          readonly $id: string;
          readonly nonce: string | null;
        },
      ).pipe(
        // RewardPendingEvent is non-mutating + carries a nonce, so this never
        // fails NonceRequired — but the EventError channel must still be mapped
        // into the sealed CompletionError union (the contract: never leak an
        // unmapped error). A canonicalization fault here is a record-pending
        // failure (the completion event is already durable; retry re-records).
        Effect.mapError(
          (cause): CompletionError =>
            new DeferredRecordingFailed({
              stage: "record-pending",
              cause: cause as EventError,
            }),
        ),
      );
      const pendingEvent = {
        ...pendingPreimage,
        event_id: pendingEventId,
      } as unknown as EventEnvelope;

      yield* eventStore
        .append(pendingEvent, {
          partition_key: input.partition_key,
          expected_tip_hash: completionTip.tip_event_id,
        })
        .pipe(
          Effect.mapError(
            (cause): CompletionError =>
              new DeferredRecordingFailed({ stage: "record-pending", cause }),
          ),
        );

      return new CompletionDeferred({
        rewardTag: input.reward._tag,
        completionEventId: input.event.event_id as unknown as EventId,
        pendingEventId: pendingEventId as unknown as EventId,
        reason,
      });
    });

  /**
   * The OFF-CHAIN path: append ONLY the ActivityCompleted event to the identity
   * partition. No identity→address resolution, no ledger mutation, no pending
   * event. For reward None ("completion is the reward", CL-Reward-1) — a
   * commemorative/off-chain badge whose value IS the durable completion event.
   *
   * A no-economic-value badge must NOT require the recipient to be resolvable to
   * a chain address (the identity resolver exists for ledger-addressed rewards;
   * forcing it here makes off-chain badges un-grantable for any identity not yet
   * bound to a chain address — see complete.ts §reward dispatch). The read plane
   * reads this back by querying the partition's ActivityCompleted events.
   */
  const completeOffChain = (
    input: CompleteActivityInput,
  ): Effect.Effect<CompletionRecorded, CompletionError> =>
    Effect.gen(function* () {
      yield* eventStore
        .append(input.event as unknown as EventEnvelope, {
          partition_key: input.partition_key,
          expected_tip_hash: input.expected_tip_hash,
        })
        .pipe(
          Effect.mapError(
            (cause): CompletionError =>
              new DeferredRecordingFailed({ stage: "append-completion", cause }),
          ),
        );
      return new CompletionRecorded({
        completionEventId: input.event.event_id as unknown as EventId,
        recipient: input.recipient,
      });
    });

  /**
   * The WIRED path: resolve recipient → ledger address (BEFORE the txn),
   * translate the reward → delta, call grantAndComplete atomically.
   */
  const grantResource = (
    input: CompleteActivityInput,
    delta: ResourceMutationDelta,
  ): Effect.Effect<CompletionGranted, CompletionError> =>
    Effect.gen(function* () {
      // Resolve identity BEFORE opening the txn (the seam holds the txn open as
      // briefly as possible; resolution may be a network call). A resolution
      // failure is sealed here → NO event is appended, NO partial write.
      const address: ChainAddress = yield* identityResolver
        .resolveToChainAddress(input.recipient, resolutionChain)
        .pipe(
          Effect.mapError(
            (cause): CompletionError =>
              new IdentityResolutionFailed({
                recipient: input.recipient,
                chain: resolutionChain,
                cause,
              }),
          ),
        );

      const grant = yield* atomic
        .grantAndComplete({
          event: input.event as unknown as EventEnvelope,
          partition_key: input.partition_key,
          expected_tip_hash: input.expected_tip_hash,
          reward: input.reward,
          recipient: input.recipient,
          userAddress: address as unknown as string,
          delta,
          // Phase-1 enforces resourceIdempotencyKey === event_id by default;
          // pin it so a retry of the same completion is a proc no-op.
          resourceIdempotencyKey: input.event.event_id as unknown as string,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceMetadata: input.sourceMetadata,
        })
        .pipe(
          Effect.mapError(
            (cause): CompletionError => new AtomicGrantFailed({ cause }),
          ),
        );

      return new CompletionGranted({
        grant,
        userAddress: address as unknown as string,
        delta,
      });
    });

  const complete = (
    input: CompleteActivityInput,
  ): Effect.Effect<CompletionOutcome, CompletionError> =>
    Effect.gen(function* () {
      const reward = input.reward;
      switch (reward._tag) {
        case "Resource": {
          // Translate world-defined resource_kind → ledger delta. Unknown kind
          // is a SEALED error (never a silent {0,0,0} → completed-without-reward).
          const delta = translateResourceReward(
            reward.resource_kind,
            reward.amount,
            resourceKindAliases,
          );
          if (delta === null) {
            return yield* Effect.fail(
              new UnknownResourceKind({
                resource_kind: reward.resource_kind,
                reason:
                  `resource_kind '${reward.resource_kind}' does not map to a ` +
                  "ledger tier (common/rare/legendary). Supply a world alias via " +
                  "ActivityCompletionConfig.resourceKindAliases, or emit a " +
                  "canonical tier name. Refusing to commit a completed-without-" +
                  "reward.",
              }),
            );
          }
          return yield* grantResource(input, delta);
        }
        case "None": {
          // "Completion is the reward" (CL-Reward-1) — an OFF-CHAIN badge. The
          // completion event IS the grant; there is no ledger delta to apply, so
          // there is nothing to address. Route through completeOffChain, which
          // appends the ActivityCompleted event and resolves NO chain address.
          //
          // (Pre-2026-06-08 this routed through grantResource with a zero delta,
          // which forced identity→address resolution for a no-value badge — so an
          // off-chain badge was un-grantable for any identity not bound to a chain
          // address. The zero-delta ledger op was a no-op anyway; the only effect
          // of the old path was the spurious resolution requirement.)
          return yield* completeOffChain(input);
        }
        case "BadgeMint":
          // Forwards to the future freeside-mint sibling — delivery NOT wired.
          return yield* deferredRecord(
            input,
            "BadgeMint delivery is not yet wired (forwards to the future " +
              "freeside-mint sibling). Completion recorded; reward parked Pending.",
          );
        case "TokenAmount":
          return yield* deferredRecord(
            input,
            "TokenAmount delivery is not yet wired (no on-chain token transfer " +
              "seam). Completion recorded; reward parked Pending.",
          );
        case "Cosmetic":
          return yield* deferredRecord(
            input,
            "Cosmetic delivery is not yet wired. Completion recorded; reward " +
              "parked Pending.",
          );
        case "External":
          return yield* deferredRecord(
            input,
            "External reward delivery is not yet wired (off-chain claim). " +
              "Completion recorded; reward parked Pending.",
          );
        default: {
          // Exhaustiveness guard: every ActivityReward variant is handled
          // above. If the sealed union grows a 7th variant, this fails to
          // compile (forcing a deliberate dispatch decision) rather than
          // silently falling through to a non-grant.
          const _exhaustive: never = reward;
          return _exhaustive;
        }
      }
    });

  return { complete };
};
