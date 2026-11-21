# Token lists and the ERC-7984 check

## Known token lists

`fhew token find` and Tokens › Find tokens offer tokens from a curated list per network,
in the [token-list](https://tokenlists.org) JSON format (`name`, `symbol`, `decimals`,
`address`, `chainId`):

- shipped: `src/core/token/lists/mainnet.json` and `sepolia.json`
- optional: a list at a URL you set with `fhew config --token-list-url <https URL>`. It is
  downloaded over https (10 s timeout, 1 MB cap, no redirects), validated, cached in the
  data folder (`token-lists.json`) and refreshed once a day or with `--refresh-list`.

Entries are untrusted: addresses are checksummed, names and symbols sanitised, and every
entry still gets the ERC-7984 check before it can be added.

**The mainnet list is empty; the Sepolia list holds tokens verified on-chain.** Only
addresses someone verified may go in them; never add an address you could not confirm.

### Sepolia (verified on-chain 2026-11-21, not an endorsement)

Found from live Sepolia logs (contracts allowed by the fhEVM ACL that emitted
`ConfidentialTransfer`), then checked one by one: `supportsInterface(0x4958f2a4)` and
`supportsInterface(0x01ffc9a7)` both true, `name()`, `symbol()` and `decimals()` read
from the contract. Listed are the most used ones (by holders and transfers seen); a
listing only says the contract answers as an ERC-7984 token, not who runs it or that it
is safe to use.

| Symbol | Name | Address |
| --- | --- | --- |
| cZAMAMock | Confidential ZAMA (Mock) | 0xf2D628d2598aF4eAF94CB76a437Ff86CA78FfbFB |
| cUSDT | Confidential Tether USD | 0x421fBC08993628d703DD9Ad8641C57b9F3CC2Df7 |
| cZAMA | Confidential Zama | 0x85E3A388B8b8939Ab4f41e0B1eF70A998b23F938 |
| cUSDTMock | Confidential USDT (Mock) | 0x4E7B06D78965594eB5EF5414c357ca21E1554491 |
| cUSDCMock | Confidential USDC (Mock) | 0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639 |
| cUSDC | Confidential USD Coin | 0xef98481d937cbcb55f1d548200B38A27E0Bb729e |
| cUSDC | Confidential USDC | 0xa8Ca984a3F1e158ca30a508127C1B45dBAa81c01 |
| cWBTC | Confidential Wrapped BTC | 0x78F9581CCC7C1A0DfB53ACEd253F70cCe4d42e36 |
| cWETH | Confidential Wrapped Ether | 0xE8FBCA3Ee0a368d190A6c47A5293f32bC9827F15 |

All have 6 decimals. Two different contracts call themselves cUSDC; both are listed with
their own names, so check the address before sending.

Sources checked earlier for official lists (2026-11-21):

| Source | Result |
| --- | --- |
| https://github.com/zama-ai/fhevm (README, `docs/protocol/SUMMARY.md`, `docs/solidity-guides/contract_addresses.md`) | Protocol contracts only (ACL, executor, KMS, gateway); no token addresses or token registry |
| https://docs.zama.ai/protocol | Not reachable from the build sandbox |
| github.com/zama-ai `token-list`, `confidential-token-list` repositories | Do not exist (404) |
| https://github.com/OpenZeppelin/openzeppelin-confidential-contracts | Contracts and mocks only; no deployed-token list |

To add a token: confirm its address from the issuer and on a block explorer, check it with
`fhew token add <address>` (which runs the ERC-7984 check), then add the entry with a
comment in the pull request saying where the address was confirmed.

## History scan

The scan asks the RPC for `ConfidentialTransfer(address indexed from, address indexed to,
bytes32 indexed amount)` logs with topic2 = your address, from any contract. Chunks adapt
(`src/core/network/logRange.ts`): an endpoint that names its limit ("maximum allowed is 50
blocks") gets chunks of that size, one that only says "too large" gets half, a rate limit
is retried with back-off, and a request budget stops the scan before it turns into
thousands of requests. Progress is saved per wallet and network (`scan-state.json`), so
the next scan covers only new blocks. A first scan starts at block 21,500,000 (mainnet) or
7,400,000 (Sepolia), early 2025, before any ERC-7984 token existed; `--from-block`
overrides it.

Public endpoints restrict exactly this query (measured on Sepolia, Nov 2026): publicnode
refuses topic-only log queries ("Please specify an address"), and nodies allows them only
50 blocks at a time. So with the built-in endpoints a scan without saved progress or
`--from-block` covers only the last 5,000 blocks (about 17 hours) and says so. For a full
scan, set your own RPC URL (an archive or paid node).

A possible improvement, seen to work live: collect contracts from the fhEVM ACL's logs,
then ask for `ConfidentialTransfer` with an address list (publicnode accepts
address-filtered queries over 10,000 blocks). Not implemented yet.

Etherscan is not used for this scan: whether its logs API accepts a topic-only query
without a contract address could not be confirmed (its documentation was unreachable).
Revisit this when it can be checked; with a key it would be much faster.

Note: OpenZeppelin's unreleased `master` changes the event to
`ConfidentialTransfer(address indexed from, address indexed to, euint64 amount, bytes32
indexed memo)`, a different topic0. Tokens built on it will not be found until the scan
also asks for that topic.

## ERC-7984 check

Run when a token is added, by `fhew doctor` for every tracked token, and on every Find
tokens candidate (`src/core/token/erc7984Check.ts`):

1. ERC-165 `supportsInterface(0x4958f2a4)`. The id is the XOR of the selectors of the 16
   functions declared in OpenZeppelin's `IERC7984`
   (`contracts/interfaces/IERC7984.sol`, identical from v0.3.0 to v0.5.3; inherited
   `supportsInterface` excluded, `euint64`/`externalEuint64` encoded as `bytes32`). A unit
   test recomputes it. **Confirmed on about 35 deployed Sepolia tokens (2026-11-21)**, so
   a token that reports it and answers name, symbol and decimals is accepted. Tokens from
   before v0.3.0 have no ERC-165, and a later revision of the interface has a different id,
   so a missing or different id is only a warning.
2. Behaviour: `name()`, `symbol()`, `decimals()` decode, and `confidentialBalanceOf(address)`
   returns exactly 32 bytes. This decides for tokens without the interface id (the
   fallback).

A network failure is never reported as "not ERC-7984".
