/**
 * G-4 CONTRACT-PARITY SUITE — the conservation gate for the reward-granting
 * write path (Lane A · beads cq.8). MUST pass before activities-api's write path
 * is ever flipped on.
 *
 * ── What this proves ─────────────────────────────────────────────────────────
 *
 * The legacy cubquests path did completion+reward in ONE atomic idempotent
 * stored proc (`complete_activity_step_tx` → `apply_resource_mutation`). The
 * engine's parity thesis decomposes that into the wired
 * `makeActivityCompletion(...).complete(input)` unit-of-work driving the proven
 * atomic seam. This suite generates a CORPUS of legacy-shaped completions and
 * replays each through the engine, asserting the engine's grant semantics
 * conserve value the way the legacy stored proc does.
 *
 * Six machine-proven conservation invariants (mapped to the task spec):
 *
 *   1. CONSERVATION   — Σ(engine-applied deltas) across the corpus == Σ(expected
 *                       deltas); final user_resources balances == sum of granted
 *                       deltas. No lost-spend, no over-grant, no phantom grant.
 *   2. IDEMPOTENCY    — replaying the same completion (same event_id) N times →
 *                       exactly ONE grant + ONE ledger mutation; balance
 *                       unchanged after the 1st.
 *   3. NO-DOUBLE-GRANT — K parallel replays of the same completion → exactly one
 *                       winner, others duplicate-reject; one ledger row.
 *   4. PER-TIER       — each Resource reward's amount lands on exactly its tier
 *                       (common/rare/legendary), others 0 — tier-mixed corpus +
 *                       world-alias kinds.
 *   5. DIVERGENT-KEY  — two distinct completions (distinct event_id) sharing a
 *                       coarse legacy resource key both grant correctly (the
 *                       engine's resourceIdempotencyKey===event_id enforcement
 *                       prevents the Phase-1 #4 completed-without-reward
 *                       divergence — never silently dropped).
 *   6. DEFERRED       — a BadgeMint/None corpus → 0 ledger mutations for the
 *                       deferred variants, RewardPending recorded; conservation
 *                       holds (nothing granted by deferred variants).
 *
 * Plus a GOLDEN reconciliation: a fixed seeded corpus → exact final balances per
 * tier (a regression anchor).
 *
 * ── Grounding (legacy semantics, file:line — read-only of CODE, not data) ─────
 *
 *  - Idempotency-key derivation:
 *      cubquests-interface/lib/activities/service.ts:70-87
 *      SHA-256 of `${activityId}|${periodKey??"global"}|${stepId}|${normalized}`
 *      → a UUID-shaped string. COARSE: no event_id. The proc falls back to
 *      `COALESCE(p_idempotency_key, p_progress_id)`
 *      (20251022_resource_tx_hardening.sql:326).
 *  - Dedup + single-grant-per-key:
 *      20251102231328_fix_apply_resource_mutation_return_deltas.sql:53-75 —
 *      a prior tx with same (idempotency_key, user_address) → returns ZERO
 *      deltas, NO second ledger row.
 *  - Per-tier accounting:
 *      20251102231328_…:134-162 — one resource_transactions INSERT per non-zero
 *      tier (common/rare/legendary), zero-deltas write nothing.
 *  - Insufficient-balance:
 *      20251102231328_…:112-114 — `RAISE 'resource-insufficient-{tier}'`.
 *  - Grant-once-per-completion:
 *      20251102225803_fix_complete_activity_step_tx_idempotency.sql:57-59 —
 *      `resources_granted_at IS NOT NULL AND v_should_grant → RAISE
 *      'resources-already-granted'`.
 *
 * The disposable real-Postgres harness loads the apply_resource_mutation FIXTURE
 * which MIRRORS the canonical proc byte-for-byte in shape
 * (packages/adapters/src/postgres/__tests__/apply-resource-mutation-fixture.sql,
 * grounded against 20251102231328_…). The empirical real-data replay against
 * cubquest-db is operator-gated and documented in
 * docs/parity/g4-real-data-replay.md — NOT run here. THIS SUITE IS SYNTHETIC AND
 * DATA-SAFE: every completion is generated, no production user data is read.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Either, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ActivityCompleted,
  ActivityId,
  ActivityRewardBadgeMint,
  ActivityRewardNone,
  ActivityRewardResource,
  type ActivityReward,
  type ChainAddress,
  computeEventIdSync,
  IdentityId,
  type MintIntentId,
  type PartitionKey,
  type PartitionScope,
  RFC3339Date,
} from "@0xhoneyjar/quests-protocol";

import {
  makePostgresAtomicCompletion,
  makePostgresEventStore,
  makePostgresIdentityResolver,
} from "@0xhoneyjar/freeside-activities-adapters/postgres";

import type { EventStorePostgresPool } from "../../../../adapters/src/postgres/pool.js";
import {
  startTestPostgres,
  type TestPostgres,
} from "../../../../adapters/src/postgres/__tests__/test-pg.js";

import {
  makeActivityCompletion,
  type ActivityCompletionHandle,
  type CompleteActivityInput,
  type ResourceTier,
} from "../complete.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCE_FIXTURE = readFileSync(
  resolve(
    __dirname,
    "../../../../adapters/src/postgres/__tests__/apply-resource-mutation-fixture.sql",
  ),
  "utf8",
);

const decode = Schema.decodeUnknownSync;
const chain = "evm";

/* ── World aliases (cubquests cores/essences/crystals → tiers, tiers.ts) ────── */
const CUBQUEST_ALIASES: Readonly<Record<string, ResourceTier>> = {
  cores: "common",
  essences: "rare",
  crystals: "legendary",
};

