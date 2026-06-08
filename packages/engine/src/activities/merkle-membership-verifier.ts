/**
 * merkle-membership-verifier — the authoritative APPROVED source for a B1
 * `MerkleProof` step (GATE-SEC-1 · S1.4 · CRITICAL-870 / HIGH-780).
 *
 * ── WHY THIS IS NOT A HOLE ───────────────────────────────────────────────────
 *
 * A blanket `() => APPROVED` for a merkle step would let any caller claim any
 * badge. This verifier does NOT do that. The authoritative fact is a
 * cryptographic one, derived two ways — BOTH must hold, or it denies:
 *
 *   (a) the snapshot's CONTEXT-BOUND Ed25519 signature (§1.10.2) verifies under
 *       the operator pubkey resolved from `signer_key_id` (rotation set) — an
 *       unknown key is a HARD deny, never a fallback; AND
 *   (b) the per-identity Keccak-256 sorted-pair membership proof (§1.10.1) folds
 *       the canonical wallet leaf to the snapshot's signed `merkle_root`.
 *
 * The approval is attributed to the named `merkle-membership` grader slug, so a
 * future audit reads "approved by merkle-membership" — derived from a verified
 * signature + proof, never minted by the writer.
 *
 * ── DEFAULT-DENY ─────────────────────────────────────────────────────────────
 *
 * Fires ONLY for a `MerkleProof` step. Anything else → sealed
 * {@link MerkleVerifierError} (the caller maps it to a non-APPROVED → NO grant).
 * Every failure mode — wrong step, snapshot/step mismatch, unknown signer key,
 * environment mismatch, bad signature, non-member proof — denies. There is NO
 * path where an unverified claim yields APPROVED.
 *
 * ── ANTI-REPLAY BINDS (§1.10.2) ──────────────────────────────────────────────
 *
 *   - snapshot↔step:        `snapshot.snapshotId` MUST equal the step's
 *                           declared `snapshot_id` (a snapshot for activity A
 *                           cannot grant activity B's step).
 *   - environment:          `snapshot.environmentId` MUST equal the runtime
 *                           `environmentId` (a staging snapshot cannot grant in
 *                           production even with an authentic signature).
 *   - the leaf binds wallet+snapshot+family, so a proof from one snapshot/family
 *     can never be replayed against another root.
 *
 * Stays I/O-free (Plane-2) — the caller resolves the snapshot (S3 store) and the
 * per-identity proof, and injects the operator pubkey map (env, §1.7); this
 * module only adjudicates. Mirrors {@link verifyIdentityProofVerifier}.
 *
 * S1.4 · GATE-SEC-1 · 2026-06-08 · mibera-badge-surface.
 */

import { Data, Effect, Schema } from "effect";

import {
  type ActivityStep,
  SUBSTRATE_STEP_CONTRACT_VERSION,
  SubstrateStepVerdict,
} from "@0xhoneyjar/quests-protocol";

import {
  type Hex,
  merkleLeaf,
  verifyMerkleProof,
} from "../badge/merkle.js";
import {
  type SnapshotEnvironment,
  type SnapshotSigContext,
  verifySnapshotSignature,
} from "../badge/snapshot-sig.js";
import type { AuthenticatedIdentity } from "./verify-verifier.js";

/**
 * The named grader-construct slug attributed to every merkle-membership
 * approval. Matches `SubstrateStepVerdict.graderConstructSlug` pattern
 * `^[a-z][a-z0-9-]*$`.
 */
export const MERKLE_MEMBERSHIP_GRADER_SLUG = "merkle-membership" as const;

/**
 * A resolved snapshot the grader adjudicates against — the §1.10.2 signed
 * context plus the signature to verify. The caller (S3 ingest store / bulk-grant
 * driver) builds this from the persisted snapshot; the grader never reads I/O.
 */
export interface ResolvedSnapshot {
  /** The exact §1.10.2 context the operator signed (includes `merkleRoot`). */
  readonly context: SnapshotSigContext;
  /** The Ed25519 signature over `context` (`0x`-hex or bytes). */
  readonly rootSignature: string;
}

/** Map of `signer_key_id` → Ed25519 public key (the rotation set, §1.10.2 / §1.7). */
export type OperatorPubkeys = Readonly<Record<string, string>>;

/**
 * MerkleVerifierError — sealed (never thrown). The `reason` is audit-facing; it
 * names the specific bind that failed without leaking key material.
 */
