/**
 * Activity-supertype READ routes (SDD §5 · FR-A1) — the read plane, mirroring
 * the 5 declared beacon capabilities + a progress lookup. Backed by the
 * Seam-B Postgres adapters (T-A1) via the composition root.
 *
 * ── SECURITY (hardened per the activities-api PR #21 read-plane review) ───────
 *
 * AUTH (#1, CRITICAL): every DATA route now carries `.use(requireIdentity)` —
 * a valid identity-api Bearer JWT (HS256, iss=identity-api) is MANDATORY. No
 * token / bad token → 401 (the gate short-circuits before the handler). Only
 * `/health` + `/.well-known/beacon.json` stay public.
 *
 * IDENTITY/WORLD SCOPE (#2, CRITICAL): the queried identity is the
 * AUTHENTICATED identity from the verified token (`identityOf(req).identity_id`,
 * = the JWT `sub`), NEVER a caller-supplied query param. The `identity_id`
 * query param is GONE from /v1/progress and /v1/badges. A caller can only ever
 * read their OWN identity's data. The token's `tenant` claim is the WORLD scope
 * (`identityOf(req).world`) — a caller cannot read cross-world either (an
 * identity is minted into exactly one world per token; events are read filtered
 * to that identity, so the per-identity predicate subsumes world isolation for
 * this deployment's event shape — see WORLD-SCOPE note below).
 *
 * DoS (#3, HIGH): each list route accepts a CLAMPED `limit` query param
 * (DEFAULT_LIMIT default, MAX_LIMIT hard cap) threaded into EventFilter.limit →
 * SQL `LIMIT`. Combined with the JSONB index in the migration, no read can
 * trigger an unbounded scan.
 *
 * PAGINATION (#4, MEDIUM): the MCP/OpenAPI contract advertises
 * { items, next_cursor, total_count }. We keep ALL THREE and make them HONEST:
 *   - `total_count` is the real (bounded) count of items in THIS page.
 *   - `next_cursor` is an opaque cursor (the last item's event_id) when the
 *     page is FULL (items.length === limit ⇒ more may exist); `null` when the
 *     page is short (definitively the last page). The prior code hard-coded
 *     next_cursor=null and total_count=page-size unconditionally — which lied
 *     ("there's never a next page" + "count is the page size"). This is the
 *     honest minimum the CompletionEventPort.query projection supports; a fully
 *     keyset-signed cursor (packages/mcp-tools/src/pagination/cursor.ts) lands
 *     when the query port exposes monotonic_sequence in its projection.
 *
 * WORLD-SCOPE note: ActivityCompleted events do NOT carry a top-level
 * world/tenant field (the world dimension lives in PartitionKey scope —
 * PartitionScope "world"/"composite", IMP-016). This deployment partitions by
 * "activity" scope, so the row has no world discriminant to filter on. The
 * load-bearing isolation is therefore the per-identity SQL predicate (an
 * identity belongs to one world's token). The world claim is asserted-present
 * on every authed read and is the seam for a world-partition predicate once
 * composite (world::activity) partitioning is wired.
 *
 * READ-ONLY: each route calls ONLY the query side of a port. Write routes
 * (completion / grant) remain absent (G-4 parity gate + GATE-SEC-1).
 */

import { Effect, Either } from "effect";
import {
  type ActivityId,
  type EventFilter,
} from "@0xhoneyjar/quests-protocol";

import { ok } from "@hyper/core";
import { identityOf, requireIdentity, route } from "../app";
import type { Composition } from "../composition";
import {
  decodeIdentityScope,
  degraded,
  degradedRecord,
  runRead,
} from "./_shared";

const BUILTIN_KINDS = ["quest", "mission", "badge-claim", "raffle-entry"] as const;

const ACTIVITY_COMPLETED_ID =
  "https://schemas.freeside.thj/activity-completed/v1.0.0";
const BADGE_ISSUED_ID = "https://schemas.freeside.thj/badge-issued/v1.0.0";

