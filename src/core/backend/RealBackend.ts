/**
 * Backend for the real networks: a thin adapter over the existing core modules
 * (TokenService, ProviderFactory, rpcSettings, historySync). It adds no behaviour of its
 * own, so the safety rules documented in AGENTS.md (sign locally first, SENT_UNCONFIRMED
 * after broadcast, balance checks) keep applying unchanged.
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import { NETWORK_CONFIGS, getRpcUrls, usesPublicRpc } from '../network/NetworkConfig.js';
import {
  describeProbeFailure,
  getProvider,
  probeRpc,
  RPC_PROBE_TIMEOUT_MS,
  RpcNoRealAnswerError,
} from '../network/ProviderFactory.js';
import { RELAYER_NETWORKS } from '../fhe/relayerConfig.js';
import { maskUrl } from '../../utils/redact.js';
import { setCustomRpc } from '../network/rpcSettings.js';
import { checkFheReadiness, warmUpFheInstance } from '../fhe/FheService.js';
import { DecryptSession, decryptDaysFromEnv, normaliseHandle } from '../fhe/DecryptSession.js';
import { publicDecryptHandle, relayerDecryptAuthority } from '../fhe/DecryptionService.js';
import {
  decryptBalancesWithSession,
  filterUserDecryptable,
  findAmountDisclosed,
  findTransferHandle,
  getDecryptedBalance,
  getTokenInfo,
  getTxExplorerUrl,
  isOperator,
  isPubliclyDecryptable,
  prepareConfidentialTransfer,
  prepareDiscloseAmount,
  prepareDiscloseRequest,
  prepareSetOperator,
  type PreparedCall,
} from '../token/TokenService.js';
import { getAmountEntry, setCachedAmounts } from '../../storage/AmountCache.js';
import { syncTransactions } from '../token/historySync.js';
import { checkErc7984, type TokenCheck } from '../token/erc7984Check.js';
import {
  pendingPublicDecryption,
  WalletTxError,
  translateTxError,
  type DiscloseRequestOptions,
} from '../token/txErrors.js';
import { knownTokens } from '../token/tokenLists.js';
import {
  PUBLIC_SCAN_WINDOW,
  scanIncoming,
  SCAN_START_BLOCK,
  type ScanOptions,
  type ScanResult,
} from '../token/tokenScan.js';
import { loadConfig } from '../../storage/ConfigStore.js';
import { RealWrapOps } from './realWrap.js';
import type { TokenEntry } from '../token/TokenRegistry.js';
import type {
  AmountRequest,
  Backend,
  BalanceBatch,
  DiscloseStage,
  HistorySyncResult,
  PreparedDisclose,
  PreparedSend,
  RelayerCheck,
  PreparedTx,
  RpcCheck,
  RpcEndpointCheck,
  UnlockedSigner,
} from './types.js';

/** How long the relayer has to answer the doctor's reachability probe. */
const RELAYER_PROBE_TIMEOUT_MS = 8_000;
/** The Zama ACL contract for a network (from the relayer SDK's network config). */
function aclAddress(network: NetworkName): string {
  return RELAYER_NETWORKS[network].aclContractAddress;
}

/** Adapt a TokenService PreparedCall to the Backend's PreparedTx. */
function toPreparedTx(p: PreparedCall): PreparedTx {
  return {
    feeWei: p.feeWei,
    ethBalanceWei: p.ethBalanceWei,
    send: async (hooks) => {
      const r = await p.send(hooks);
      return { txHash: r.txHash, blockNumber: r.receipt.blockNumber };
    },
  };
}

/**
 * Refuse a new step 2 while an earlier one is still pending: it is in a mempool and
 * would be mined as well, paying twice. A mined or unknown one is handled elsewhere.
 */
async function refuseIfDisclosurePending(network: NetworkName, handle: string): Promise<void> {
  const hash = getAmountEntry(network, handle)?.discloseTx;
  if (!hash) return;
  const provider = getProvider(network);
  const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
  if (receipt) return; // mined (a revert may be retried; success is caught by the stage)
  const pending = await provider.getTransaction(hash).catch(() => null);
  if (!pending) return; // dropped or never arrived: sending again is safe
  throw new WalletTxError(
    'SENT_UNCONFIRMED',
    'A disclosure of this amount was already sent and is not confirmed yet.',
    'The earlier transaction is still waiting to be mined.',
    `Do not send it again. Check ${getTxExplorerUrl(hash, network)} and try later.`,
    '',
    hash,
  );
}