export class MerkleVerifierError extends Data.TaggedError("MerkleVerifierError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** Decide whether a step is a MerkleProof step this verifier owns. Pure. */
export const isMerkleStep = (step: ActivityStep): boolean =>
  step.verification._tag === "MerkleProof";

/**
 * merkleMembershipVerifier — APPROVED iff the snapshot signature AND the
 * membership proof both verify (and every anti-replay bind holds). Any failure
 * → sealed {@link MerkleVerifierError} (→ caller denies, NO grant).
 *
 * @param identity      the grant recipient (resolved from the leaf wallet, §1.10.4)
 * @param step          the activity step (MUST be MerkleProof)
 * @param wallet        the eligibility wallet — the leaf key (§1.10.4)
 * @param snapshot      the resolved, signed snapshot (root + §1.10.2 context + sig)
 * @param proof         the per-identity Keccak sorted-pair proof
 * @param operatorPubkeys  the rotation set (env, §1.7); unknown key → deny
 * @param environmentId    the RUNTIME environment (the anti-promotion bind)
 * @param submissionId  authoritative correlation id (route/driver-stamped)
 * @param traceId       authoritative trace id (route/driver-stamped)
 */
export const merkleMembershipVerifier = (params: {
  readonly identity: AuthenticatedIdentity;
  readonly step: ActivityStep;
  readonly wallet: string;
  readonly snapshot: ResolvedSnapshot;
  readonly proof: readonly Hex[];
  readonly operatorPubkeys: OperatorPubkeys;
  readonly environmentId: SnapshotEnvironment;
  readonly submissionId: string;
  readonly traceId: string;
  readonly gradedAtProvider?: () => string;
}): Effect.Effect<SubstrateStepVerdict, MerkleVerifierError> =>
  Effect.gen(function* () {
    const { step, wallet, snapshot, proof, operatorPubkeys, environmentId } = params;
    const ctx = snapshot.context;

    const deny = (reason: string) =>
      Effect.fail(new MerkleVerifierError({ reason }));

    // DEFAULT-DENY: only a MerkleProof step is in scope.
    if (step.verification._tag !== "MerkleProof") {
      return yield* deny(
        `merkleMembershipVerifier only approves MerkleProof steps; got ` +
          `verification _tag="${step.verification._tag}". Refusing an unowned step.`,
      );
    }

    // BIND 1 (snapshot↔step): the snapshot MUST be the one the step declares.
    if (ctx.snapshotId !== step.verification.snapshot_id) {
      return yield* deny(
        `snapshot "${ctx.snapshotId}" does not match the step's declared ` +
          `snapshot_id "${step.verification.snapshot_id}".`,
      );
    }

    // BIND 2 (environment): a snapshot signed for another environment cannot
    // grant here, even with an authentic signature (HIGH-780 anti-promotion).
    if (ctx.environmentId !== environmentId) {
      return yield* deny(
        `snapshot environment "${ctx.environmentId}" does not match the runtime ` +
          `environment "${environmentId}".`,
      );
    }

    // BIND 3 (signer): resolve the verify key from the rotation set. An unknown
    // signer_key_id is a HARD deny — never a fallback to a default key.
    const pubkey = operatorPubkeys[ctx.signerKeyId];
    if (pubkey === undefined) {
      return yield* deny(`unknown signer_key_id "${ctx.signerKeyId}" (not in the rotation set).`);
    }

    // CHECK A (signature): the context-bound Ed25519 signature verifies (§1.10.2).
    if (!verifySnapshotSignature(ctx, snapshot.rootSignature, pubkey)) {
      return yield* deny(`snapshot signature failed verification under signer "${ctx.signerKeyId}".`);
    }

    // CHECK B (membership): the canonical wallet leaf folds to the signed root
    // (§1.10.1). A malformed wallet throws inside merkleLeaf — treat as deny.
    const membership = yield* Effect.try({
      try: () => {
        const leaf = merkleLeaf({
          wallet,
          snapshotId: ctx.snapshotId,
          badgeFamilyId: ctx.badgeFamilyId,
        });
        return verifyMerkleProof(leaf, proof, ctx.merkleRoot as Hex);
      },
      catch: (cause) =>
        new MerkleVerifierError({ reason: "membership proof construction failed", cause }),
    });
    if (!membership) {
      return yield* deny(`membership proof does not fold to the snapshot root.`);
    }

    const gradedAt = (params.gradedAtProvider ?? (() => new Date().toISOString()))();

    // APPROVED. confidence 1.0 — membership is a binary cryptographic fact. The
    // reasoning bakes in the snapshot + family for the audit trail.
    const verdictUnchecked = {
      submissionId: params.submissionId,
      traceId: params.traceId,
      status: "APPROVED" as const,
      confidence: 1,
      reasoning:
        `merkle membership proven: wallet leaf folds to signed root of snapshot ` +
        `"${ctx.snapshotId}" (family="${ctx.badgeFamilyId}", signer="${ctx.signerKeyId}", ` +
        `env="${ctx.environmentId}"); approved by the ${MERKLE_MEMBERSHIP_GRADER_SLUG} grader.`,
      graderConstructSlug: MERKLE_MEMBERSHIP_GRADER_SLUG,
      gradedAt,
      contractVersion: SUBSTRATE_STEP_CONTRACT_VERSION,
    };

    // F-002: re-decode through the sealed schema before trusting.
    return yield* Schema.decodeUnknown(SubstrateStepVerdict)(verdictUnchecked).pipe(
      Effect.mapError(
        (cause) =>
          new MerkleVerifierError({
            reason: "constructed merkle verdict failed schema validation",
            cause,
          }),
      ),
    );
  });
