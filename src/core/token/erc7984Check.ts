/**
 * Is this contract an ERC-7984 confidential token? Used when a token is added (CLI and
 * TUI), by `fhew doctor` for every tracked token, and to verify "Find tokens" results.
 *
 * Two independent checks:
 *
 * 1. ERC-165: `supportsInterface(ERC7984_INTERFACE_ID)`. OpenZeppelin's ERC7984 base
 *    contract has answered this since openzeppelin-confidential-contracts v0.3.0
 *    (2025-11-28). Older tokens have no ERC-165 at all, so a missing answer is not a
 *    failure; and a token built on a later revision of the interface would report a
 *    different id, so "supports ERC-165 but not this id" is a warning, not a refusal.
 * 2. Behaviour: name(), symbol() and decimals() decode like a token's, and
 *    confidentialBalanceOf(address) returns exactly 32 bytes (an encrypted balance
 *    handle). An ERC-20, an account or another kind of contract fails this.
 *
 * A token is accepted when check 2 passes. A transport failure (RPC down, timeout, rate
 * limit) is never read as "not ERC-7984": it is thrown for the caller to translate.
 */

import { getAddress, id, Interface } from 'ethers';
import { rpcErrorOf } from './txErrors.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './tokenText.js';
import type { TokenInfo } from './TokenService.js';

/**
 * The functions declared in OpenZeppelin's `IERC7984` (contracts/interfaces/IERC7984.sol,
 * identical in releases v0.3.0 to v0.5.3; source file sha256 2251186a…f5438e9 at v0.5.3).
 * Inherited `supportsInterface` is not part of the id, as in Solidity's
 * `type(IERC7984).interfaceId`. `euint64` and `externalEuint64` are user-defined value
 * types over bytes32, so they appear as `bytes32` in the ABI signatures.
 */
export const ERC7984_INTERFACE_FUNCTIONS = [
  'name()',
  'symbol()',
  'decimals()',
  'contractURI()',
  'confidentialTotalSupply()',
  'confidentialBalanceOf(address)',
  'isOperator(address,address)',
  'setOperator(address,uint48)',
  'confidentialTransfer(address,bytes32,bytes)',
  'confidentialTransfer(address,bytes32)',
  'confidentialTransferFrom(address,address,bytes32,bytes)',
  'confidentialTransferFrom(address,address,bytes32)',
  'confidentialTransferAndCall(address,bytes32,bytes,bytes)',
  'confidentialTransferAndCall(address,bytes32,bytes)',
  'confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)',
  'confidentialTransferFromAndCall(address,address,bytes32,bytes)',
] as const;

/** ERC-165 interface id: the XOR of the 4-byte selectors of `signatures`. */
export function interfaceIdOf(signatures: readonly string[]): string {
  let x = 0;
  for (const sig of signatures) x = (x ^ parseInt(id(sig).slice(2, 10), 16)) >>> 0;
  return '0x' + x.toString(16).padStart(8, '0');
}

/**
 * `type(IERC7984).interfaceId`, computed from `ERC7984_INTERFACE_FUNCTIONS` (a unit test
 * recomputes it). Not yet confirmed against a deployed token: see docs/ROADMAP.md.
 */
export const ERC7984_INTERFACE_ID = '0x4958f2a4';
/** ERC-165's own id, which a contract that implements ERC-165 must report. */
export const ERC165_INTERFACE_ID = '0x01ffc9a7';

const PROBE_IFACE = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

/** Any account works for the balance probe; this one never holds keys. */
const PROBE_HOLDER = '0x0000000000000000000000000000000000000001';

/** A read-only `eth_call`: returns the raw result hex. */
export type EthCall = (to: string, data: string) => Promise<string>;

/** Outcome of `checkErc7984`. */
export interface TokenCheck {
  address: string;
  /** Name (sanitised), symbol (sanitised) and decimals, when they decoded. */
  info: TokenInfo | null;
  /** 'yes': reports the ERC-7984 id; 'no': has ERC-165, not this id; 'absent': no ERC-165. */
  erc165: 'yes' | 'no' | 'absent';
  /** confidentialBalanceOf returned a 32-byte handle. */
  balanceHandle: boolean;
  /** True when the token behaves like ERC-7984 (see the module comment). */
  compliant: boolean;
  /** Why it is not compliant, in plain English. Empty when compliant. */
  problems: string[];
  /** Things worth knowing that do not block adding it. */
  warnings: string[];
}

