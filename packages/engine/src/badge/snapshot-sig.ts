/**
 * Context-bound Ed25519 snapshot signature — the SINGLE shared builder +
 * verifier for the B1 operator-snapshot signature (SDD §1.10.2 · HIGH-780/725).
 *
 * The operator signs ONCE over a canonical context payload that binds the FULL
 * grant context — not the bare merkle root. This blocks a staging-snapshot
 * signature from being replayed as a production root (HIGH-780), and a snapshot
 * for one family/activity from being replayed against another. The signer
 * tooling (operator snapshot ingest, S3) and the grader (snapshot-sig verify,
 * S3.2) MUST build this byte string IDENTICALLY — so it lives in ONE module,
 * frozen by the golden vectors (§1.10.3, S1.2).
 *
 * ── Canonical message (fixed field order, byte encoding pinned) ─────────────
 *   domain ‖ 0x1F ‖ snapshot_id ‖ 0x1F ‖ badge_family_id ‖ 0x1F ‖ activity_id
 *     ‖ 0x1F ‖ environment_id ‖ 0x1F ‖ merkle_root ‖ 0x1F ‖ decimal(leaf_count)
 *     ‖ 0x1F ‖ created_at ‖ 0x1F ‖ signer_key_id
 *
 * Strings are UTF-8; `0x1F` (unit separator) sits between every adjacent field
 * (prevents concat ambiguity); `leaf_count` is ascii-decimal; `merkle_root` is
 * the `0x…` lowercase-hex STRING form (as stored), not the raw 32 bytes.
 * Ed25519 signs the raw message (whole-message; no pre-hash).
 *
 * `environment_id` is the explicit anti-promotion bind: a `staging` signature
 * does not verify under a `production` grader even if the root is identical.
 *
 * S1.2 · 2026-06-07 · mibera-badge-surface.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * The literal ascii domain separator. NOTE: SDD §1.10.2 annotates this
 * "(33 bytes)" — that is a documentation error; the literal is 26 ascii bytes
 * and the literal GOVERNS (it is what the golden vectors freeze). Do not pad.
 */
export const SNAPSHOT_SIG_DOMAIN = "freeside-badge-snapshot:v1";

/** The unit-separator byte placed between every field. */
const UNIT_SEPARATOR = 0x1f;

export type SnapshotEnvironment = "production" | "staging";

/** The full grant context the operator signs over (§1.10.2). */
export interface SnapshotSigContext {
  readonly snapshotId: string;
  readonly badgeFamilyId: string;
  readonly activityId: string;
  /** "production" | "staging" — the prod/stage anti-promotion bind. */
  readonly environmentId: SnapshotEnvironment;
  /** `0x…` lowercase-hex string form of the merkle root, as stored. */
  readonly merkleRoot: string;
  /** Non-negative integer count of leaves in the snapshot. */
  readonly leafCount: number;
  /** RFC3339 canonical stored string. */
  readonly createdAt: string;
  /** Resolves the verify key in `B1_OPERATOR_PUBKEYS`. */
  readonly signerKeyId: string;
}

/**
 * Build the exact canonical signed-message bytes (§1.10.2). Throws on a
 * non-integer / negative `leafCount` (a build-time precondition).
 */
export function snapshotSigMessage(ctx: SnapshotSigContext): Uint8Array {
  if (!Number.isInteger(ctx.leafCount) || ctx.leafCount < 0) {
    throw new Error(
      `snapshot-sig: leafCount must be a non-negative integer, got ${ctx.leafCount}`,
    );
  }
  // The 0x1F separator scheme is only unambiguous if no field VALUE contains a
  // 0x1F byte — otherwise two distinct contexts could shift data across field
  // boundaries and serialize to identical signed bytes, defeating the field
  // binding. Reject any field carrying the separator so serialization stays
  // injective. Build-time fail-fast; `verifySnapshotSignature` catches → deny
  // (fail-closed). (FAGAN cross-model review, S1.2.)
  assertNoSeparator("snapshotId", ctx.snapshotId);
  assertNoSeparator("badgeFamilyId", ctx.badgeFamilyId);
  assertNoSeparator("activityId", ctx.activityId);
  assertNoSeparator("environmentId", ctx.environmentId);
  assertNoSeparator("merkleRoot", ctx.merkleRoot);
  assertNoSeparator("createdAt", ctx.createdAt);
  assertNoSeparator("signerKeyId", ctx.signerKeyId);
  const sep = Uint8Array.of(UNIT_SEPARATOR);
  return concatBytes(
    utf8ToBytes(SNAPSHOT_SIG_DOMAIN),
    sep,
    utf8ToBytes(ctx.snapshotId),
    sep,
    utf8ToBytes(ctx.badgeFamilyId),
    sep,
    utf8ToBytes(ctx.activityId),
    sep,
    utf8ToBytes(ctx.environmentId),
    sep,
    utf8ToBytes(ctx.merkleRoot),
    sep,
    utf8ToBytes(String(ctx.leafCount)),
    sep,
    utf8ToBytes(ctx.createdAt),
    sep,
    utf8ToBytes(ctx.signerKeyId),
  );
}

/** Ed25519-sign a snapshot context with the operator private key (32 bytes). */
export function signSnapshot(ctx: SnapshotSigContext, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(snapshotSigMessage(ctx), privateKey);
}

/**
 * Verify an Ed25519 snapshot signature over the EXACT §1.10.2 payload. Accepts
 * hex (`0x`-prefixed or bare) or raw bytes for `signature`/`publicKey`.
 * Fail-CLOSED: any malformed input or signature mismatch returns `false` — a
 * grader denies, it never throws on attacker-supplied material.
 */
export function verifySnapshotSignature(
  ctx: SnapshotSigContext,
  signature: string | Uint8Array,
  publicKey: string | Uint8Array,
): boolean {
  try {
    const msg = snapshotSigMessage(ctx);
    const sig = typeof signature === "string" ? hexToBytes(strip0x(signature)) : signature;
    const pub = typeof publicKey === "string" ? hexToBytes(strip0x(publicKey)) : publicKey;
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

const strip0x = (s: string): string => (s.startsWith("0x") ? s.slice(2) : s);

const SEPARATOR_CHAR = String.fromCharCode(UNIT_SEPARATOR);

/** Reject a field value that contains the 0x1F separator byte (injectivity). */
function assertNoSeparator(field: string, value: string): void {
  if (value.includes(SEPARATOR_CHAR)) {
    throw new Error(`snapshot-sig: ${field} must not contain the 0x1F unit-separator byte`);
  }
}
