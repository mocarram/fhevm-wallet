# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Subagents for the quality loop live in `.claude/agents/`:
  - `reviewer`: independent code review of the branch diff against `origin/staging`.
  - `security-reviewer`: keys, storage, signing, network and dependency review.
  - `verifier`: runs `npm run verify`, the e2e suite and checks acceptance criteria.
- Spawn them fresh for each review round so they don't inherit your assumptions. Give them
  the phase name, the roadmap section and the commit range; nothing else.
- Use Node 24. If `node -v` is not v24, look for `/opt/node24/bin` or install it from
  nodejs.org with checksum verification before running anything.
- In the cloud sandbox, Ethereum RPC hosts are usually blocked. Use `FHEW_BACKEND=mock` for
  end-to-end runs and state clearly what was not verified on-chain.