/** True for an error that means "the contract did not answer", not "the RPC failed". */
function isContractNoAnswer(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'BAD_DATA') return true;
  return code === 'CALL_EXCEPTION' && rpcErrorOf(err) === null;
}

/** Call and return the raw result, or null when the contract reverted / returned nothing. */
async function tryCall(call: EthCall, to: string, data: string): Promise<string | null> {
  try {
    const out = await call(to, data);
    return typeof out === 'string' && out !== '0x' ? out : null;
  } catch (err) {
    if (isContractNoAnswer(err)) return null;
    throw err;
  }
}

function decode<T>(fn: string, raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return PROBE_IFACE.decodeFunctionResult(fn, raw)[0] as T;
  } catch {
    return null;
  }
}

/** `supportsInterface(id)` as true / false, or null when there is no valid answer. */
async function supports(call: EthCall, to: string, interfaceId: string): Promise<boolean | null> {
  const raw = await tryCall(
    call,
    to,
    PROBE_IFACE.encodeFunctionData('supportsInterface', [interfaceId]),
  );
  // A bool is exactly one 32-byte word; anything else (a fallback echo, say) is no answer.
  if (raw === null || raw.length !== 66) return null;
  return decode<boolean>('supportsInterface', raw);
}

/** Run both checks on `address` through `call`. Throws only on transport failures. */
export async function checkErc7984(call: EthCall, address: string): Promise<TokenCheck> {
  const to = getAddress(address);
  const problems: string[] = [];
  const warnings: string[] = [];

  const [rawName, rawSymbol, rawDecimals, rawBalance] = await Promise.all([
    tryCall(call, to, PROBE_IFACE.encodeFunctionData('name')),
    tryCall(call, to, PROBE_IFACE.encodeFunctionData('symbol')),
    tryCall(call, to, PROBE_IFACE.encodeFunctionData('decimals')),
    tryCall(call, to, PROBE_IFACE.encodeFunctionData('confidentialBalanceOf', [PROBE_HOLDER])),
  ]);
  const name = decode<string>('name', rawName);
  const symbol = decode<string>('symbol', rawSymbol);
  const decimals = decode<bigint>('decimals', rawDecimals);
  const info: TokenInfo | null =
    name !== null && symbol !== null && decimals !== null
      ? {
          address: to,
          name: sanitizeTokenName(String(name)),
          symbol: sanitizeTokenSymbol(String(symbol)),
          decimals: Number(decimals),
        }
      : null;
  if (!info) {
    problems.push('It did not answer name(), symbol() and decimals() the way a token does.');
  }
  // bytes32 is one 32-byte word: "0x" + 64 hex digits.
  const balanceHandle = rawBalance !== null && /^0x[0-9a-fA-F]{64}$/.test(rawBalance);
  if (!balanceHandle) {
    problems.push(
      'It did not answer confidentialBalanceOf() with an encrypted balance, so it is not an ERC-7984 confidential token.',
    );
  }

  let erc165: TokenCheck['erc165'] = 'absent';
  if ((await supports(call, to, ERC165_INTERFACE_ID)) === true) {
    erc165 = (await supports(call, to, ERC7984_INTERFACE_ID)) === true ? 'yes' : 'no';
  }
  if (erc165 === 'no' && balanceHandle) {
    warnings.push(
      'It supports interface detection (ERC-165) but does not report the ERC-7984 interface. It may follow another version of the standard.',
    );
  }

  return {
    address: to,
    info,
    erc165,
    balanceHandle,
    compliant: info !== null && balanceHandle,
    problems,
    warnings,
  };
}

/** One sentence for a refused token, plus the reasons. */
export function describeNonCompliant(
  check: TokenCheck,
  network: string,
): { title: string; hint: string } {
  // Nothing answered at all: an account, or a contract of another kind or network.
  if (!check.info && !check.balanceHandle) {
    return {
      title: `That address is not a token contract on ${network}.`,
      hint: 'It may be a wallet address, another kind of contract, or a token on a different network.',
    };
  }
  return {
    title: `${check.info ? `${check.info.symbol} (${check.info.name})` : check.address} does not look like an ERC-7984 confidential token.`,
    hint: check.problems.join(' '),
  };
}
