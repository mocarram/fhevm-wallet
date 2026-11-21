/**
 * The two values the wallet needs from the relayer SDK's network configs without loading
 * the SDK itself (about 200 ms and a WebAssembly module at start-up): the ACL contract
 * and the relayer URL. A unit test checks they match `SepoliaConfig` / `MainnetConfig`
 * of the installed SDK, so an SDK upgrade that moves them fails the build.
 */

import type { NetworkName } from '../network/NetworkConfig.js';

/** ACL contract and relayer URL per network (from @zama-fhe/relayer-sdk 0.4.x). */
export const RELAYER_NETWORKS: Record<
  NetworkName,
  { aclContractAddress: string; relayerUrl: string }
> = {
  sepolia: {
    aclContractAddress: '0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D',
    relayerUrl: 'https://relayer.testnet.zama.org',
  },
  mainnet: {
    aclContractAddress: '0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6',
    relayerUrl: 'https://relayer.mainnet.zama.org',
  },
};