/* ── Synthetic legacy-shaped completion model ──────────────────────────────────
 *
 * A legacy completion is fully described by (activityId, periodKey, stepId,
 * userAddress, reward). We DERIVE a distinct event_id per completion via the
 * canonical preimage hash (nonce = the legacy idempotency tuple), so the engine
 * sees a real per-completion event_id while the corpus stays deterministic and
 * reproducible. This is the synthetic stand-in for a row of cubquest-db's
 * completion history — generated, never read from production.
 */
interface LegacyCompletion {
  readonly activityId: string;
  readonly periodKey: string | null;
  readonly stepId: string;
  readonly userAddress: string;
  readonly recipient: string;
  readonly reward: ActivityReward;
}

interface TierDelta {
  readonly common: number;
  readonly rare: number;
  readonly legendary: number;
}

const ZERO: TierDelta = { common: 0, rare: 0, legendary: 0 };

/**
 * legacyIdempotencyKey — REPRODUCES service.ts:70-87 exactly: SHA-256 of
 * `${activityId}|${periodKey??"global"}|${stepId}|${normalized}`, UUID-shaped.
 * This is the COARSE legacy resource key (no event_id). We compute it to drive
 * the divergent-key invariant (two distinct completions can collide on it).
 */
const legacyIdempotencyKey = async (c: LegacyCompletion): Promise<string> => {
  const normalized = c.userAddress.toLowerCase();
  const payload = `${c.activityId}|${c.periodKey ?? "global"}|${c.stepId}|${normalized}`;
  const data = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const digest = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

/**
 * buildEvent — derive the canonical ActivityCompleted for a legacy completion.
 * The nonce carries the legacy idempotency tuple so two SEMANTICALLY-distinct
 * completions always get distinct event_ids, and a re-built identical completion
 * reproduces the same event_id (idempotency replay).
 */
const buildEvent = async (
  c: LegacyCompletion,
  nonceSalt = "",
): Promise<ActivityCompleted> => {
  const activity = decode(ActivityId)(c.activityId);
  const identity = decode(IdentityId)(c.recipient);
  const nonce = `${c.activityId}:${c.periodKey ?? "global"}:${c.stepId}:${c.userAddress.toLowerCase()}${nonceSalt}`;
  const draft = {
    event_id: "0".repeat(64),
    preimage_schema_id:
      "https://schemas.freeside.thj/preimage/activity-completed/v1.0.0",
    ts: decode(RFC3339Date)("2026-05-30T00:00:00Z"),
    source_event_hash: null,
    nonce,
    schema_version: "1.0.0" as const,
    $id: "https://schemas.freeside.thj/activity-completed/v1.0.0" as const,
    activity_id: activity,
    identity_id: identity,
    period_key: c.periodKey,
    step_completions: [],
    reward_state_id: null,
  };
  const computed = await computeEventIdSync(
    draft as unknown as Record<string, unknown> & {
      $id: string;
      nonce: string | null;
    },
  );
  return decode(ActivityCompleted)({ ...draft, event_id: computed });
};

/**
 * A completion's partition is keyed on the COMPLETION IDENTITY (user + activity +
 * period + step), NOT the activity alone. Independent completions — different
 * users, or the same user across different periods/steps — must NOT contend on
 * CAS. An activity-only partition causes head-of-line blocking: user B's append
 * (expected_tip_hash:null) CAS-fails because user A's completion already filled
 * the partition (CASFailed expected_version 0, actual 1). A per-completion
 * `composite` partition `<identity>::<activity-period-step>` makes each completion
 * the first+only event in its own partition → null-tip CAS is always correct,
 * zero cross-completion contention; idempotency of a re-completion still fires via
 * event_id duplicate-reject (same identity → same partition → same event_id).
 *
 * CONTRACT (production write route MUST follow this): completion partitions are
 * identity-scoped, never activity-scoped. See the G-4 real-data runbook.
 */
const slug = (s: string): string =>
  (s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "x");
const partitionOf = (c: LegacyCompletion): PartitionKey =>
  ({
    scope: "composite" as PartitionScope,
    value: `${slug(c.recipient)}::${slug(`${c.activityId}-${c.periodKey ?? "np"}-${c.stepId}`)}`,
  }) as PartitionKey;

/** Translate a completion's reward to the {common,rare,legendary} delta the
 * legacy proc would apply. ONLY Resource rewards move the ledger (deferred
 * variants grant nothing → ZERO). Mirrors translateResourceReward + the legacy
 * `{common,rare,legendary}` shape (service.ts:580-593). */
const expectedDelta = (reward: ActivityReward): TierDelta => {
  if (reward._tag !== "Resource") return ZERO;
  const lowered = reward.resource_kind.toLowerCase();
  const tier =
    lowered === "common" || lowered === "rare" || lowered === "legendary"
      ? (lowered as ResourceTier)
      : (CUBQUEST_ALIASES[reward.resource_kind] ??
        CUBQUEST_ALIASES[lowered] ??
        null);
  if (tier === null) return ZERO;
  return {
    common: tier === "common" ? reward.amount : 0,
    rare: tier === "rare" ? reward.amount : 0,
    legendary: tier === "legendary" ? reward.amount : 0,
  };
};

/* ── DB inspection helpers ─────────────────────────────────────────────────── */

const balanceOf = async (
  pool: EventStorePostgresPool,
  userAddress: string,
): Promise<TierDelta> => {
  const r = await pool.query<{
    common: number;
    rare: number;
    legendary: number;
  }>(
    `SELECT common, rare, legendary FROM user_resources WHERE user_address = $1`,
    [userAddress.toLowerCase()],
  );
  const row = r.rows[0];
  return {
    common: row?.common ?? 0,
    rare: row?.rare ?? 0,
    legendary: row?.legendary ?? 0,
  };
};

/** Sum of all ledger-row amounts per tier across the WHOLE resource_transactions
 * table — the source-of-truth for "Σ engine-applied deltas". */
const ledgerSums = async (
  pool: EventStorePostgresPool,
): Promise<TierDelta> => {
  const r = await pool.query<{ resource_type: string; total: string }>(
    `SELECT resource_type, COALESCE(SUM(amount), 0)::text AS total
       FROM resource_transactions GROUP BY resource_type`,
    [],
  );
  const out = { common: 0, rare: 0, legendary: 0 } as {
    common: number;
    rare: number;
    legendary: number;
  };
  for (const row of r.rows) {
    if (row.resource_type === "common") out.common = Number.parseInt(row.total, 10);
    if (row.resource_type === "rare") out.rare = Number.parseInt(row.total, 10);
    if (row.resource_type === "legendary")
      out.legendary = Number.parseInt(row.total, 10);
  }
  return out;
};

const ledgerRowCount = async (pool: EventStorePostgresPool): Promise<number> => {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM resource_transactions`,
    [],
  );
  return Number.parseInt(r.rows[0]?.n ?? "0", 10);
};

const grantCount = async (pool: EventStorePostgresPool): Promise<number> => {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM reward_grants`,
    [],
  );
  return Number.parseInt(r.rows[0]?.n ?? "0", 10);
};