/** Delegates every call to the production code paths. */
export class RealBackend implements Backend {
  readonly kind = 'real' as const;

  readinessProblem(network: NetworkName): string | null {
    return checkFheReadiness(network);
  }

  async getEthBalance(address: string, network: NetworkName): Promise<bigint> {
    return getProvider(network).getBalance(address);
  }

  getTokenInfo(tokenAddress: string, network: NetworkName) {
    return getTokenInfo(tokenAddress, network);
  }

  async checkToken(tokenAddress: string, network: NetworkName): Promise<TokenCheck> {
    const provider = getProvider(network);
    try {
      return await checkErc7984((to, data) => provider.call({ to, data }), tokenAddress);
    } catch (err) {
      throw translateTxError(err, { action: 'token check' });
    }
  }

  decryptBalance(
    tokenAddress: string,
    signer: UnlockedSigner,
    network: NetworkName,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<bigint> {
    return getDecryptedBalance(tokenAddress, signer, network, opts);
  }

  newDecryptSession(signer: UnlockedSigner, network: NetworkName): DecryptSession {
    // An unlocked wallet will encrypt or decrypt soon: build the relayer instance (about
    // 4 s) in the background now instead of on the first balance or send.
    if (!checkFheReadiness(network)) warmUpFheInstance(network);
    return new DecryptSession(signer, network, relayerDecryptAuthority(network), {
      durationDays: decryptDaysFromEnv(),
    });
  }

  decryptBalances(
    session: DecryptSession,
    tokens: string[],
    opts: { forceRefresh?: boolean } = {},
  ): Promise<BalanceBatch> {
    return decryptBalancesWithSession(session, tokens, session.network, opts);
  }

  async decryptAmounts(
    session: DecryptSession,
    requests: AmountRequest[],
    contracts: string[],
  ): Promise<Record<string, bigint | null>> {
    const out: Record<string, bigint | null> = {};
    if (!requests.length) return out;
    const pairs = requests.map((r) => ({
      handle: normaliseHandle(r.handle),
      contractAddress: r.token,
    }));
    // The SDK fails a whole batch when one handle is not allowed for this wallet; check
    // the ACL first so those show as "encrypted" and the rest still decrypt.
    const allowed = await filterUserDecryptable(
      aclAddress(session.network),
      pairs,
      session.address,
      session.network,
    );
    for (const p of pairs) if (!allowed.has(p.handle)) out[p.handle] = null;
    const { values } = await session.decrypt(
      pairs.filter((p) => allowed.has(p.handle)),
      contracts,
    );
    for (const [h, v] of values) out[h] = v;
    return out;
  }

  async operatorStatus(
    tokenAddress: string,
    holder: string,
    spenders: string[],
    network: NetworkName,
  ): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      spenders.map(
        async (sp) =>
          [sp.toLowerCase(), await isOperator(tokenAddress, holder, sp, network)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async prepareSetOperator(
    signer: UnlockedSigner,
    tokenAddress: string,
    operator: string,
    untilUnixSeconds: number,
    network: NetworkName,
  ): Promise<PreparedTx> {
    return toPreparedTx(
      await prepareSetOperator(signer, tokenAddress, operator, untilUnixSeconds, network),
    );
  }

  async discloseStage(
    tokenAddress: string,
    handle: string,
    network: NetworkName,
  ): Promise<DiscloseStage> {
    const h = normaliseHandle(handle);
    const entry = getAmountEntry(network, h);
    if (entry?.disclosed) return 'disclosed';
    // A step 2 sent earlier that ended SENT_UNCONFIRMED: was it mined after all?
    if (entry?.discloseTx) {
      const receipt = await getProvider(network)
        .getTransactionReceipt(entry.discloseTx)
        .catch(() => null);
      if (receipt?.status === 1) {
        setCachedAmounts(network, [{ handle: h, value: BigInt(entry.value), disclosed: true }]);
        return 'disclosed';
      }
    }
    if (!(await isPubliclyDecryptable(aclAddress(network), handle, network))) return 'private';
    // Step 1 is done. Someone (this wallet on another machine, or a step 2 whose result
    // we never saw) may have finished step 2: look for its AmountDisclosed log in recent
    // blocks, so a rerun does not send step 2 again.
    const value = await findAmountDisclosed(tokenAddress, h, network).catch(() => null);
    if (value !== null) {
      setCachedAmounts(network, [{ handle: h, value, disclosed: true }]);
      return 'disclosed';
    }
    return 'requested';
  }

  async prepareDiscloseRequest(
    signer: UnlockedSigner,
    tokenAddress: string,
    handle: string,
    network: NetworkName,
    opts?: DiscloseRequestOptions,
  ): Promise<PreparedTx> {
    return toPreparedTx(await prepareDiscloseRequest(signer, tokenAddress, handle, network, opts));
  }

  async prepareDisclose(
    signer: UnlockedSigner,
    tokenAddress: string,
    handle: string,
    network: NetworkName,
  ): Promise<PreparedDisclose> {
    if (!(await isPubliclyDecryptable(aclAddress(network), handle, network))) {
      throw pendingPublicDecryption();
    }
    let pub;
    try {
      pub = await publicDecryptHandle(normaliseHandle(handle), network);
    } catch (err) {
      throw pendingPublicDecryption(err instanceof Error ? err.message : String(err));
    }
    const h = normaliseHandle(handle);
    await refuseIfDisclosurePending(network, h);
    const prepared = await prepareDiscloseAmount(
      signer,
      tokenAddress,
      handle,
      pub.value,
      pub.proof,
      network,
    );
    const tx = toPreparedTx(prepared);
    return {
      ...tx,
      value: pub.value,
      // Remember the signed hash before broadcasting: if the result is never seen, the
      // next attempt checks it instead of sending step 2 a second time.
      send: (hooks) =>
        tx.send({
          ...hooks,
          onSigned: (txHash) => {
            try {
              setCachedAmounts(network, [{ handle: h, value: pub.value, discloseTx: txHash }]);
            } catch {
              /* bookkeeping only */
            }
            hooks?.onSigned?.(txHash);
          },
        }),
    };
  }

  async findTransferHandle(
    txHash: string,
    wallet: string,
    tokens: string[],
    network: NetworkName,
  ): Promise<AmountRequest | null> {
    return findTransferHandle(txHash, wallet, tokens, network);
  }

  async prepareTransfer(
    signer: UnlockedSigner,
    tokenAddress: string,
    to: string,
    amount: bigint,
    network: NetworkName,
    opts: { session?: DecryptSession } = {},
  ): Promise<PreparedSend> {
    const prepared = await prepareConfidentialTransfer(
      signer,
      tokenAddress,
      to,
      amount,
      network,
      opts,
    );
    return {
      feeWei: prepared.feeWei,
      ethBalanceWei: prepared.ethBalanceWei,
      tokenBalance: prepared.tokenBalance,
      send: async (hooks) => {
        const r = await prepared.send(hooks);
        return {
          txHash: r.txHash,
          blockNumber: r.receipt.blockNumber,
          balanceCheck: r.balanceCheck,
          balanceAfter: r.balanceAfter,
        };
      },
    };
  }

  async syncHistory(
    address: string,
    network: NetworkName,
    tokens: TokenEntry[],
  ): Promise<HistorySyncResult> {
    // Etherscan is much faster when a key is set; otherwise scan RPC logs.
    const method = process.env.ETHERSCAN_API_KEY ? 'etherscan' : 'rpc';
    const r = await syncTransactions(address, network, tokens, method);
    return { newCount: r.added, method, ...(r.notice ? { notice: r.notice } : {}) };
  }

  async checkRpc(network: NetworkName): Promise<RpcCheck> {
    const url = getRpcUrls(network)[0];
    const probe = await probeRpc(url);
    return { ...probe, url, chainMatches: probe.chainId === NETWORK_CONFIGS[network].chainId };
  }

  knownTokens(network: NetworkName, opts: { refresh?: boolean } = {}) {
    return knownTokens(network, { url: loadConfig().tokenListUrl, refresh: opts.refresh });
  }

  async scanReceivedTokens(
    address: string,
    network: NetworkName,
    opts: Omit<ScanOptions, 'toBlock'>,
  ): Promise<ScanResult> {
    const provider = getProvider(network);
    // The built-in public endpoints refuse or cap topic-only log queries (publicnode:
    // "specify an address"; nodies: 50 blocks), so scan only a recent window there.
    const recentWindow = opts.recentOnly && usesPublicRpc(network) ? PUBLIC_SCAN_WINDOW : undefined;
    const result = await scanIncoming(provider, address, { ...opts, recentWindow });
    if (result.error) result.error = translateTxError(result.error, { action: 'token scan' });
    return result;
  }

  scanStartBlock(network: NetworkName): number {
    return SCAN_START_BLOCK[network];
  }

  async checkRpcEndpoints(network: NetworkName): Promise<RpcEndpointCheck[]> {
    const expected = NETWORK_CONFIGS[network].chainId;
    return Promise.all(
      getRpcUrls(network).map(async (url): Promise<RpcEndpointCheck> => {
        try {
          const p = await probeRpc(url, RPC_PROBE_TIMEOUT_MS, { withBlockNumber: true });
          const chainMatches = p.chainId === expected;
          return {
            url: maskUrl(url),
            ok: chainMatches,
            chainId: p.chainId,
            chainMatches,
            latencyMs: p.latencyMs,
            blockNumber: p.blockNumber,
            error: chainMatches ? undefined : `It serves chain ${p.chainId}, not ${network}.`,
          };
        } catch (err) {
          return {
            url: maskUrl(url),
            ok: false,
            error: err instanceof RpcNoRealAnswerError ? err.message : describeProbeFailure(err),
          };
        }
      }),
    );
  }

  async checkRelayer(network: NetworkName): Promise<RelayerCheck> {
    const base = RELAYER_NETWORKS[network].relayerUrl;
    // The key-URL endpoint the SDK fetches first; any HTTP answer means it is reachable.
    const url = `${base.replace(/\/$/, '')}/v1/keyurl`;
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(RELAYER_PROBE_TIMEOUT_MS) });
      void res.body?.cancel();
      return {
        url: maskUrl(base),
        ok: res.status < 500,
        status: res.status,
        latencyMs: Date.now() - started,
        error: res.status < 500 ? undefined : `It answered with HTTP ${res.status}.`,
      };
    } catch {
      return { url: maskUrl(base), ok: false, error: 'It did not answer. Check your connection.' };
    }
  }

