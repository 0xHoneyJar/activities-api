/**
 * Keccak-256 sorted-pair merkle module — structural invariant tests (S1.1).
 *
 * These prove the §1.10.1 algorithm's internal invariants (determinism,
 * leaf-binding, order/dup-independence, odd-node promotion, fold-verify
 * round-trip, fail-closed verify). The INDEPENDENT-ORACLE cross-validation
 * (frozen golden vectors computed without this module) is S1.2 — that is the
 * CRITICAL-870 firebreak; this file only proves the module agrees with itself.
 *
 * S1.1 · 2026-06-07 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import {
  type Hex,
  buildMerkleTree,
  hashPair,
  merkleLeaf,
  normalizeWallet,
  verifyMerkleProof,
} from "../merkle.js";

const SNAP = "snap_donation_20260607";
const FAMILY = "donation-raffle";

// A small fixed wallet set incl. checksummed + lowercase forms.
const W = (n: number): string =>
  `0x${n.toString(16).padStart(40, "0")}`;

const leafOf = (wallet: string, snap = SNAP, family = FAMILY): Hex =>
  merkleLeaf({ wallet, snapshotId: snap, badgeFamilyId: family });

describe("merkleLeaf (§1.10.1)", () => {
  it("is deterministic for the same inputs", () => {
    expect(leafOf(W(1))).toBe(leafOf(W(1)));
  });

  it("produces a 0x + 64-hex (32-byte) lowercase value", () => {
    expect(leafOf(W(1))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is wallet-case-insensitive (EIP-55 checksum stripped to lowercase)", () => {
    const mixed = "0xAbC0000000000000000000000000000000000123";
    expect(leafOf(mixed)).toBe(leafOf(mixed.toLowerCase()));
  });

  it("binds the leaf to the snapshot (anti-cross-snapshot replay)", () => {
    expect(leafOf(W(1), "snap_A")).not.toBe(leafOf(W(1), "snap_B"));
  });

  it("binds the leaf to the badge family (family A ≠ family B)", () => {
    expect(leafOf(W(1), SNAP, "family-a")).not.toBe(leafOf(W(1), SNAP, "family-b"));
  });

  it("rejects a malformed wallet (fail-fast)", () => {
    expect(() => leafOf("0xnothex")).toThrow();
    expect(() => leafOf("0x123")).toThrow();
    expect(() => leafOf("abc0000000000000000000000000000000000123")).toThrow();
  });
});

describe("normalizeWallet (§1.10.4)", () => {
  it("decodes to 20 raw bytes", () => {
    expect(normalizeWallet(W(255)).length).toBe(20);
  });
  it("rejects non-conforming input rather than dropping it", () => {
    expect(() => normalizeWallet("0x")).toThrow();
    expect(() => normalizeWallet("")).toThrow();
  });
});

describe("buildMerkleTree (§1.10.1)", () => {
  it("single-leaf tree: root IS the leaf, proof is empty", () => {
    const leaf = leafOf(W(1));
    const tree = buildMerkleTree([leaf]);
    expect(tree.root).toBe(leaf);
    expect(tree.proofFor(leaf)).toEqual([]);
    expect(verifyMerkleProof(leaf, [], tree.root)).toBe(true);
  });

  it("is order-independent (canonical sort) — shuffled input yields the same root", () => {
    const leaves = [W(5), W(2), W(9), W(1)].map((w) => leafOf(w));
    const rootA = buildMerkleTree(leaves).root;
    const rootB = buildMerkleTree([...leaves].reverse()).root;
    expect(rootA).toBe(rootB);
  });

  it("collapses duplicate leaves (a wallet listed twice grants once)", () => {
    const a = leafOf(W(1));
    const b = leafOf(W(2));
    const withDup = buildMerkleTree([a, b, a]);
    const deduped = buildMerkleTree([a, b]);
    expect(withDup.root).toBe(deduped.root);
    expect(withDup.leaves.length).toBe(2);
  });

  it("throws on an empty leaf set", () => {
    expect(() => buildMerkleTree([])).toThrow();
  });

  it("throws on a malformed leaf", () => {
    expect(() => buildMerkleTree(["0xdeadbeef" as Hex])).toThrow();
  });

  // Exercise odd-node promotion across several non-power-of-two sizes.
  for (const n of [2, 3, 4, 5, 7, 8, 9, 16, 17]) {
    it(`every member proof folds to root (n=${n}, exercises odd promotion)`, () => {
      const leaves = Array.from({ length: n }, (_, i) => leafOf(W(i + 1)));
      const tree = buildMerkleTree(leaves);
      for (const leaf of tree.leaves) {
        expect(verifyMerkleProof(leaf, tree.proofFor(leaf), tree.root)).toBe(true);
      }
    });
  }

  it("proofFor throws for a non-member leaf", () => {
    const tree = buildMerkleTree([leafOf(W(1)), leafOf(W(2))]);
    expect(() => tree.proofFor(leafOf(W(999)))).toThrow();
  });
});

describe("verifyMerkleProof (§1.10.1, fail-closed)", () => {
  const leaves = Array.from({ length: 6 }, (_, i) => leafOf(W(i + 1)));
  const tree = buildMerkleTree(leaves);
  const member = tree.leaves[0]!;
  const proof = tree.proofFor(member);

  it("rejects a tampered root", () => {
    const wrongRoot = ("0x" + "f".repeat(64)) as Hex;
    expect(verifyMerkleProof(member, proof, wrongRoot)).toBe(false);
  });

  it("rejects a tampered proof element", () => {
    if (proof.length > 0) {
      const tampered = [...proof];
      tampered[0] = ("0x" + "0".repeat(64)) as Hex;
      expect(verifyMerkleProof(member, tampered, tree.root)).toBe(false);
    }
  });

  it("rejects a non-member leaf with another leaf's proof", () => {
    const outsider = leafOf(W(123456));
    expect(verifyMerkleProof(outsider, proof, tree.root)).toBe(false);
  });

  it("rejects a proof from a DIFFERENT snapshot's tree (anti-replay)", () => {
    const otherLeaves = Array.from({ length: 6 }, (_, i) =>
      leafOf(W(i + 1), "snap_OTHER"),
    );
    const otherTree = buildMerkleTree(otherLeaves);
    const otherMember = otherTree.leaves[0]!;
    expect(
      verifyMerkleProof(otherMember, otherTree.proofFor(otherMember), tree.root),
    ).toBe(false);
  });

  it("is fail-closed on malformed input (returns false, never throws)", () => {
    expect(verifyMerkleProof("0xbad" as Hex, proof, tree.root)).toBe(false);
    expect(verifyMerkleProof(member, ["0xbad" as Hex], tree.root)).toBe(false);
    expect(verifyMerkleProof(member, proof, "0xbad" as Hex)).toBe(false);
  });
});

describe("hashPair (commutative sorted-pair)", () => {
  it("is commutative: hashPair(a,b) === hashPair(b,a)", () => {
    const a = leafOf(W(1));
    const b = leafOf(W(2));
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });
});