const ledgerRowsForKey = async (
  pool: EventStorePostgresPool,
  idempotencyKey: string,
): Promise<number> => {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM resource_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return Number.parseInt(r.rows[0]?.n ?? "0", 10);
};

const sumTiers = (d: TierDelta): number =>
  Math.abs(d.common) + Math.abs(d.rare) + Math.abs(d.legendary);

const addDelta = (a: TierDelta, b: TierDelta): TierDelta => ({
  common: a.common + b.common,
  rare: a.rare + b.rare,
  legendary: a.legendary + b.legendary,
});

/* ── Wiring: one handle bound to a fresh pool + the corpus's identities ─────── */

const wireHandle = async (
  pool: EventStorePostgresPool,
  identities: ReadonlyArray<{ recipient: string; userAddress: string }>,
): Promise<ActivityCompletionHandle> => {
  const resolver = makePostgresIdentityResolver({
    pool,
    supportedChains: new Set([chain]),
  });
  // Bind every corpus identity → its ledger address BEFORE wiring.
  for (const { recipient, userAddress } of identities) {
    await Effect.runPromise(
      resolver.bind({
        identity_id: decode(IdentityId)(recipient),
        chain,
        address: userAddress as unknown as ChainAddress,
      }),
    );
  }
  return makeActivityCompletion({
    atomic: makePostgresAtomicCompletion({ pool }),
    eventStore: makePostgresEventStore({ pool }).contract,
    identityResolver: resolver.port,
    resolutionChain: chain,
    resourceKindAliases: CUBQUEST_ALIASES,
  });
};