  setCustomRpc(network: NetworkName, url: string) {
    return setCustomRpc(network, url);
  }

  suggestedTokens(): [] {
    // No token addresses are hard-coded for the real networks: the user pastes one, and
    // the wallet reads its name and symbol from the contract.
    return [];
  }

  explorerTxUrl(txHash: string, network: NetworkName): string {
    return getTxExplorerUrl(txHash, network);
  }

  // Wrap / unwrap (wrapTypes.ts), implemented in realWrap.ts.
  private readonly wrapOps = new RealWrapOps();
  wrapperInfo: RealWrapOps['wrapperInfo'] = (...a) => this.wrapOps.wrapperInfo(...a);
  wrapState: RealWrapOps['wrapState'] = (...a) => this.wrapOps.wrapState(...a);
  prepareWrap: RealWrapOps['prepareWrap'] = (...a) => this.wrapOps.prepareWrap(...a);
  prepareUnwrap: RealWrapOps['prepareUnwrap'] = (...a) => this.wrapOps.prepareUnwrap(...a);
  unwrapRequestStatus: RealWrapOps['unwrapRequestStatus'] = (...a) =>
    this.wrapOps.unwrapRequestStatus(...a);
  txOutcome: RealWrapOps['txOutcome'] = (...a) => this.wrapOps.txOutcome(...a);
  unwrapRequestId: RealWrapOps['unwrapRequestId'] = (...a) => this.wrapOps.unwrapRequestId(...a);
  prepareFinalizeUnwrap: RealWrapOps['prepareFinalizeUnwrap'] = (...a) =>
    this.wrapOps.prepareFinalizeUnwrap(...a);
  underlyingBalance: RealWrapOps['underlyingBalance'] = (...a) =>
    this.wrapOps.underlyingBalance(...a);
}
