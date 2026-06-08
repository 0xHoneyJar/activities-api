/**
 * CRITICAL-870 firebreak — engine-side cross-validation of the B1 merkle +
 * snapshot-signature golden vectors (SDD §1.10.3 · S1.2).
 *
 * Asserts THREE things agree, on every CI run:
 *   1. the engine implementation under test (`merkle.ts` / `snapshot-sig.ts`);
 *   2. the FROZEN protocol fixture (`@0xhoneyjar/quests-protocol`
 *      `B1_MERKLE_GOLDEN` — the same artifact protocol CI consumes);
 *   3. an INDEPENDENT live oracle (`ethers`: a different keccak implementation
 *      + EVM `encodePacked` reference).
 *
 * Plus a known-answer test pinning the keccak VARIANT (keccak-256 ≠ NIST
 * SHA3-256), and every signature failure class the §1.10.2 anti-replay design
 * must reject.
 *
 * S1.2 · 2026-06-07 · mibera-badge-surface.
 */

import { keccak256 as ethersKeccak256, solidityPackedKeccak256, toUtf8Bytes } from "ethers";
import { bytesToHex } from "@noble/hashes/utils";
import {
  B1_MERKLE_GOLDEN,
  B1_MERKLE_SINGLE_LEAF,
  B1_STAGING_REPLAY_SIGNATURE,
  B1_WRONG_SIGNER_PUBKEY,
  type Hex,
  KECCAK256_EMPTY,
} from "@0xhoneyjar/quests-protocol";
import { describe, expect, it } from "vitest";

import { buildMerkleTree, keccakHex, merkleLeaf, verifyMerkleProof } from "../merkle.js";
import {
  type SnapshotSigContext,
  snapshotSigMessage,
  verifySnapshotSignature,
} from "../snapshot-sig.js";

const g = B1_MERKLE_GOLDEN;

/** Independent leaf oracle — ethers `encodePacked` + double keccak (≠ noble). */
function oracleLeaf(wallet: string): Hex {
  const snapH = ethersKeccak256(toUtf8Bytes(g.snapshot_id));
  const famH = ethersKeccak256(toUtf8Bytes(g.badge_family_id));
  const inner = solidityPackedKeccak256(
    ["address", "bytes32", "bytes32"],
    [wallet.toLowerCase(), snapH, famH],
  );
  return ethersKeccak256(inner) as Hex;
}

const ctx: SnapshotSigContext = {
  snapshotId: g.snapshot_id,
  badgeFamilyId: g.badge_family_id,
  activityId: g.activity_id,
  environmentId: g.environment_id,
  merkleRoot: g.merkle_root,
  leafCount: g.leaf_count,
  createdAt: g.created_at,
  signerKeyId: g.signer_key_id,
};

