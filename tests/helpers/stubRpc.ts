/**
 * A tiny JSON-RPC node on 127.0.0.1 for tests that run the real provider and sync code:
 * eth_chainId, eth_blockNumber, eth_getLogs (address + topic filters) and
 * eth_getBlockByNumber, with the refusals public endpoints really send (a 50-block cap,
 * pruned history, topic-only refusal, rate limits). Batches are supported.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

/** A log the stub serves. Topics are 0x-prefixed 32-byte hex. */
export interface StubLog {
  address: string;
  topics: string[];
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

/** How the stub behaves. Everything optional. */
export interface StubOptions {
  head: number;
  logs?: StubLog[];
  /** Refuse eth_getLogs over more blocks than this, with nodies' wording. */
  maxRange?: number;
  /** Refuse eth_getLogs touching blocks below this with publicnode's "pruned" error. */
  prunedBelow?: number;
  /** Refuse eth_getLogs without an address (publicnode's topic-only refusal). */
  needsAddress?: boolean;
  /** Answer the first N eth_getLogs with a JSON-RPC rate-limit error. */
  rateLimitFirst?: number;
  /** Answer every eth_getLogs with a reply ethers cannot read (not an array). */
  malformedLogs?: boolean;
  /**
   * The `finalized` block this node reports (default: the head), or 'unsupported' to
   * refuse the tag like endpoints that do not know it. A finalized block above `head`
   * models a load-balanced endpoint whose nodes disagree.
   */
  finalized?: number | 'unsupported';
  /** eth_getTransactionCount at a block (tags resolved to numbers). Default 0. */
  nonceAt?: (block: number) => number;
  /** eth_getTransactionReceipt answers by hash (lowercase); others are null. */
  receipts?: Record<string, { status: number; blockNumber: number }>;
}

/** A running stub. `calls` lists methods in arrival order; `ranges` each eth_getLogs span. */
export interface StubNode {
  url: string;
  calls: string[];
  /** Block tags eth_getTransactionCount was asked at, as sent. */
  countTags: string[];
  ranges: Array<[number, number]>;
  options: StubOptions;
  close(): Promise<void>;
}

const hex = (n: number) => '0x' + n.toString(16);

function matches(log: StubLog, filter: Record<string, unknown>): boolean {
  if (filter.address) {
    const want = [filter.address].flat().map((a) => String(a).toLowerCase());
    if (!want.includes(log.address.toLowerCase())) return false;
  }
  const topics = (filter.topics as Array<string | string[] | null> | undefined) ?? [];
  return topics.every((t, i) => {
    if (t === null || t === undefined) return true;
    const want = [t].flat().map((x) => x.toLowerCase());
    return want.includes((log.topics[i] ?? '').toLowerCase());
  });
}

/** Start a stub node. */
export async function startStubRpc(options: StubOptions): Promise<StubNode> {
  const calls: string[] = [];
  const countTags: string[] = [];
  const ranges: Array<[number, number]> = [];
  let rateLimited = 0;
  const answer = (m: { id: number; method: string; params: unknown[] }) => {
    calls.push(m.method);
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: '2.0',
      id: m.id,
      error: { code, message },
    });
    switch (m.method) {
      case 'eth_chainId':
        return ok('0xaa36a7');
      case 'eth_blockNumber':
        return ok(hex(options.head));
      case 'eth_getTransactionCount': {
        const tag = String(m.params[1]);
        countTags.push(tag);
        if (tag === 'finalized' && options.finalized === 'unsupported') {
          return fail(-32602, 'invalid block tag finalized');
        }
        const block =
          tag === 'finalized'
            ? (options.finalized ?? options.head)
            : tag === 'latest' || tag === 'pending'
              ? options.head
              : Number(BigInt(tag));
        return ok(hex(options.nonceAt?.(block as number) ?? 0));
      }
      case 'eth_getTransactionReceipt': {
        const r = options.receipts?.[String(m.params[0]).toLowerCase()];
        return ok(
          r
            ? {
                transactionHash: m.params[0],
                status: hex(r.status),
                blockNumber: hex(r.blockNumber),
                logs: [],
              }
            : null,
        );
      }
      case 'eth_getBlockByNumber': {
        const tag = String(m.params[0]);
        if (tag === 'finalized' && options.finalized === 'unsupported') {
          return fail(-32602, 'invalid block tag finalized');
        }
        const n =
          tag === 'finalized'
            ? ((options.finalized as number | undefined) ?? options.head)
            : tag === 'latest'
              ? options.head
              : Number(BigInt(tag));
        return ok({
          hash: '0x' + n.toString(16).padStart(64, '0'),
          parentHash: '0x' + '0'.repeat(64),
          number: hex(n),
          timestamp: hex(1_700_000_000 + n * 12),
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: '0x' + '0'.repeat(40),
          extraData: '0x',
          baseFeePerGas: '0x1',
          transactions: [],
        });
      }
      case 'eth_getLogs': {
        const f = m.params[0] as Record<string, unknown>;
        const from = Number(BigInt(f.fromBlock as string));
        const to = Number(BigInt(f.toBlock as string));
        ranges.push([from, to]);
        if (options.rateLimitFirst && rateLimited < options.rateLimitFirst) {
          rateLimited++;
          return fail(-32005, 'rate limit exceeded');
        }
        if (options.needsAddress && !f.address) {
          return fail(
            -32701,
            'Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/eth/host',
          );
        }
        if (options.prunedBelow !== undefined && from < options.prunedBelow) {
          return fail(4444, 'pruned history unavailable');
        }
        if (options.maxRange !== undefined && to - from + 1 > options.maxRange) {
          return fail(
            -32001,
            `Block range too large: maximum allowed is ${options.maxRange} blocks on your current plan. Upgrade your subscription at https://nodies.app/pricing for larger ranges.`,
          );
        }
        if (options.malformedLogs) return ok({ not: 'an array' });
        return ok(
          (options.logs ?? [])
            .filter((l) => l.blockNumber >= from && l.blockNumber <= to && matches(l, f))
            .map((l) => ({
              address: l.address,
              topics: l.topics,
              data: '0x',
              blockNumber: hex(l.blockNumber),
              blockHash: '0x' + l.blockNumber.toString(16).padStart(64, '0'),
              transactionHash: l.transactionHash,
              transactionIndex: '0x0',
              logIndex: hex(l.logIndex),
              removed: false,
            })),
        );
      }
      default:
        return fail(-32601, `method ${m.method} not supported by the stub`);
    }
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    countTags,
    ranges,
    options,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
