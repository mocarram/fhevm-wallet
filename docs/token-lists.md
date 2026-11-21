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

**Both shipped lists are empty.** Only addresses someone verified may go in them; never
add an address you could not confirm. Sources checked on 2026-11-21:

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
bytes32 indexed amount)` logs with topic2 = your address, from any contract. Chunks of
10,000 blocks are halved when an endpoint says the range is too large; a rate limit stops
the scan, keeping what it found. Progress is saved per wallet and network
(`scan-state.json`), so the next scan covers only new blocks. A first scan starts at block
21,500,000 (mainnet) or 7,400,000 (Sepolia), early 2025, before any ERC-7984 token
existed; `--from-block` overrides it.

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
   test recomputes it. **It has not been confirmed against a deployed token.** Tokens from
   before v0.3.0 have no ERC-165, and a later revision of the interface has a different id,
   so a missing or different id is only a warning.
2. Behaviour: `name()`, `symbol()`, `decimals()` decode, and `confidentialBalanceOf(address)`
   returns exactly 32 bytes. This decides whether the token is accepted.

A network failure is never reported as "not ERC-7984".
