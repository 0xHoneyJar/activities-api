/**
 * BadgeIssuancePort static-URI adapter — the third Layer option (VB.2).
 *
 * Where {@link BadgeIssuancePortNullLayer} (in `index.ts`) always returns
 * `null` and {@link BadgeIssuancePortAssetPipelineStubLayer} (in
 * `asset-pipeline-stub.ts`) is the `Effect.die` placeholder for Cycle B's
 * real generation pipeline, this Layer resolves the issued `BadgeArtifact`
 * from a small STATIC `badgeId → uri` map.
 *
 * It is the load-bearing payoff for the "verify → badge" first consumer:
 * an APPROVED verdict for a quest whose `badge_spec.family_id` is a known
 * static badge resolves to a real `BadgeArtifact` carrying a stable CDN
 * `uri` — no asset-pipeline, no Track A content, no Cycle B dependency.
 *
 * It is ADDITIVE: the Null + asset-pipeline-stub Layers are untouched. A
 * composition root picks ONE Layer; this one is the right choice for the
 * verify-badge slice until Cycle B's generation pipeline lands. Same Tag
 * identity (`@freeside-quests/BadgeIssuancePort` ·
 * {@link BADGE_ISSUANCE_PORT_TAG_IDENTITY}) — Effect resolves all three
 * Layers as the same port; the bot consumer changes ZERO lines to adopt.
 *
 * The `badgeId` lookup key is `quest.badge_spec.family_id` — the stable
 * badge-family identifier on the Quest (e.g. `"verify"`). Unknown families
 * resolve to `null` (mirrors the Null Layer's no-artifact path: the error
 * channel stays `never`, so the soft-conversion / anon path is preserved).
 *
 * Per [[metadata-as-integration-contract]]: the `uri` is the contract —
 * variants (size · format) resolve at presentation time. Per Eileen's
 * no-paying rail: off-chain artifact only · NO on-chain mint flow.
 *
 * VB.2 · 2026-05-31 · verify-badge slice.
 */

import { Effect, Layer, Schema } from "effect";
import {
  type Quest,
  type QuestVerdict,
  type PlayerIdentity,
  type BadgeArtifact,
  BadgeURI,
  RFC3339Date,
} from "@0xhoneyjar/quests-protocol";

import { BadgeIssuancePort } from "./index.js";

// ---------------------------------------------------------------------------
// Static badge artifact descriptor
// ---------------------------------------------------------------------------

/**
 * The static descriptor for one badge family. The runtime `issued_at` is
 * NOT baked in here — it is stamped per-issuance so two completions of the
 * same badge carry distinct timestamps (the URI stays stable).
 */
export interface StaticBadgeDescriptor {
  readonly uri: string;
  readonly generated_format: BadgeArtifact["generated_format"];
  readonly prompt_seed_used: string;
}

/**
 * Static `badgeId → descriptor` map. `badgeId` is the Quest's
 * `badge_spec.family_id` string. Add a row here to make a badge family
 * resolvable by the static adapter.
 *
 * The `verify` badge is the first (and currently only) mapping — the
 * artifact payoff for the verify-badge first consumer.
 */
export const STATIC_BADGE_REGISTRY: Readonly<
  Record<string, StaticBadgeDescriptor>
> = {
  verify: {
    uri: "https://d163aeqznbc6js.cloudfront.net/images/faucet/badges/verify.png",
    generated_format: "png",
    prompt_seed_used: "static:verify-badge",
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `BadgeArtifact` for a known `badgeId`, or `null` for an unknown
 * one. Pure (modulo the injected `issued_at` clock value). Exposed for
 * focused unit testing without standing up the Layer.
 *
 * F-004 (GATE-SEC-1 hardening): `BadgeArtifact.issued_at` is bare
 * `Schema.String` — the sealed schema does NOT constrain it to RFC3339. The
 * Layer below calls this with `new Date().toISOString()` (always valid), but
 * the EXPORTED function previously trusted its caller's `issuedAt` blindly and
 * would mint an artifact carrying a non-RFC3339 timestamp. Since the
 * BadgeIssuancePort stays a pure artifact resolver (F-001 — the route owns the
 * verdict gate, not this port), the right home for the precondition check is
 * here: `issuedAt` is validated against {@link RFC3339Date} before it lands in
 * `issued_at`. An invalid timestamp is a caller precondition violation (NOT an
 * "unknown badge" — that still returns `null`), so it throws with a clear
 * message rather than silently producing a malformed artifact.
 */
export const resolveStaticBadge = (
  badgeId: string,
  issuedAt: string,
): BadgeArtifact | null => {
  const descriptor = STATIC_BADGE_REGISTRY[badgeId];
  if (descriptor === undefined) {
    return null;
  }
  // F-004: validate the caller-supplied timestamp before baking it in. The
  // decode throws a ParseError (synchronous boundary) on a non-RFC3339 value,
  // surfacing the precondition violation at the resolver rather than letting a
  // malformed `issued_at` flow into a "valid" BadgeArtifact downstream.
  const issued_at = Schema.decodeUnknownSync(RFC3339Date)(issuedAt) as unknown as string;
  return {
    uri: Schema.decodeUnknownSync(BadgeURI)(descriptor.uri),
    generated_format: descriptor.generated_format,
    prompt_seed_used: descriptor.prompt_seed_used,
    issued_at,
  };
};

// ---------------------------------------------------------------------------
// Static-URI Layer — third Layer option (additive)
// ---------------------------------------------------------------------------

/**
 * Static-URI Layer. `issue()` looks up `quest.badge_spec.family_id` in
 * {@link STATIC_BADGE_REGISTRY}:
 *   - known family → `BadgeArtifact` with the mapped stable `uri`
 *   - unknown family → `null` (no artifact · soft-conversion path preserved)
 *
 * Never fails (error channel stays `never`) — same contract as the Null
 * Layer, so swapping it in changes ZERO consumer code.
 */
export const BadgeIssuancePortStaticLayer = Layer.succeed(
  BadgeIssuancePort,
  BadgeIssuancePort.of({
    issue: (quest: Quest, _verdict: QuestVerdict, _player: PlayerIdentity) =>
      Effect.succeed(
        resolveStaticBadge(quest.badge_spec.family_id, new Date().toISOString()),
      ),
  }),
);
