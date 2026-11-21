/**
 * Saving custom RPC endpoints, shared by `fhew config` and the interactive Settings screen.
 */

import { NETWORK_CONFIGS, NetworkName } from './NetworkConfig.js';
import { assertRpcChain, clearProviderForNetwork, RpcProbe } from './ProviderFactory.js';
import { saveEnvVar } from '../../storage/paths.js';
import { clearFheInstanceCache } from '../fhe/FheService.js';

/** The `.env` variable that holds each network's custom RPC URL. */
export const RPC_ENV_KEYS: Record<NetworkName, string> = {
  mainnet: 'MAINNET_RPC_URL',
  sepolia: 'SEPOLIA_RPC_URL',
};

// Pure check, kept with the other validators so storage can use it without importing
// the network stack. Re-exported here for existing callers.
export { validateRpcUrl } from '../../utils/validation.js';
import { validateRpcUrl } from '../../utils/validation.js';

/**
 * Check the endpoint serves the right chain, then save it and drop cached clients
 * so the next call uses the new URL. Throws with a user-readable message on failure.
 */
export async function setCustomRpc(network: NetworkName, input: string): Promise<RpcProbe> {
  const url = input.trim();
  const problem = validateRpcUrl(url);
  if (problem) throw new Error(problem);

  const probe = await assertRpcChain(url, NETWORK_CONFIGS[network].chainId);
  saveEnvVar(RPC_ENV_KEYS[network], url);
  clearProviderForNetwork(network);
  clearFheInstanceCache(NETWORK_CONFIGS[network].chainId);
  return probe;
}
