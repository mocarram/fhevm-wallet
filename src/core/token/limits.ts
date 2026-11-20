/**
 * Numeric limits of ERC-7984 tokens, in a dependency-free module so pure code (amount
 * parsing, the TUI) can use them without loading ethers contracts or the relayer SDK.
 */

/** Encrypted amounts are `euint64`: the largest value a transfer can carry, in base units. */
export const MAX_EUINT64 = 2n ** 64n - 1n;
