/**
 * Wrap and unwrap on the real networks: chains the single transactions of
 * `src/core/token/wrapper.ts` into the flows the UI shows as one action.
 *
 * Wrap = [approve exactly the amount, when the allowance is short] → wrap. The wrap can
 * only be simulated once the approval is mined (its `transferFrom` would fail before), so
 * it is simulated right after that, and if it fails nothing more is sent
 * (WRAP_APPROVED_ONLY: wrapping again finds the allowance and only sends the wrap).
 *
 * Unwrap = request (burn + make the amount publicly decryptable) → public decryption
 * through the relayer → finalize (anyone may send it; the wallet does). The pending state
 * in between is kept by the caller (`unwrapPending.ts`), not here.
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import { RELAYER_NETWORKS } from '../fhe/relayerConfig.js';
import { normaliseHandle, type DecryptSession } from '../fhe/DecryptSession.js';
import { publicDecryptHandle } from '../fhe/DecryptionService.js';
import {
  checkBalanceAfter,
  getDecryptedBalance,
  isPubliclyDecryptable,
  type PreparedCall,
} from '../token/TokenService.js';
import { translateTxError, WalletTxError } from '../token/txErrors.js';
import { approvalPlan, needsReset } from '../token/wrapMath.js';
import {
  getMinedNonce,
  getTxOutcome,
  getUnderlyingBalance,
  getUnwrapRequestStatus,
  getWrapperInfo,
  getWrapState,
  prepareApprove,
  prepareFinalizeCall,
  prepareUnwrapCall,
  prepareWrapCall,
  requestIdFromLogs,
  unwrapAlreadyFinished,
  unwrapDecryptPending,
  type WrapperInfo,
} from '../token/wrapper.js';
import type { UnlockedSigner } from './types.js';
import type {
  PreparedFinalize,
  PreparedUnwrap,
  PreparedWrap,
  WrapBackend,
  WrapHooks,
  WrapResult,
  WrapStep,
} from './wrapTypes.js';

/**
 * Gas a step that cannot be simulated yet is priced at (measured on Sepolia, 2026-11-21:
 * cZAMA wrap 807k with its FHE operations, ZAMA approve 128k, finalize 410k–545k for the
 * KMS signature check). Only for the fee
 * shown before and the ETH check; the real limit comes from the simulation later.
 */
export const WRAP_GAS_ESTIMATE = 900_000n;
export const APPROVE_GAS_ESTIMATE = 150_000n;
export const FINALIZE_GAS_ESTIMATE = 650_000n;

/**
 * The Zama ACL contract for a network, from relayerConfig.ts: importing the SDK here
 * would load it (and its WebAssembly) at start-up for every command.
 */
function aclAddress(network: NetworkName): string {
  return RELAYER_NETWORKS[network].aclContractAddress;
}

/** Price per gas a prepared call was priced at. */
function priceOf(p: PreparedCall): bigint {
  return p.gasLimit > 0n ? p.feeWei / p.gasLimit : 0n;
}

/** Not enough ETH for every step of a flow (checked before anything is signed). */
function notEnoughEthForAll(what: string): WalletTxError {
  return new WalletTxError(
    'INSUFFICIENT_GAS_FUNDS',
    'Not enough ETH to pay the network fees.',
    `${what} takes more than one transaction, and this wallet cannot pay for all of them.`,
    'Add ETH to this wallet (on Sepolia, use a faucet) and try again. Nothing was sent.',
  );
}

/** The approval is mined, the wrap could not be sent. Wrapping again only sends the wrap. */
function approvedOnly(err: unknown, approveTxHash: string, what = 'approval'): WalletTxError {
  const e = translateTxError(err, { action: 'wrap' });
  return new WalletTxError(
    'WRAP_APPROVED_ONLY',
    `The ${what} went through, but the wrap was not sent.`,
    `${e.message} ${e.likelyCause} (${what}: ${approveTxHash})`,
    'Wrap again: the approval is in place, so only the wrap is sent.',
    e.raw,
  );
}

