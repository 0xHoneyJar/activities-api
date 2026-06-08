/**
 * badge-projection — turn the event stream into a uniform `EarnedBadge[]` (C4 ·
 * S1.6). The read plane was serving raw `ActivityCompleted` events with a
 * "badge projection pending" note (`reads.ts`); this is that projection.
 *
 * Two event types contribute a badge:
 *   - `BadgeIssued`       → B1 merkle grant. Family from the event itself.
 *   - `ActivityCompleted` → B2 / verify (reward None — "completion IS the
 *                           badge"). Family via the activity→family map
 *                           ({@link badgeFamilyForActivity}); a completion for a
 *                           NON-badge activity contributes nothing.
 *
 * Art resolves from {@link STATIC_BADGE_REGISTRY}; an unmapped family yields a
 * `null` uri (the badge is still earned — the artifact is the display payoff).
 * One badge per family per identity (dedup keeps the earliest-issued).
 *
 * Pure + defensive: it discriminates on the sealed `$id` literal and tolerates
 * an unknown event in the stream (skips it) rather than throwing — the read
 * plane must never 500 on an unexpected event shape.
 *
 * S1.6 · 2026-06-08 · mibera-badge-surface.
 */

import { STATIC_BADGE_REGISTRY, badgeFamilyForActivity } from "./static-uri.js";

const BADGE_ISSUED_ID = "https://schemas.freeside.thj/badge-issued/v1.0.0";
const ACTIVITY_COMPLETED_ID = "https://schemas.freeside.thj/activity-completed/v1.0.0";

/** A normalized earned badge — the read-plane projection of a badge event. */
export interface EarnedBadge {
  readonly badge_family_id: string;
  readonly activity_id: string;
  readonly identity_id: string;
  /** Which event type contributed it. */
  readonly source: "badge-issued" | "activity-completed";
  readonly event_id: string;
  /** The event `ts` (RFC3339). */
  readonly issued_at: string;
  /** Static artifact URI for the family, or null if the family has no registry row. */
  readonly uri: string | null;
  /** The B1 snapshot (BadgeIssued only); null for completion-derived badges. */
  readonly snapshot_id: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Project a single event into an EarnedBadge, or null if it contributes none. */
function toEarnedBadge(ev: unknown): EarnedBadge | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as Record<string, unknown>;

  if (e.$id === BADGE_ISSUED_ID) {
    if (typeof e.badge_family_id !== "string") return null;
    return {
      badge_family_id: e.badge_family_id,
      activity_id: str(e.activity_id),
      identity_id: str(e.identity_id),
      source: "badge-issued",
      event_id: str(e.event_id),
      issued_at: str(e.ts),
      uri: STATIC_BADGE_REGISTRY[e.badge_family_id]?.uri ?? null,
      snapshot_id: typeof e.snapshot_id === "string" ? e.snapshot_id : null,
    };
  }

  if (e.$id === ACTIVITY_COMPLETED_ID) {
    if (typeof e.activity_id !== "string") return null;
    const family = badgeFamilyForActivity(e.activity_id);
    if (family === null) return null; // a completion for a non-badge activity
    return {
      badge_family_id: family,
      activity_id: e.activity_id,
      identity_id: str(e.identity_id),
      source: "activity-completed",
      event_id: str(e.event_id),
      issued_at: str(e.ts),
      uri: STATIC_BADGE_REGISTRY[family]?.uri ?? null,
      snapshot_id: null,
    };
  }

  return null;
}

/**
 * Project a stream of events into the deduplicated `EarnedBadge[]` for an
 * identity. One badge per `badge_family_id` (earliest-issued wins), sorted by
 * `issued_at` ascending for a stable render order.
 */
export function projectEarnedBadges(events: readonly unknown[]): EarnedBadge[] {
  const byFamily = new Map<string, EarnedBadge>();
  for (const ev of events) {
    const badge = toEarnedBadge(ev);
    if (badge === null) continue;
    const existing = byFamily.get(badge.badge_family_id);
    if (existing === undefined || badge.issued_at < existing.issued_at) {
      byFamily.set(badge.badge_family_id, badge);
    }
  }
  return [...byFamily.values()].sort((a, b) =>
    a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0,
  );
}
