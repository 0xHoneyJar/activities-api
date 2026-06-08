/**
 * Keccak-256 sorted-pair merkle module — the SINGLE shared implementation of
 * the B1 badge-snapshot crypto (SDD §1.10.1 · CRITICAL-870).
 *
 * Both halves of the B1 flow import THIS module — there is exactly one
 * implementation, so the operator tree-builder tooling (snapshot ingest, S3)
 * and the in-substrate `merkle-membership` grader (eligibility, S1.4) can never
 * silently diverge. Divergence between leaf/tree/proof construction would fail
 * 100% of B1 grants as indistinguishable `NEEDS_HUMAN` denies — the CRITICAL-870
 * footgun. The module is pinned by cross-validation golden vectors (§1.10.3,
 * S1.2) computed by an INDEPENDENT oracle.
 *
 * ── Hash ────────────────────────────────────────────────────────────────────
 * Keccak-256 (Ethereum's `keccak256`), NOT NIST SHA3-256 — they differ in
 * padding. `@noble/hashes/sha3` `keccak_256` (audited, pure-TS, zero-native;
 * identical under Bun + Node + browser). This is DISTINCT from the WebCrypto
 * SHA-256 partition-slug digest at `apps/runtime/src/routes/_shared.ts:40-49`,
 * which MUST NOT be reused for merkle leaves (mixing the two is CRITICAL-870).
 *
 * ── Leaf preimage (EVM-aligned, double-hashed) ──────────────────────────────
 *   leaf = keccak256( keccak256( abi.encodePacked(
 *            address  wallet,        // 20 raw bytes (EIP-55 stripped → lowercase hex → bytes)
 *            bytes32  snapshot_id_h, // keccak256(utf8(snapshot_id))
 *            bytes32  badge_family_h // keccak256(utf8(badge_family_id))
 *          ) ) )
 * Fixed-width fields ⇒ `encodePacked` is collision-safe (no variable-length
 * concat ambiguity). Double-hash ⇒ 2nd-preimage resistance between leaf and
 * internal nodes (an internal node can never be passed off as a leaf). The leaf
 * is keyed on the WALLET (the eligibility key, EVM-expressible for the on-chain
 * graduation seam NFR-4), never on `identity_id`.
 *
 * ── Tree (sorted-pair, level-by-level with odd-node promotion) ──────────────
 * Leaves are deduplicated and sorted ascending by their 32-byte value, so the
 * tree shape is canonical regardless of input order. Each level pairs adjacent
 * nodes; a parent is `keccak256( min(a,b) ‖ max(a,b) )` (the COMMUTATIVE /
 * sorted pair — proofs carry only sibling hashes, no left/right flags). An odd
 * node at a level is PROMOTED unchanged to the next level (no self-pairing, no
 * zero-padding — both are incompatible with the verifier). A single-leaf tree's
 * root IS that leaf.
 *
 * ⚠ This is `@openzeppelin/contracts` `MerkleProof.sol`-VERIFIABLE (the on-chain
 * verifier folds with the same commutative keccak), which is what NFR-4
 * graduation needs. It is deliberately NOT the layout produced by the
 * `@openzeppelin/merkle-tree` JS builder (which uses a complete 2n-1 tree array
 * and would yield a DIFFERENT root/proofs for the same leaves). Do NOT "fix"
 * this to call that library — the §1.10.1 algorithm above is the single source
 * of truth and is frozen by golden vectors.
 *
 * S1.1 · 2026-06-07 · mibera-badge-surface.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A lowercase `0x`-prefixed hex string. 32-byte values are 66 chars. */
export type Hex = `0x${string}`;

/** The eligibility inputs that derive one merkle leaf (§1.10.1 / §1.10.4). */
export interface MerkleLeafInput {
  /** EVM address, any case, `0x`-prefixed. Normalized to lowercase 20 bytes. */
  readonly wallet: string;
  /** The snapshot identifier (utf8); binds the leaf to THIS snapshot. */
  readonly snapshotId: string;
  /** The badge family identifier (utf8); binds the leaf to THIS family. */
  readonly badgeFamilyId: string;
}

/** A built merkle tree: its canonical leaf set, root, and a proof accessor. */
export interface MerkleTree {
  /** The merkle root, `0x`-prefixed lowercase hex. */
  readonly root: Hex;
  /** Deduplicated leaf hashes, sorted ascending by 32-byte value. */
  readonly leaves: readonly Hex[];
  /** All levels bottom→top (`levels[0]` = leaves, last = `[root]`). Exposed for golden-vector cross-validation. */
  readonly levels: readonly (readonly Hex[])[];
  /**
   * The proof for `leaf` (a member leaf hash): ordered sibling hashes from leaf
   * to root. Throws if `leaf` is not a member of this tree.
   */
  proofFor(leaf: Hex): Hex[];
}