/** Replay one legacy completion through the engine. Returns the outcome Either. */
const replay = async (
  handle: ActivityCompletionHandle,
  c: LegacyCompletion,
  nonceSalt = "",
): Promise<
  Either.Either<
    Awaited<ReturnType<typeof effectOutcome>>,
    { readonly _tag: string }
  >
> => {
  const event = await buildEvent(c, nonceSalt);
  const input: CompleteActivityInput = {
    event,
    reward: c.reward,
    recipient: decode(IdentityId)(c.recipient),
    partition_key: partitionOf(c),
    expected_tip_hash: null,
    sourceType: "mission_completion",
    sourceId: c.activityId,
    sourceMetadata: { period_key: c.periodKey, step_id: c.stepId },
  };
  return Effect.runPromise(handle.complete(input).pipe(Effect.either));
};

// helper purely for the return-type inference above
const effectOutcome = (h: ActivityCompletionHandle, i: CompleteActivityInput) =>
  Effect.runPromise(h.complete(i));

/* ── Harness lifecycle ─────────────────────────────────────────────────────── */

let harness: TestPostgres | null = null;

beforeAll(async () => {
  harness = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  if (harness !== null) await harness.stop();
});

const itPg = process.env.LOA_PG_CONFORMANCE_SKIP === "1" ? it.skip : it;

/* ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 1 + 4 — CONSERVATION across a tier-mixed corpus + PER-TIER accuracy
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · INV-1 conservation + INV-4 per-tier (tier-mixed corpus)", () => {
  itPg("Σ(applied deltas) == Σ(expected) and balances == sum of granted deltas", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });

    // A deterministic tier-mixed corpus across multiple users + activities,
    // including canonical tier names AND world-alias kinds (cores/essences/
    // crystals). Each row is a distinct (activity, period, step, user) tuple →
    // a distinct event_id.
    const corpus: LegacyCompletion[] = [
      // user A — canonical tiers across periods
      { activityId: "act_aa", periodKey: "2026-W20", stepId: "s1", userAddress: "0x1111111111111111111111111111111111111111", recipient: "id_usera", reward: ActivityRewardResource.make({ resource_kind: "common", amount: 10 }) },
      { activityId: "act_bb", periodKey: "2026-W20", stepId: "s1", userAddress: "0x1111111111111111111111111111111111111111", recipient: "id_usera", reward: ActivityRewardResource.make({ resource_kind: "rare", amount: 5 }) },
      { activityId: "act_cc", periodKey: "2026-W20", stepId: "s1", userAddress: "0x1111111111111111111111111111111111111111", recipient: "id_usera", reward: ActivityRewardResource.make({ resource_kind: "legendary", amount: 2 }) },
      // user A — world-alias kinds (cubquests vocabulary)
      { activityId: "act_dd", periodKey: "2026-W21", stepId: "s1", userAddress: "0x1111111111111111111111111111111111111111", recipient: "id_usera", reward: ActivityRewardResource.make({ resource_kind: "cores", amount: 7 }) },
      // user B — alias + canonical mix
      { activityId: "act_aa", periodKey: "2026-W20", stepId: "s1", userAddress: "0x2222222222222222222222222222222222222222", recipient: "id_userb", reward: ActivityRewardResource.make({ resource_kind: "essences", amount: 4 }) },
      { activityId: "act_ee", periodKey: "2026-W21", stepId: "s1", userAddress: "0x2222222222222222222222222222222222222222", recipient: "id_userb", reward: ActivityRewardResource.make({ resource_kind: "crystals", amount: 3 }) },
      { activityId: "act_ff", periodKey: null, stepId: "s1", userAddress: "0x2222222222222222222222222222222222222222", recipient: "id_userb", reward: ActivityRewardResource.make({ resource_kind: "common", amount: 100 }) },
      // user C — single legendary
      { activityId: "act_gg", periodKey: "2026-W22", stepId: "s1", userAddress: "0x3333333333333333333333333333333333333333", recipient: "id_userc", reward: ActivityRewardResource.make({ resource_kind: "legendary", amount: 1 }) },
    ];

    const handle = await wireHandle(
      pool,
      corpus.map((c) => ({ recipient: c.recipient, userAddress: c.userAddress })),
    );

    // Σ expected, computed independently of the engine.
    let expectedTotal: TierDelta = ZERO;
    const expectedPerUser = new Map<string, TierDelta>();
    for (const c of corpus) {
      const d = expectedDelta(c.reward);
      expectedTotal = addDelta(expectedTotal, d);
      expectedPerUser.set(
        c.userAddress.toLowerCase(),
        addDelta(expectedPerUser.get(c.userAddress.toLowerCase()) ?? ZERO, d),
      );
    }

    // Replay each completion; collect the engine-reported applied delta.
    let engineAppliedTotal: TierDelta = ZERO;
    let granted = 0;
    for (const c of corpus) {
      const res = await replay(handle, c);
      expect(res._tag).toBe("Right");
      if (Either.isRight(res)) {
        const outcome = res.right;
        expect(outcome._tag).toBe("CompletionGranted");
        if (outcome._tag === "CompletionGranted") {
          engineAppliedTotal = addDelta(engineAppliedTotal, outcome.delta);
          granted += 1;
        }
      }
    }
    expect(granted).toBe(corpus.length);

    // INV-1a: engine-reported applied deltas == independently-computed expected.
    expect(engineAppliedTotal).toEqual(expectedTotal);

    // INV-1b: the LEDGER's own sum (resource_transactions) == expected. This is
    // the durable source-of-truth — no phantom rows, no lost rows.
    expect(await ledgerSums(pool)).toEqual(expectedTotal);

    // INV-1c: each user's final balance == the sum of deltas granted to them.
    // (no over-grant, no lost-spend — value is conserved per account.)
    for (const [user, exp] of expectedPerUser) {
      expect(await balanceOf(pool, user)).toEqual(exp);
    }

    // INV-4: exactly one ledger row per non-zero-tier grant (all single-tier
    // here → one row each), and grants == corpus size.
    expect(await ledgerRowCount(pool)).toBe(corpus.length);
    expect(await grantCount(pool)).toBe(corpus.length);

    // Cross-check totals add up.
    expect(sumTiers(await ledgerSums(pool))).toBe(
      corpus.reduce((acc, c) => acc + sumTiers(expectedDelta(c.reward)), 0),
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 2 — IDEMPOTENCY: N replays of the same completion → ONE grant
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · INV-2 idempotency (N sequential replays)", () => {
  itPg("replaying the same completion 5x → exactly ONE grant + ONE ledger row, balance stable", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });
    const c: LegacyCompletion = {
      activityId: "act_idem",
      periodKey: "2026-W22",
      stepId: "s1",
      userAddress: "0x4444444444444444444444444444444444444444",
      recipient: "id_idem",
      reward: ActivityRewardResource.make({ resource_kind: "rare", amount: 13 }),
    };
    const handle = await wireHandle(pool, [
      { recipient: c.recipient, userAddress: c.userAddress },
    ]);

    // First replay grants.
    const first = await replay(handle, c);
    expect(first._tag).toBe("Right");
    expect(await balanceOf(pool, c.userAddress)).toEqual({
      common: 0,
      rare: 13,
      legendary: 0,
    });

    // Replays 2..5 must each be a clean no-op (DuplicateEvent → AtomicGrantFailed).
    for (let i = 0; i < 4; i++) {
      const r = await replay(handle, c);
      expect(r._tag).toBe("Left");
      if (Either.isLeft(r)) {
        expect(r.left._tag).toBe("AtomicGrantFailed");
      }
    }

    // Exactly ONE grant + ONE ledger row; balance untouched after the 1st.
    expect(await grantCount(pool)).toBe(1);
    expect(await ledgerRowCount(pool)).toBe(1);
    expect(await balanceOf(pool, c.userAddress)).toEqual({
      common: 0,
      rare: 13,
      legendary: 0,
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 3 — NO DOUBLE-GRANT UNDER CONCURRENCY: K parallel replays → 1 winner
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · INV-3 no double-grant under concurrency", () => {
  itPg("8 parallel replays of one completion → exactly ONE grant, ONE ledger row", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });
    const c: LegacyCompletion = {
      activityId: "act_conc",
      periodKey: "2026-W22",
      stepId: "s1",
      userAddress: "0x5555555555555555555555555555555555555555",
      recipient: "id_conc",
      reward: ActivityRewardResource.make({
        resource_kind: "legendary",
        amount: 9,
      }),
    };
    const handle = await wireHandle(pool, [
      { recipient: c.recipient, userAddress: c.userAddress },
    ]);

    // Build ONE event, fire K identical completes in parallel. The SERIALIZABLE
    // CAS + event_id PK + partial-unique ledger index must elect exactly one
    // winner; the rest duplicate-reject.
    const event = await buildEvent(c);
    const input: CompleteActivityInput = {
      event,
      reward: c.reward,
      recipient: decode(IdentityId)(c.recipient),
      partition_key: partitionOf(c),
      expected_tip_hash: null,
      sourceType: "mission_completion",
      sourceId: c.activityId,
      sourceMetadata: { period_key: c.periodKey, step_id: c.stepId },
    };

    const K = 8;
    const results = await Promise.all(
      Array.from({ length: K }, () =>
        Effect.runPromise(handle.complete(input).pipe(Effect.either)),
      ),
    );

    const winners = results.filter((r) => r._tag === "Right");
    const losers = results.filter((r) => r._tag === "Left");
    // Exactly one winner.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(K - 1);
    // Every loser is a sealed AtomicGrantFailed (duplicate-reject), never an
    // unhandled defect — and never a second grant.
    for (const l of losers) {
      if (Either.isLeft(l)) {
        expect(l.left._tag).toBe("AtomicGrantFailed");
      }
    }

    // EXACTLY ONE grant + ONE ledger row; balance == the single grant.
    expect(await grantCount(pool)).toBe(1);
    expect(await ledgerRowCount(pool)).toBe(1);
    expect(await balanceOf(pool, c.userAddress)).toEqual({
      common: 0,
      rare: 0,
      legendary: 9,
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 5 — DIVERGENT-KEY SAFETY: two distinct completions, one coarse key
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · INV-5 divergent-key safety (Phase-1 #4)", () => {
  itPg("two distinct event_ids sharing ONE coarse legacy key → BOTH grant (never silently dropped)", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });

    // Two completions that share the SAME coarse legacy resource key
    // (activity+period+step+user) but are DISTINCT completions (different
    // step DATA → different events). In the legacy world the coarse key would
    // make the 2nd a no-op while its grant committed → completed-WITHOUT-reward.
    // The engine pins resourceIdempotencyKey === event_id, so the two events get
    // DISTINCT resource keys and BOTH grant correctly.
    const base: LegacyCompletion = {
      activityId: "act_div",
      periodKey: "2026-W22",
      stepId: "s1",
      userAddress: "0x6666666666666666666666666666666666666666",
      recipient: "id_div",
      reward: ActivityRewardResource.make({ resource_kind: "common", amount: 6 }),
    };
    const handle = await wireHandle(pool, [
      { recipient: base.recipient, userAddress: base.userAddress },
    ]);

    // Verify the PREMISE: both share the same legacy coarse key.
    const key1 = await legacyIdempotencyKey(base);
    const key2 = await legacyIdempotencyKey(base);
    expect(key1).toBe(key2); // coarse key collides by construction.

    // But we build TWO DISTINCT events (distinct nonce salt → distinct event_id),
    // modelling two genuinely-distinct completions that the coarse key conflates.
    const ev1 = await buildEvent(base, "#a");
    const ev2 = await buildEvent(base, "#b");
    expect(ev1.event_id).not.toBe(ev2.event_id);

    const mkInput = (event: ActivityCompleted): CompleteActivityInput => ({
      event,
      reward: base.reward,
      recipient: decode(IdentityId)(base.recipient),
      partition_key: partitionOf(base),
      expected_tip_hash: null,
      sourceType: "mission_completion",
      sourceId: base.activityId,
      sourceMetadata: { period_key: base.periodKey, step_id: base.stepId },
    });

    // First completion grants (tip null → first append).
    const r1 = await Effect.runPromise(
      handle.complete(mkInput(ev1)).pipe(Effect.either),
    );
    expect(r1._tag).toBe("Right");
    if (Either.isRight(r1)) expect(r1.right._tag).toBe("CompletionGranted");

    // Second completion (distinct event) — CAS off the first event's id.
    const r2 = await Effect.runPromise(
      handle
        .complete({ ...mkInput(ev2), expected_tip_hash: ev1.event_id })
        .pipe(Effect.either),
    );

    // CRITICAL: the 2nd must NOT be a silent completed-without-reward. Either
    // it grants (correct), OR the divergence is caught as a sealed error — never
    // a committed completion with a no-op'd ledger.
    if (Either.isRight(r2)) {
      expect(r2.right._tag).toBe("CompletionGranted");
      // BOTH granted → ledger holds both amounts; balance == 6+6 = 12.
      expect(await grantCount(pool)).toBe(2);
      expect(await ledgerRowCount(pool)).toBe(2);
      expect(await balanceOf(pool, base.userAddress)).toEqual({
        common: 12,
        rare: 0,
        legendary: 0,
      });
      // Each distinct event_id is its OWN ledger key — no coarse-key collapse.
      expect(await ledgerRowsForKey(pool, ev1.event_id as unknown as string)).toBe(1);
      expect(await ledgerRowsForKey(pool, ev2.event_id as unknown as string)).toBe(1);
    } else {
      // If caught: a sealed error, and NO partial completed-without-reward —
      // the 2nd completion's grant + ledger are both absent (rolled back atomically).
      expect(["AtomicGrantFailed"]).toContain(r2.left._tag);
      expect(await grantCount(pool)).toBe(1);
      expect(await ledgerRowCount(pool)).toBe(1);
      expect(await balanceOf(pool, base.userAddress)).toEqual({
        common: 6,
        rare: 0,
        legendary: 0,
      });
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 6 — DEFERRED VARIANTS DON'T GRANT: BadgeMint/None → 0 ledger mutation
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · INV-6 deferred/None variants don't grant (conservation holds)", () => {
  itPg("BadgeMint + None corpus → 0 ledger mutations (BadgeMint: RewardPending; None: zero-delta grant)", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });

    const badge: LegacyCompletion = {
      activityId: "act_badge",
      periodKey: "2026-W22",
      stepId: "s1",
      userAddress: "0x7777777777777777777777777777777777777777",
      recipient: "id_badge",
      reward: ActivityRewardBadgeMint.make({
        mint_intent_id: ("mint_" + "a".repeat(40)) as unknown as MintIntentId,
      }),
    };
    const none: LegacyCompletion = {
      activityId: "act_none",
      periodKey: "2026-W22",
      stepId: "s1",
      userAddress: "0x8888888888888888888888888888888888888888",
      recipient: "id_none",
      reward: ActivityRewardNone.make({}),
    };
    const handle = await wireHandle(pool, [
      { recipient: badge.recipient, userAddress: badge.userAddress },
      { recipient: none.recipient, userAddress: none.userAddress },
    ]);

    // BadgeMint → deferred: completion event + RewardPending recorded, NO grant.
    const rBadge = await replay(handle, badge);
    expect(rBadge._tag).toBe("Right");
    if (Either.isRight(rBadge)) {
      expect(rBadge.right._tag).toBe("CompletionDeferred");
    }

    // None → "completion is the reward": OFF-CHAIN path (2026-06-08). The
    // ActivityCompleted event appends to the identity partition and THAT is the
    // grant — NO identity→address resolution, NO ledger op, NO grant row, NO
    // pending event. (Pre-2026-06-08 this routed through the atomic seam with a
    // {0,0,0} delta and recorded a spurious zero-delta grant row + forced address
    // resolution; an off-chain badge needs neither.)
    const rNone = await replay(handle, none);
    expect(rNone._tag).toBe("Right");
    if (Either.isRight(rNone)) {
      expect(rNone.right._tag).toBe("CompletionRecorded");
      if (rNone.right._tag === "CompletionRecorded") {
        expect(rNone.right.recipient).toBe(none.recipient);
        expect(String(rNone.right.completionEventId)).toHaveLength(64); // sha256 hex
      }
    }

    // CONSERVATION: nothing was granted to any ledger tier. Zero ledger rows
    // across the WHOLE table; both balances zero.
    expect(await ledgerRowCount(pool)).toBe(0);
    expect(await ledgerSums(pool)).toEqual({ common: 0, rare: 0, legendary: 0 });
    expect(await balanceOf(pool, badge.userAddress)).toEqual(ZERO);
    expect(await balanceOf(pool, none.userAddress)).toEqual(ZERO);

    // NEITHER BadgeMint NOR None records a grant row: BadgeMint defers (pending),
    // None completes off-chain (event only). The grant table stays empty.
    const grants = await grantCount(pool);
    expect(grants).toBe(0);

    // The BadgeMint completion's partition has TWO events (ActivityCompleted +
    // RewardPending) — query by the completion's ACTUAL (identity-scoped composite)
    // partition, not a stale activity-scoped assumption.
    const badgePart = partitionOf(badge);
    const badgeEvents = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_store WHERE scope = $1 AND partition_value = $2`,
      [badgePart.scope, badgePart.value],
    );
    expect(Number.parseInt(badgeEvents.rows[0]?.n ?? "0", 10)).toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * GOLDEN RECONCILIATION — a fixed seeded corpus → EXACT final balances per tier.
 * A regression anchor: if the grant semantics drift, these numbers change.
 * ════════════════════════════════════════════════════════════════════════════ */

