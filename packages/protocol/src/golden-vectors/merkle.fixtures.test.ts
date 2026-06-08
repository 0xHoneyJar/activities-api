/**
 * B1 merkle golden-vector STRUCTURAL invariants (protocol CI half of §1.10.3).
 *
 * protocol has no keccak dependency, so this asserts the fixture's structural
 * consistency WITHOUT recomputing hashes — shape, hex formats, level folding,
 * sort order, leaf membership, and B1 pinning. The cryptographic reproduction
 * (engine `merkle.ts` == these values == ethers oracle) is the engine half
 * (`packages/engine/src/badge/__tests__/merkle.golden.test.ts`).
 *
 * S1.2 · 2026-06-07 · mibera-badge-surface.
 */

import { describe, expect, it } from "vitest";

import {
  B1_MERKLE_GOLDEN,
  B1_MERKLE_SINGLE_LEAF,
  B1_STAGING_REPLAY_SIGNATURE,
  B1_WRONG_SIGNER_PUBKEY,
  type Hex,
  KECCAK256_EMPTY,
} from "./merkle.fixtures.js";

const HASH32 = /^0x[0-9a-f]{64}$/; // 32-byte lowercase hex
const isHash = (h: Hex) => HASH32.test(h);

describe("B1 merkle golden vector — structural invariants (§1.10.3)", () => {
  const g = B1_MERKLE_GOLDEN;

  it("is pinned to the B1 act_donationraffle activity / donation-raffle family", () => {
    expect(g.activity_id).toBe("act_donationraffle");
    expect(g.badge_family_id).toBe("donation-raffle");
    expect(g.environment_id).toBe("production");
    // ids honor the branded-id patterns (no separators after the prefix)
    expect(g.activity_id).toMatch(/^act_[a-z0-9]+$/);
    expect(g.snapshot_id).toMatch(/^snap_[a-z0-9]+$/);
  });

  it("leaf_count is consistent across all representations", () => {
    expect(g.leaf_count).toBe(g.leaves.length);
    expect(g.leaf_count).toBe(g.sorted_leaf_hashes.length);
    expect(g.levels[0]!.length).toBe(g.leaf_count);
  });

  it("exercises odd-node promotion (leaf_count is not a power of two)", () => {
    const n = g.leaf_count;
    expect(n & (n - 1)).not.toBe(0);
  });

  it("every hash is well-formed 32-byte lowercase hex", () => {
    expect(isHash(g.merkle_root)).toBe(true);
    for (const h of g.sorted_leaf_hashes) expect(isHash(h)).toBe(true);
    for (const level of g.levels) for (const h of level) expect(isHash(h)).toBe(true);
    for (const l of g.leaves) {
      expect(isHash(l.leaf_hash)).toBe(true);
      for (const p of l.proof) expect(isHash(p)).toBe(true);
    }
  });

  it("sorted_leaf_hashes is strictly ascending and matches levels[0]", () => {
    for (let i = 1; i < g.sorted_leaf_hashes.length; i++) {
      expect(g.sorted_leaf_hashes[i - 1]! < g.sorted_leaf_hashes[i]!).toBe(true);
    }
    expect([...g.levels[0]!]).toEqual([...g.sorted_leaf_hashes]);
  });

  it("each level folds to ceil(prev/2) nodes; the last level is [root]", () => {
    for (let i = 1; i < g.levels.length; i++) {
      expect(g.levels[i]!.length).toBe(Math.ceil(g.levels[i - 1]!.length / 2));
    }
    const last = g.levels[g.levels.length - 1]!;
    expect(last.length).toBe(1);
    expect(last[0]).toBe(g.merkle_root);
  });

  it("every leaf row maps to its sorted position and a member leaf hash", () => {
    for (const l of g.leaves) {
      expect(g.sorted_leaf_hashes[l.sorted_index]).toBe(l.leaf_hash);
      expect(l.wallet).toMatch(/^0x[0-9a-f]{40}$/); // normalized lowercase
    }
  });

  it("single-leaf vector: root === leaf", () => {
    expect(isHash(B1_MERKLE_SINGLE_LEAF.leaf_hash)).toBe(true);
    expect(B1_MERKLE_SINGLE_LEAF.merkle_root).toBe(B1_MERKLE_SINGLE_LEAF.leaf_hash);
  });

  it("signature material is well-formed (§1.10.2)", () => {
    expect(g.signer_pubkey).toMatch(/^0x[0-9a-f]{64}$/); // ed25519 pubkey, 32 bytes
    expect(g.root_signature).toMatch(/^0x[0-9a-f]{128}$/); // ed25519 sig, 64 bytes
    expect(B1_STAGING_REPLAY_SIGNATURE).toMatch(/^0x[0-9a-f]{128}$/);
    expect(B1_WRONG_SIGNER_PUBKEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(g.sig_message_hex.startsWith("0x")).toBe(true);
    // The message begins with the ascii domain separator "freeside-badge-snapshot:v1".
    expect(g.sig_message_hex.startsWith("0x66726565736964652d62616467652d736e617073686f743a7631")).toBe(true);
  });

  it("KECCAK256_EMPTY is the EVM keccak digest, not NIST SHA3-256", () => {
    expect(KECCAK256_EMPTY).toMatch(HASH32);
    expect(KECCAK256_EMPTY).not.toBe(
      "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    );
  });
});