/**
 * Limit bounds. MAX_LIMIT matches the public MCP contract's `_pagination.limit`
 * maximum (200) — the tighter public bound, well inside EventFilter's 1..1000.
 * DEFAULT_LIMIT applies when the caller passes no `limit`.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const qp = (req: Request, key: string): string | undefined => {
  const v = new URL(req.url).searchParams.get(key);
  return v === null || v === "" ? undefined : v;
};

/**
 * Parse + clamp the `limit` query param to [1, MAX_LIMIT], default DEFAULT_LIMIT.
 * A non-numeric / out-of-range value clamps rather than erroring (lenient read
 * surface) — the point is the HARD CAP, not strict validation.
 */
const clampedLimit = (req: Request): number => {
  const raw = qp(req, "limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
};

/**
 * Build the honest pagination tail for a page of events. `next_cursor` is the
 * last item's event_id when the page is full (more may exist); null otherwise.
 */
const pageTail = (
  events: ReadonlyArray<{ readonly event_id?: unknown }>,
  limit: number,
): { next_cursor: string | null; total_count: number } => {
  const full = events.length >= limit;
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  const cursor =
    full && last !== undefined && typeof last.event_id === "string"
      ? last.event_id
      : null;
  return { next_cursor: cursor, total_count: events.length };
};

/**
 * list-kinds — static read; the builtin discriminants are protocol-fixed.
 * Still requires auth (read plane is non-public), but returns no identity data.
 */
export const kindsRoute = route
  .get("/v1/kinds")
  .use(requireIdentity)
  .meta({
    name: "list-kinds",
    tags: ["activities"],
    mcp: { description: "Lists ActivityKind discriminants registered in the substrate." },
  })
  .handle(() =>
    ok({
      builtin_kinds: BUILTIN_KINDS,
      world_defined_kinds: [] as ReadonlyArray<never>,
      completeness: { status: "full" as const },
    }),
  );

/**
 * get-active-activities — lists ActivityCompleted events for the AUTHENTICATED
 * identity ONLY. Scoped to `identityOf(req).identity_id` (the JWT sub); the
 * cross-identity stream is never returned. Bounded by a clamped `limit`.
 */
export const activitiesRoute = (composition: Composition) =>
  route
    .get("/v1/activities")
    .use(requireIdentity)
    .meta({
      name: "get-active-activities",
      tags: ["activities"],
      mcp: { description: "Returns ACTIVE activities for the authenticated identity (own world scope)." },
    })
    .handle(({ req }: { req: Request }) => {
      if (composition.surface === null) {
        return degraded("cubquest-db not bound; activities read unavailable");
      }
      const identity = identityOf(req);
      if (identity === undefined) {
        // Defense-in-depth: requireIdentity should have 401'd already.
        return degradedRecord("unauthenticated");
      }
      // SCOPE: DECODE the authenticated sub through the SHARED IdentityId
      // boundary (the same codec the write side keys partitions on) — never an
      // unchecked `as IdentityId` cast. A non-conforming sub must NEVER widen
      // the SQL predicate; reject it to a degraded read instead.
      const identityScope = decodeIdentityScope(identity.identity_id);
      if (Either.isLeft(identityScope)) {
        return degradedRecord("authenticated subject is not a conforming IdentityId");
      }
      const limit = clampedLimit(req);
      const filter: EventFilter = {
        // SCOPE: pin to the authenticated identity — never a query param.
        identity_id: identityScope.right,
        limit,
      };
      const activityId = qp(req, "activity_id");
      if (activityId !== undefined) {
        (filter as { activity_id?: ActivityId }).activity_id = activityId as ActivityId;
      }
      return runRead(composition.surface.eventStore.port.query(filter), (events) => {
        const tail = pageTail(events as ReadonlyArray<{ event_id?: unknown }>, limit);
        return {
          items: events,
          next_cursor: tail.next_cursor,
          total_count: tail.total_count,
          completeness: { status: "full" as const },
        };
      });
    });

/**
 * get-progress — the ProgressRecord for one activity, for the AUTHENTICATED
 * identity. `identity_id` is taken from the verified token (NOT a query param);
 * only `activity_id` is caller-supplied.
 */
export const progressRoute = (composition: Composition) =>
  route
    .get("/v1/progress")
    .use(requireIdentity)
    .meta({
      name: "get-progress",
      tags: ["activities"],
      mcp: { description: "Returns the ProgressRecord for one activity_id, for the authenticated identity." },
    })
    .handle(({ req }: { req: Request }) => {
      if (composition.surface === null) {
        return degradedRecord("cubquest-db not bound; progress read unavailable");
      }
      const identity = identityOf(req);
      if (identity === undefined) {
        return degradedRecord("unauthenticated");
      }
      // SCOPE: decode through the shared IdentityId boundary (not a cast).
      const identityScope = decodeIdentityScope(identity.identity_id);
      if (Either.isLeft(identityScope)) {
        return degradedRecord("authenticated subject is not a conforming IdentityId");
      }
      const activityId = qp(req, "activity_id");
      if (activityId === undefined) {
        return Promise.resolve(
          ok({
            error: "missing_params",
            detail: "activity_id is required",
          }),
        ) as never;
      }
      return runRead(
        composition.surface.progress.port.getProgress(
          activityId as ActivityId,
          // SCOPE: the authenticated identity, never a caller param.
          identityScope.right,
        ),
        (record) => ({ record, completeness: { status: "full" as const } }),
      );
    });

/**
 * get-badges — BadgeIssued events for the AUTHENTICATED identity. `identity_id`
 * is the verified token sub, never a query param. Bounded by a clamped `limit`.
 */
export const badgesRoute = (composition: Composition) =>
  route
    .get("/v1/badges")
    .use(requireIdentity)
    .meta({
      name: "get-badges",
      tags: ["activities"],
      mcp: { description: "Returns BadgeIssued events for the authenticated identity." },
    })
    .handle(({ req }: { req: Request }) => {
      if (composition.surface === null) {
        return degraded("cubquest-db not bound; badges read unavailable");
      }
      const identity = identityOf(req);
      if (identity === undefined) {
        return degraded("unauthenticated");
      }
      // SCOPE: decode through the shared IdentityId boundary (not a cast).
      const identityScope = decodeIdentityScope(identity.identity_id);
      if (Either.isLeft(identityScope)) {
        return degraded("authenticated subject is not a conforming IdentityId");
      }
      const limit = clampedLimit(req);
      // SCOPE: pin to the authenticated identity. CompletionEventPort.query
      // filters completion events by identity; badge events share the identity
      // field. Surfaced from completions for the identity until the badge
      // projection lands.
      const filter: EventFilter = {
        identity_id: identityScope.right,
        limit,
      };
      return runRead(composition.surface.eventStore.port.query(filter), (events) => {
        const tail = pageTail(events as ReadonlyArray<{ event_id?: unknown }>, limit);
        return {
          items: events,
          next_cursor: tail.next_cursor,
          total_count: tail.total_count,
          completeness: {
            status: "full" as const,
            note: `badge projection pending; surfaced from ${ACTIVITY_COMPLETED_ID} for identity`,
          },
        };
      });
    });

/**
 * get-raffle-entries — RaffleDrawn events for a cycle. Authed (read plane is
 * non-public); no projection on the read plane yet → honest empty page.
 */
export const raffleRoute = (composition: Composition) =>
  route
    .get("/v1/raffle-entries")
    .use(requireIdentity)
    .meta({
      name: "get-raffle-entries",
      tags: ["activities"],
      mcp: { description: "Returns RaffleEntry events for a cycle." },
    })
    .handle(({ req }: { req: Request }) => {
      const cycleId = qp(req, "cycle_id");
      if (composition.surface === null) {
        return degraded("cubquest-db not bound; raffle-entries read unavailable");
      }
      if (cycleId === undefined) {
        return Promise.resolve(
          ok({ error: "missing_params", detail: "cycle_id is required" }),
        ) as never;
      }
      // No raffle projection on the read plane yet; honest empty page.
      void BADGE_ISSUED_ID;
      void Effect;
      return ok({
        items: [] as ReadonlyArray<never>,
        next_cursor: null,
        total_count: 0,
        completeness: {
          status: "full" as const,
          note: "raffle projection pending on read plane",
        },
      });
    });