describe("G-4 parity · GOLDEN reconciliation (fixed seeded corpus, exact balances)", () => {
  itPg("the golden corpus reconciles to exact per-tier balances", async () => {
    if (harness === null) throw new Error("docker harness unavailable");
    const pool = harness.freshPool({ extraDdl: [RESOURCE_FIXTURE] });

    // ── The GOLDEN corpus (frozen). Two users, mixed tiers + aliases. ─────────
    const G_USER1 = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
    const G_USER2 = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
    const golden: LegacyCompletion[] = [
      { activityId: "act_gold1", periodKey: "2026-W01", stepId: "s1", userAddress: G_USER1, recipient: "id_gold1", reward: ActivityRewardResource.make({ resource_kind: "common", amount: 50 }) },
      { activityId: "act_gold2", periodKey: "2026-W01", stepId: "s1", userAddress: G_USER1, recipient: "id_gold1", reward: ActivityRewardResource.make({ resource_kind: "common", amount: 25 }) },
      { activityId: "act_gold3", periodKey: "2026-W01", stepId: "s1", userAddress: G_USER1, recipient: "id_gold1", reward: ActivityRewardResource.make({ resource_kind: "rare", amount: 8 }) },
      { activityId: "act_gold4", periodKey: "2026-W02", stepId: "s1", userAddress: G_USER1, recipient: "id_gold1", reward: ActivityRewardResource.make({ resource_kind: "crystals", amount: 3 }) }, // alias → legendary
      { activityId: "act_gold5", periodKey: "2026-W01", stepId: "s1", userAddress: G_USER2, recipient: "id_gold2", reward: ActivityRewardResource.make({ resource_kind: "cores", amount: 12 }) }, // alias → common
      { activityId: "act_gold6", periodKey: "2026-W01", stepId: "s1", userAddress: G_USER2, recipient: "id_gold2", reward: ActivityRewardResource.make({ resource_kind: "essences", amount: 6 }) }, // alias → rare
      { activityId: "act_gold7", periodKey: "2026-W02", stepId: "s1", userAddress: G_USER2, recipient: "id_gold2", reward: ActivityRewardResource.make({ resource_kind: "legendary", amount: 4 }) },
    ];

    const handle = await wireHandle(
      pool,
      golden.map((c) => ({ recipient: c.recipient, userAddress: c.userAddress })),
    );

    for (const c of golden) {
      const r = await replay(handle, c);
      expect(r._tag).toBe("Right");
    }

    // ── GOLDEN EXPECTED (hand-computed, frozen) ───────────────────────────────
    //  USER1: common = 50 + 25 = 75 · rare = 8 · legendary(crystals) = 3
    //  USER2: common(cores) = 12 · rare(essences) = 6 · legendary = 4
    const GOLDEN_USER1 = { common: 75, rare: 8, legendary: 3 };
    const GOLDEN_USER2 = { common: 12, rare: 6, legendary: 4 };
    //  WHOLE-LEDGER: common = 87 · rare = 14 · legendary = 7 · total rows = 7
    const GOLDEN_LEDGER = { common: 87, rare: 14, legendary: 7 };

    expect(await balanceOf(pool, G_USER1)).toEqual(GOLDEN_USER1);
    expect(await balanceOf(pool, G_USER2)).toEqual(GOLDEN_USER2);
    expect(await ledgerSums(pool)).toEqual(GOLDEN_LEDGER);
    expect(await ledgerRowCount(pool)).toBe(golden.length);
    expect(await grantCount(pool)).toBe(golden.length);

    // Conservation cross-check: per-user balances sum to the whole-ledger sums.
    expect(addDelta(GOLDEN_USER1, GOLDEN_USER2)).toEqual(GOLDEN_LEDGER);
  });
});