/** Real-network implementation of the wrap/unwrap backend methods. */
export class RealWrapOps implements WrapBackend {
  wrapperInfo(tokenAddress: string, network: NetworkName) {
    return getWrapperInfo(tokenAddress, network);
  }

  wrapState(info: WrapperInfo, owner: string, network: NetworkName) {
    return getWrapState(info, owner, network);
  }

  async prepareWrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    pull: bigint,
    network: NetworkName,
    opts: { session?: DecryptSession } = {},
  ): Promise<PreparedWrap> {
    const state = await getWrapState(info, signer.address, network);
    if (state.balance < pull) {
      throw new WalletTxError(
        'INSUFFICIENT_TOKEN_BALANCE',
        'That is more than this wallet holds.',
        `This wallet has less public ${info.underlying.symbol} than the amount.`,
        'Enter a smaller amount.',
      );
    }
    let steps: WrapStep[];
    let reset: PreparedCall | undefined;
    let approve: PreparedCall | undefined;
    let wrap: PreparedCall | undefined;
    let feeWei: bigint;
    let feeEstimated = false;
    if (approvalPlan(state.allowance, pull) === 'none') {
      wrap = await prepareWrapCall(signer, info, pull, network);
      steps = ['wrap'];
      feeWei = wrap.feeWei;
    } else {
      try {
        approve = await prepareApprove(signer, info, pull, network);
        steps = ['approve', 'wrap'];
      } catch (err) {
        // USDT-style tokens refuse changing one non-zero allowance to another: set it to
        // 0 first. Only then, and only when it was refused by the contract.
        const e = translateTxError(err, { action: 'approval' });
        if (!needsReset(state.allowance) || e.code !== 'CONTRACT_REJECTED') throw e;
        reset = await prepareApprove(signer, info, 0n, network);
        steps = ['reset', 'approve', 'wrap'];
      }
      const first = (approve ?? reset)!;
      const price = priceOf(first);
      feeWei =
        first.feeWei +
        (reset ? (APPROVE_GAS_ESTIMATE * price * 12n) / 10n : 0n) +
        (WRAP_GAS_ESTIMATE * price * 12n) / 10n;
      feeEstimated = true;
    }
    const ethBalanceWei = (wrap ?? approve ?? reset)!.ethBalanceWei;
    if (ethBalanceWei < feeWei) throw notEnoughEthForAll('Wrapping');

    let used = false;
    const send = async (hooks: WrapHooks = {}): Promise<WrapResult> => {
      if (used) throw new Error('This prepared wrap was already used.');
      used = true;
      const safe = (fn: () => void) => {
        try {
          fn();
        } catch {
          // progress hooks never fail a wrap
        }
      };
      const session = opts.session?.active ? opts.session : undefined;
      // Best-effort balance before, so the change can be shown (and a 0-mint noticed).
      const balanceBefore = await getDecryptedBalance(info.address, signer, network, {
        session,
      }).catch(() => undefined);
      let resetTxHash: string | undefined;
      let approveTxHash: string | undefined;
      if (reset) {
        safe(() => hooks.onStep?.('reset'));
        resetTxHash = (await reset.send(hooks)).txHash;
        safe(() => hooks.onStepConfirmed?.('reset', resetTxHash!));
        try {
          approve = await prepareApprove(signer, info, pull, network);
        } catch (err) {
          throw approvedOnly(err, resetTxHash, 'reset of the old approval');
        }
      }
      if (approve) {
        safe(() => hooks.onStep?.('approve'));
        approveTxHash = (await approve.send(hooks)).txHash;
        safe(() => hooks.onStepConfirmed?.('approve', approveTxHash!));
        try {
          wrap = await prepareWrapCall(signer, info, pull, network);
        } catch (err) {
          throw approvedOnly(err, approveTxHash);
        }
      }
      safe(() => hooks.onStep?.('wrap'));
      const r = await wrap!.send(hooks);
      safe(() => hooks.onStepConfirmed?.('wrap', r.txHash));
      const wrapped = pull / info.rate;
      let balanceCheck: WrapResult['balanceCheck'] = 'unknown';
      let balanceAfter: bigint | undefined;
      if (balanceBefore !== undefined) {
        // checkBalanceAfter tests `before − amount`; a wrap adds, so pass −wrapped.
        const c = await checkBalanceAfter(
          () =>
            getDecryptedBalance(info.address, signer, network, {
              forceRefresh: true,
              session: session?.active ? session : undefined,
              blockTag: r.receipt.blockNumber,
            }),
          balanceBefore,
          -wrapped,
        );
        balanceCheck = c.balanceCheck;
        balanceAfter = c.balanceAfter;
      }
      return {
        txHash: r.txHash,
        blockNumber: r.receipt.blockNumber,
        approveTxHash,
        resetTxHash,
        balanceCheck,
        balanceBefore,
        balanceAfter,
      };
    };
    return { steps, feeWei, feeEstimated, ethBalanceWei, state, send };
  }

  async prepareUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    amount: bigint,
    network: NetworkName,
    opts: { session?: DecryptSession } = {},
  ): Promise<PreparedUnwrap> {
    const { call, balance } = await prepareUnwrapCall(signer, info, amount, network, opts);
    const finalizeFeeWei = (FINALIZE_GAS_ESTIMATE * priceOf(call) * 12n) / 10n;
    // Both steps must be affordable: a request without its finish leaves the tokens
    // burnt and the ERC-20 not sent until ETH arrives.
    if (call.ethBalanceWei < call.feeWei + finalizeFeeWei) throw notEnoughEthForAll('Unwrapping');
    return {
      feeWei: call.feeWei,
      finalizeFeeWei,
      ethBalanceWei: call.ethBalanceWei,
      balance,
      send: async (hooks) => {
        const r = await call.send(hooks);
        return {
          txHash: r.txHash,
          blockNumber: r.receipt.blockNumber,
          requestId: requestIdFromLogs(r.receipt.logs, info.address, signer.address),
        };
      },
    };
  }

  unwrapRequestStatus(info: WrapperInfo, requestId: string, network: NetworkName) {
    return getUnwrapRequestStatus(info, requestId, network);
  }

  txOutcome(txHash: string, network: NetworkName) {
    return getTxOutcome(txHash, network);
  }

  minedNonce(address: string, network: NetworkName) {
    return getMinedNonce(address, network);
  }

  async unwrapRequestId(
    info: WrapperInfo,
    txHash: string,
    receiver: string,
    network: NetworkName,
  ): Promise<string | null> {
    const o = await getTxOutcome(txHash, network);
    return o.status === 'mined' ? requestIdFromLogs(o.logs, info.address, receiver) : null;
  }

  async prepareFinalizeUnwrap(
    signer: UnlockedSigner,
    info: WrapperInfo,
    requestId: string,
    network: NetworkName,
  ): Promise<PreparedFinalize> {
    const id = normaliseHandle(requestId);
    if ((await getUnwrapRequestStatus(info, id, network)) === 'finalized') {
      throw unwrapAlreadyFinished();
    }
    let publicNow: boolean;
    try {
      publicNow = await isPubliclyDecryptable(aclAddress(network), id, network);
    } catch (err) {
      throw translateTxError(err, { action: 'unwrap check' });
    }
    if (!publicNow) throw unwrapDecryptPending();
    let pub;
    try {
      pub = await publicDecryptHandle(id, network);
    } catch (err) {
      throw unwrapDecryptPending(err instanceof Error ? err.message : String(err));
    }
    const call = await prepareFinalizeCall(signer, info, id, pub.value, pub.proof, network);
    return {
      feeWei: call.feeWei,
      ethBalanceWei: call.ethBalanceWei,
      value: pub.value,
      receive: pub.value * info.rate,
      send: async (hooks) => {
        const r = await call.send(hooks);
        return { txHash: r.txHash, blockNumber: r.receipt.blockNumber };
      },
    };
  }

  underlyingBalance(info: WrapperInfo, owner: string, network: NetworkName) {
    return getUnderlyingBalance(info, owner, network).catch((err) => {
      throw translateTxError(err, { action: 'balance check' });
    });
  }
}
