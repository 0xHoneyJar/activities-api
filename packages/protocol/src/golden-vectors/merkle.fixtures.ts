/**
 * B1 merkle + snapshot-signature golden vectors — the CRITICAL-870 firebreak
 * (SDD §1.10.3 · S1.2). Pinned to the B1 `act_donationraffle` activity /
 * `donation-raffle` badge family.
 *
 * These values are FROZEN constants. They were generated and cross-validated by
 * `packages/engine/scripts/gen-merkle-fixture.ts`, which computes every leaf,
 * node, root, and proof TWO independent ways — the engine implementation
 * (`@noble/hashes` keccak) AND the `ethers` EVM reference (a different keccak
 * implementation + a separately-written tree) — and refuses to emit unless they
 * agree. Both `packages/protocol` and `packages/engine` CI consume this fixture:
 *   - protocol asserts structural invariants WITHOUT a keccak dependency;
 *   - engine asserts its live `merkle.ts` / `snapshot-sig.ts` reproduce every
 *     value AND re-runs the independent ethers oracle (`merkle.golden.test.ts`).
 *
 * Any divergence between the two implementations fails 100% of B1 grants as
 * indistinguishable `NEEDS_HUMAN` denies (CRITICAL-870) — this fixture is the
 * single artifact that makes such drift loud.
 *
 * NB: `activity_id` / `snapshot_id` honor the `^act_[a-z0-9]+$` / `^snap_[a-z0-9]+$`
 * branded-id patterns (no separators after the prefix); `badge_family_id` is an
 * unbranded string, so the readable hyphen is allowed there.
 *
 * S1.2 · 2026-06-07 · mibera-badge-surface (ids corrected to schema-valid form S1.3).
 */

export type Hex = `0x${string}`;

/**
 * Known-answer test: the keccak-256 of the empty input. This is the EVM/Solidity
 * keccak256 value — it DIFFERS from NIST SHA3-256's empty digest
 * (`0xa7ffc6f8…`). Asserting the engine hash reproduces this proves the correct
 * keccak variant is wired (the CRITICAL-870 "keccak vs SHA3 vs SHA-256" trap).
 */
export const KECCAK256_EMPTY: Hex =
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

export interface MerkleGoldenLeaf {
  readonly sorted_index: number;
  /** Normalized (lowercase) eligibility wallet. */
  readonly wallet: string;
  readonly leaf_hash: Hex;
  /** Ordered sibling hashes, leaf → root (§1.10.1). */
  readonly proof: readonly Hex[];
}

export interface MerkleSnapshotGoldenVector {
  // ── B1 binding context (§1.10.2) ──
  readonly activity_id: string;
  readonly badge_family_id: string;
  readonly snapshot_id: string;
  readonly environment_id: "production" | "staging";
  readonly created_at: string;
  readonly signer_key_id: string;
  /** Ed25519 public key for `signer_key_id`, `0x`+64-hex. */
  readonly signer_pubkey: Hex;
  // ── Merkle (§1.10.1) ──
  readonly merkle_root: Hex;
  readonly leaf_count: number;
  /** Deduplicated leaf hashes, sorted ascending by 32-byte value. */
  readonly sorted_leaf_hashes: readonly Hex[];
  /** All tree levels bottom→top (`levels[0]` = leaves, last = `[root]`). */
  readonly levels: readonly (readonly Hex[])[];
  readonly leaves: readonly MerkleGoldenLeaf[];
  // ── Signature (§1.10.2) ──
  /** The exact canonical signed-message bytes, hex-encoded. */
  readonly sig_message_hex: Hex;
  /** Ed25519 signature over `sig_message_hex` by `signer_key_id`. */
  readonly root_signature: Hex;
}

/**
 * The main B1 vector: 5 wallets (odd count ⇒ exercises odd-node promotion at
 * multiple levels: 5 → 3 → 2 → 1).
 */
