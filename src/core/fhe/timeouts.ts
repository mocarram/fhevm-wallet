/**
 * Relayer SDK time limits. Encryption builds a zero-knowledge proof and decryption waits
 * for the gateway, so these are generous; they exist so a dead relayer cannot hang the UI.
 * Kept in their own module so tests that mock FheService still get real values.
 */

/** Creating the SDK instance (fetches public keys and contract config). */
export const FHE_INIT_TIMEOUT_MS = 60_000;

/** One encryption or one user-decryption round trip. */
export const FHE_OPERATION_TIMEOUT_MS = 120_000;