describe("CRITICAL-870 merkle golden vectors (§1.10.3)", () => {
  it("KAT: keccak-256 of empty is the EVM digest, NOT NIST SHA3-256", () => {
    expect(keccakHex(new Uint8Array(0))).toBe(KECCAK256_EMPTY);
    // NIST SHA3-256("") would be 0xa7ffc6f8…; assert we are NOT that.
    expect(keccakHex(new Uint8Array(0))).not.toBe(
      "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    );
  });

  describe("leaf encoding (§1.10.1) — engine == frozen == ethers oracle", () => {
    for (const leaf of g.leaves) {
      it(`wallet ${leaf.wallet}`, () => {
        const eng = merkleLeaf({
          wallet: leaf.wallet,
          snapshotId: g.snapshot_id,
          badgeFamilyId: g.badge_family_id,
        });
        expect(eng).toBe(leaf.leaf_hash); // engine == frozen
        expect(oracleLeaf(leaf.wallet)).toBe(leaf.leaf_hash); // ethers == frozen
      });
    }
  });

  it("buildMerkleTree reproduces the frozen sorted leaves, levels, and root", () => {
    const tree = buildMerkleTree(g.leaves.map((l) => l.leaf_hash));
    expect(tree.leaves).toEqual(g.sorted_leaf_hashes);
    expect(tree.levels).toEqual(g.levels);
    expect(tree.root).toBe(g.merkle_root);
  });

  it("every frozen proof folds to the frozen root, and the engine reproduces each proof", () => {
    const tree = buildMerkleTree(g.leaves.map((l) => l.leaf_hash));
    for (const l of g.leaves) {
      expect(verifyMerkleProof(l.leaf_hash, l.proof, g.merkle_root)).toBe(true);
      expect(tree.proofFor(l.leaf_hash)).toEqual(l.proof);
    }
  });

  it("single-leaf vector: root === leaf, empty proof verifies (engine == frozen == ethers)", () => {
    const eng = merkleLeaf({
      wallet: B1_MERKLE_SINGLE_LEAF.wallet,
      snapshotId: g.snapshot_id,
      badgeFamilyId: g.badge_family_id,
    });
    expect(eng).toBe(B1_MERKLE_SINGLE_LEAF.leaf_hash);
    expect(oracleLeaf(B1_MERKLE_SINGLE_LEAF.wallet)).toBe(B1_MERKLE_SINGLE_LEAF.leaf_hash);
    expect(buildMerkleTree([eng]).root).toBe(B1_MERKLE_SINGLE_LEAF.merkle_root);
    expect(verifyMerkleProof(eng, [], B1_MERKLE_SINGLE_LEAF.merkle_root)).toBe(true);
  });

  describe("merkle failure classes (verify MUST be false)", () => {
    const first = g.leaves[0]!;
    const flip = (h: Hex): Hex => `0x${h[2] === "3" ? "4" : "3"}${h.slice(3)}`;

    it("tampered leaf", () => {
      expect(verifyMerkleProof(flip(first.leaf_hash), first.proof, g.merkle_root)).toBe(false);
    });
    it("tampered proof element", () => {
      const bad = [...first.proof];
      bad[0] = flip(bad[0]!);
      expect(verifyMerkleProof(first.leaf_hash, bad, g.merkle_root)).toBe(false);
    });
    it("proof presented against the wrong root", () => {
      expect(verifyMerkleProof(first.leaf_hash, first.proof, flip(g.merkle_root))).toBe(false);
    });
  });

  describe("snapshot signature (§1.10.2 context-bound Ed25519)", () => {
    it("canonical sig_message bytes match the frozen hex", () => {
      expect((`0x${bytesToHex(snapshotSigMessage(ctx))}`) as Hex).toBe(g.sig_message_hex);
    });
    it("valid signature verifies under the signer pubkey", () => {
      expect(verifySnapshotSignature(ctx, g.root_signature, g.signer_pubkey)).toBe(true);
    });
    it("FAILS: staging signature replayed as production (HIGH-780 anti-promotion)", () => {
      expect(verifySnapshotSignature(ctx, B1_STAGING_REPLAY_SIGNATURE, g.signer_pubkey)).toBe(false);
    });
    it("FAILS: environment flipped to staging under the production signature", () => {
      expect(
        verifySnapshotSignature({ ...ctx, environmentId: "staging" }, g.root_signature, g.signer_pubkey),
      ).toBe(false);
    });
    it("FAILS: unknown / wrong signer key", () => {
      expect(verifySnapshotSignature(ctx, g.root_signature, B1_WRONG_SIGNER_PUBKEY)).toBe(false);
    });
    it("FAILS: tampered merkle_root in the context", () => {
      const tamperedRoot = `0x${g.merkle_root[2] === "b" ? "c" : "b"}${g.merkle_root.slice(3)}` as Hex;
      expect(
        verifySnapshotSignature({ ...ctx, merkleRoot: tamperedRoot }, g.root_signature, g.signer_pubkey),
      ).toBe(false);
    });
    it("FAILS: tampered leaf_count in the context", () => {
      expect(
        verifySnapshotSignature({ ...ctx, leafCount: g.leaf_count + 1 }, g.root_signature, g.signer_pubkey),
      ).toBe(false);
    });

    it("rejects a field containing the 0x1F separator byte (delimiter-injection hardening)", () => {
      const evil = `${g.snapshot_id}spliced`;
      expect(() => snapshotSigMessage({ ...ctx, snapshotId: evil })).toThrow(/unit-separator/);
    });

    it("FAILS-closed: verify denies when a context field carries 0x1F", () => {
      const evil = `${g.badge_family_id}`;
      expect(
        verifySnapshotSignature({ ...ctx, badgeFamilyId: evil }, g.root_signature, g.signer_pubkey),
      ).toBe(false);
    });
  });
});