export const B1_MERKLE_GOLDEN: MerkleSnapshotGoldenVector = {
  activity_id: "act_donationraffle",
  badge_family_id: "donation-raffle",
  snapshot_id: "snap_donationraffle2026q2",
  environment_id: "production",
  created_at: "2026-06-07T00:00:00Z",
  signer_key_id: "op-badge-ed25519-2026-06",
  signer_pubkey: "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664",
  merkle_root: "0xecf25c59fc28f4304873e2854c14c4855b99905a166a6f9012a059128d5e8156",
  leaf_count: 5,
  sorted_leaf_hashes: [
    "0x071d776f27427aa8b319af296842a16577d4ded28b762190318afa656a39f2ab",
    "0x14da7cc85b19bece62f7e100308b99ea876d0b342cf0225d072a736fc74f3c9c",
    "0x3f00f87be212fc1b575529a59aea9678b1f8faf42a608240c592ab8f7cdab488",
    "0xc07206b31671842fd292584e6c4eb911a5b648dd99b7a86668f93a7884978f11",
    "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
  ],
  levels: [
    [
      "0x071d776f27427aa8b319af296842a16577d4ded28b762190318afa656a39f2ab",
      "0x14da7cc85b19bece62f7e100308b99ea876d0b342cf0225d072a736fc74f3c9c",
      "0x3f00f87be212fc1b575529a59aea9678b1f8faf42a608240c592ab8f7cdab488",
      "0xc07206b31671842fd292584e6c4eb911a5b648dd99b7a86668f93a7884978f11",
      "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
    ],
    [
      "0xfacedf6f264e759db39b9fba36f60f18008faca572e385f87270ef36730be841",
      "0xe32b5c2d5a549796e78165cbb5211680ab58865ccc0caee3e2248f22eb2d6d62",
      "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
    ],
    [
      "0x6ff8b9cd3b5fd7863b3eaeeaa3b6cd236cba08e486c2ca744df0f9ba45728013",
      "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
    ],
    ["0xecf25c59fc28f4304873e2854c14c4855b99905a166a6f9012a059128d5e8156"],
  ],
  leaves: [
    {
      sorted_index: 0,
      wallet: "0x5555555555555555555555555555555555555555",
      leaf_hash: "0x071d776f27427aa8b319af296842a16577d4ded28b762190318afa656a39f2ab",
      proof: [
        "0x14da7cc85b19bece62f7e100308b99ea876d0b342cf0225d072a736fc74f3c9c",
        "0xe32b5c2d5a549796e78165cbb5211680ab58865ccc0caee3e2248f22eb2d6d62",
        "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
      ],
    },
    {
      sorted_index: 1,
      wallet: "0x4444444444444444444444444444444444444444",
      leaf_hash: "0x14da7cc85b19bece62f7e100308b99ea876d0b342cf0225d072a736fc74f3c9c",
      proof: [
        "0x071d776f27427aa8b319af296842a16577d4ded28b762190318afa656a39f2ab",
        "0xe32b5c2d5a549796e78165cbb5211680ab58865ccc0caee3e2248f22eb2d6d62",
        "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
      ],
    },
    {
      sorted_index: 2,
      wallet: "0x2222222222222222222222222222222222222222",
      leaf_hash: "0x3f00f87be212fc1b575529a59aea9678b1f8faf42a608240c592ab8f7cdab488",
      proof: [
        "0xc07206b31671842fd292584e6c4eb911a5b648dd99b7a86668f93a7884978f11",
        "0xfacedf6f264e759db39b9fba36f60f18008faca572e385f87270ef36730be841",
        "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
      ],
    },
    {
      sorted_index: 3,
      wallet: "0x3333333333333333333333333333333333333333",
      leaf_hash: "0xc07206b31671842fd292584e6c4eb911a5b648dd99b7a86668f93a7884978f11",
      proof: [
        "0x3f00f87be212fc1b575529a59aea9678b1f8faf42a608240c592ab8f7cdab488",
        "0xfacedf6f264e759db39b9fba36f60f18008faca572e385f87270ef36730be841",
        "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
      ],
    },
    {
      sorted_index: 4,
      wallet: "0x1111111111111111111111111111111111111111",
      leaf_hash: "0xf23f72e3398dd4cc374007b2764bec7ad3d9003f66522090be7a62ad2bfb45d2",
      proof: ["0x6ff8b9cd3b5fd7863b3eaeeaa3b6cd236cba08e486c2ca744df0f9ba45728013"],
    },
  ],
  sig_message_hex:
    "0x66726565736964652d62616467652d736e617073686f743a76311f736e61705f646f6e6174696f6e726166666c653230323671321f646f6e6174696f6e2d726166666c651f6163745f646f6e6174696f6e726166666c651f70726f64756374696f6e1f3078656366323563353966633238663433303438373365323835346331346334383535623939393035613136366136663930313261303539313238643565383135361f351f323032362d30362d30375430303a30303a30305a1f6f702d62616467652d656432353531392d323032362d3036",
  root_signature:
    "0xb87d5996ecc942fef29fc7f985408aa54ffd555246aa7509102715b67ae7c2c9740b7f6a9841c8d779441a9a058f64736c85090a8819b412c6111b334d13ab0b",
};

export interface MerkleSingleLeafGoldenVector {
  readonly wallet: string;
  readonly leaf_hash: Hex;
  /** For a single-leaf tree the root IS the leaf (§1.10.1). */
  readonly merkle_root: Hex;
}

/** Single-leaf edge case: root === leaf, proof === []. */
export const B1_MERKLE_SINGLE_LEAF: MerkleSingleLeafGoldenVector = {
  wallet: "0x9999999999999999999999999999999999999999",
  leaf_hash: "0xb55764b988e36c4ac72e63b0c5706b9e6c49ced2a5aa0ef85ec2883ad1a9f384",
  merkle_root: "0xb55764b988e36c4ac72e63b0c5706b9e6c49ced2a5aa0ef85ec2883ad1a9f384",
};

/**
 * An Ed25519 signature made over the SAME context but with `environment_id`
 * = "staging". Presented against the production context (`B1_MERKLE_GOLDEN`) it
 * MUST fail to verify — the HIGH-780 staging→production replay block. More
 * generally it is a "signature over a different message" — covering the
 * reordered/tampered-field failure class.
 */
export const B1_STAGING_REPLAY_SIGNATURE: Hex =
  "0xf4f6464f69b8010262441adb1ca1eb6edeab8d46cdf052cdf634e1d512c0eb2d93effd415dde4639751b3aa9b1842c298adc2889c042baf9036527ec7ab5d30f";

/**
 * A well-formed Ed25519 public key that is NOT the signer's — the "unknown /
 * wrong signer key" failure class. Verifying `root_signature` under this key
 * MUST fail.
 */
export const B1_WRONG_SIGNER_PUBKEY: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
