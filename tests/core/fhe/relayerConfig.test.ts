import { describe, expect, it } from 'vitest';
import { MainnetConfig, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import { RELAYER_NETWORKS } from '../../../src/core/fhe/relayerConfig.js';

describe('RELAYER_NETWORKS', () => {
  it('matches the installed relayer SDK (so start-up need not load it)', () => {
    expect(RELAYER_NETWORKS.sepolia).toEqual({
      aclContractAddress: SepoliaConfig.aclContractAddress,
      relayerUrl: SepoliaConfig.relayerUrl,
    });
    expect(RELAYER_NETWORKS.mainnet).toEqual({
      aclContractAddress: MainnetConfig.aclContractAddress,
      relayerUrl: MainnetConfig.relayerUrl,
    });
  });
});