// ---------------------------------------------------------------------------
// Low-level helpers (exported for golden-vector cross-validation)
// ---------------------------------------------------------------------------

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `0x`-prefix a noble lowercase hex string. */
const toHex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}`;

/** Decode a `0x`-prefixed hex string to bytes. */
const fromHex = (hex: string): Uint8Array => hexToBytes(hex.slice(2));

/** Keccak-256 of raw bytes → `0x`-prefixed lowercase hex. */
export function keccakHex(bytes: Uint8Array): Hex {
  return toHex(keccak_256(bytes));
}

/**
 * Normalize an EVM address to its 20 raw bytes per §1.10.4: validate the
 * `0x`+40-hex shape, lowercase (EIP-55 checksum stripped), decode to 20 bytes.
 * Throws on a non-conforming wallet (fail-fast — ingest rejects at 422, never
 * silently drops).
 */
export function normalizeWallet(wallet: string): Uint8Array {
  if (!ADDRESS.test(wallet)) {
    throw new Error(`merkle: invalid EVM address: ${JSON.stringify(wallet)}`);
  }
  return fromHex(wallet.toLowerCase());
}

/**
 * The commutative sorted-pair parent hash: `keccak256( min(a,b) ‖ max(a,b) )`
 * over the two 32-byte values (byte-wise comparison). Order-independent — this
 * is exactly what `MerkleProof.sol` folds with.
 */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = fromHex(a);
  const y = fromHex(b);
  const ab = compareBytes(x, y) <= 0 ? concatBytes(x, y) : concatBytes(y, x);
  return keccakHex(ab);
}

/** Byte-wise lexicographic comparison of two equal-or-unequal-length buffers. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!; // i < n ≤ a.length
    const bi = b[i]!; // i < n ≤ b.length
    if (ai !== bi) return ai - bi;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Leaf
// ---------------------------------------------------------------------------

/**
 * Derive the merkle leaf for one eligibility tuple (§1.10.1). Pure; throws on a
 * malformed wallet.
 */
export function merkleLeaf(input: MerkleLeafInput): Hex {
  const wallet20 = normalizeWallet(input.wallet);
  const snapshotH = keccak_256(utf8(input.snapshotId));
  const familyH = keccak_256(utf8(input.badgeFamilyId));
  // abi.encodePacked(address, bytes32, bytes32) = 20 + 32 + 32 = 84 bytes.
  const packed = concatBytes(wallet20, snapshotH, familyH);
  // Double-hash (2nd-preimage resistance).
  return keccakHex(keccak_256(packed));
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * Build the sorted-pair merkle tree (§1.10.1) over a set of leaf hashes.
 * Deduplicates, sorts ascending by 32-byte value, then folds level-by-level
 * with odd-node promotion. Throws on an empty set or a malformed leaf.
 */
export function buildMerkleTree(rawLeaves: readonly Hex[]): MerkleTree {
  if (rawLeaves.length === 0) {
    throw new Error("merkle: cannot build a tree from zero leaves");
  }
  for (const leaf of rawLeaves) {
    if (!HEX32.test(leaf)) {
      throw new Error(`merkle: leaf is not 0x+64 lowercase hex: ${JSON.stringify(leaf)}`);
    }
  }

  // Dedupe + sort ascending by 32-byte value — canonical shape.
  const sorted = [...new Set(rawLeaves)].sort((a, b) =>
    compareBytes(fromHex(a), fromHex(b)),
  );

  const levels: Hex[][] = [sorted];
  let current: Hex[] = sorted;
  while (current.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!; // i < length
      const right = current[i + 1]; // undefined ⇒ odd node
      next.push(right === undefined ? left : hashPair(left, right)); // promote-or-pair
    }
    levels.push(next);
    current = next;
  }

  const root = current[0]!; // current.length === 1 here

  const proofFor = (leaf: Hex): Hex[] => {
    let index = sorted.indexOf(leaf);
    if (index === -1) {
      throw new Error(`merkle: leaf is not a member of this tree: ${leaf}`);
    }
    const proof: Hex[] = [];
    for (let level = 0; level < levels.length - 1; level++) {
      const nodes = levels[level]!;
      const isRight = index % 2 === 1;
      const siblingIndex = isRight ? index - 1 : index + 1;
      const sibling = nodes[siblingIndex];
      if (sibling !== undefined) {
        proof.push(sibling);
      }
      // else: this node is the odd one out (promoted) — no sibling at this level.
      index = Math.floor(index / 2);
    }
    return proof;
  };

  return { root, leaves: sorted, levels, proofFor };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Fold `leaf` up `proof` with the commutative parent hash and assert the result
 * equals `root` (§1.10.1). Fail-CLOSED: any structurally-malformed input
 * (non-32-byte leaf/root/proof element) returns `false` rather than throwing —
 * a grader facing attacker-supplied proofs denies, it does not crash.
 */
export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  if (!HEX32.test(leaf) || !HEX32.test(root)) return false;
  let computed: Hex = leaf;
  for (const sibling of proof) {
    if (!HEX32.test(sibling)) return false;
    computed = hashPair(computed, sibling);
  }
  return computed === root;
}
