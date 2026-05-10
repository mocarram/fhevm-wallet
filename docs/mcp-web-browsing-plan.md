# MCP Web Browsing System — Design Plan

A self-hosted MCP server on a VPS that gives Claude reliable, general-purpose access to any website. OSS-only stack, no paid proxies or CAPTCHA solvers. Target ~85–90% success across the open web; the remaining ~10% (Cloudflare-hardened SERPs, login-walled social, aggressive CAPTCHA pages) is acknowledged as out of scope for the OSS tier and slotted as future paid add-ons.

---

## 1. Goals / Non-goals

**Goals**
- Single MCP endpoint Claude can call to fetch, render, extract, screenshot, or search any public URL.
- Graceful degradation: trivially fetchable pages stay cheap; hard pages walk a fallback ladder until something works.
- Idempotent + cached: identical fetches don't re-hit the network.
- Self-contained: one VPS, one `docker compose up`, no external SaaS required.
- Observable: each request shows which tier handled it, latency, and bytes returned.

**Non-goals**
- No CAPTCHA solving (interface is stubbed; bring-your-own key later).
- No residential proxies (datacenter / TOR / direct only).
- No authenticated scraping flows in v1 (no logged-in sessions, cookie jars per-user, OAuth).
- No crawl orchestration — single-URL fetches only. Recursion is Claude's job.

---

## 2. Architecture

```
                ┌──────────────────────────────────────────────┐
                │  Claude Code (laptop)                        │
                └──────────────┬───────────────────────────────┘
                               │ MCP over stdio (via SSH) or HTTP+SSE
                               │ Tailscale tunnel
                               ▼
        ┌──────────────────────────────────────────────────────┐
        │  VPS (Hetzner CCX23, Ubuntu 24.04)                   │
        │                                                      │
        │  ┌─────────────┐    ┌──────────────┐                 │
        │  │ MCP Server  │───▶│ Fetch Queue  │ (BullMQ/Redis)  │
        │  │ (Node TS)   │    └──────┬───────┘                 │
        │  └──────┬──────┘           │                         │
        │         │ cache lookup     ▼                         │
        │         │            ┌────────────────────────┐      │
        │         ▼            │  Fetch Orchestrator    │      │
        │   ┌──────────┐       │  (tier ladder)         │      │
        │   │  Redis   │◀──────┤                        │      │
        │   │  cache   │       │  T1 httpx              │      │
        │   └──────────┘       │  T2 Playwright         │      │
        │                      │  T3 Patchright stealth │      │
        │                      │  T4 +TOR / VPS rotate  │      │
        │                      │  T5 FlareSolverr       │      │
        │                      └────────┬───────────────┘      │
        │                               │                      │
        │                      ┌────────▼─────────┐            │
        │                      │ Browser Workers  │            │
        │                      │ (Playwright +    │            │
        │                      │  Xvfb in Docker) │            │
        │                      └──────────────────┘            │
        │                                                      │
        │  ┌──────────────┐   ┌──────────────────────┐         │
        │  │ Trafilatura  │   │ Prometheus + Grafana │         │
        │  │ extractor    │   │ (optional)           │         │
        │  └──────────────┘   └──────────────────────┘         │
        └──────────────────────────────────────────────────────┘
```

---

## 3. The fetch ladder

Each request walks down until one tier returns a 2xx with content that passes a sanity check (non-empty body, no anti-bot interstitial fingerprint, no JS-disabled page). Each tier has a per-domain timeout budget; on success the orchestrator records *which tier worked for this domain* and starts there next time.

| Tier | Tool | When | Cost | Notes |
|---|---|---|---|---|
| T1 | `httpx` + `trafilatura` | Static HTML, RSS, JSON, sitemaps | ~50 ms | Sets realistic UA + Accept headers. Handles ~60% of the open web. |
| T2 | Playwright headless Chromium | SPA, JS-rendered DOM, lazy-loaded content | ~3–8 s | Reuses warm browser contexts. Network idle wait. |
| T3 | **Patchright** (stealth fork of Playwright) | Cloudflare turnstile, Akamai, basic bot fingerprinting | ~5–12 s | Patchright is currently the strongest OSS stealth option; rebrand of `playwright-extra-stealth`. |
| T4 | T3 + outbound rotation | IP-based blocks | ~5–15 s | OSS rotation options: TOR SOCKS5 (slow, often pre-blocked), or scripted `hcloud` floating-IP rotation across pre-warmed Hetzner egress IPs. |
| T5 | FlareSolverr | Last-resort Cloudflare challenge pages | ~10–30 s | Standalone container. Not a guaranteed fix in 2026 — Cloudflare regularly breaks it — but free. |

**Sanity-check heuristics** to detect "200 OK but actually blocked":
- Body contains `cf-browser-verification`, `Just a moment...`, `Checking your browser`
- Body length < 1 KB on a domain that historically returns more
- Page title equals "Access denied" / "Attention Required"
- Trafilatura extraction returns < 50 chars on an article URL

---

## 4. MCP tool surface

Exposed to Claude. Keep it small and orthogonal — Claude composes them.

| Tool | Purpose | Returns |
|---|---|---|
| `fetch_url` | Fetch a URL, return cleaned main-content text + metadata | `{ url, status, tier, content, title, links[], cached }` |
| `fetch_raw` | Same, but raw HTML (no extraction) | `{ url, status, html, headers }` |
| `screenshot` | Full-page PNG, base64 or saved-path | `{ path, width, height }` |
| `search_in_page` | Fetch + grep regex/CSS selector | `{ matches: [...] }` |
| `submit_form` | POST to a URL with form fields (for non-auth flows) | `{ status, content }` |
| `list_links` | Fetch + return outbound links with anchor text | `{ links: [{href, text}] }` |
| `health` | Tier availability + recent success rates | `{ tiers: {...} }` |

Each call accepts: `force_tier?`, `cache_ttl?`, `timeout_ms?`, `wait_for?` (selector), `viewport?`, `user_agent?`.

---

## 5. Tech stack

- **Language**: TypeScript (Node 22) for the MCP server — matches `@modelcontextprotocol/sdk`, your existing `fhevm-wallet` repo conventions, and Playwright's primary ecosystem.
- **MCP SDK**: `@modelcontextprotocol/sdk` (stdio + streamable-HTTP transports).
- **Browser**: `patchright` (stealth) + plain `playwright` (fallback). One Chromium install per worker.
- **Extraction**: `@mozilla/readability` + `jsdom` for article extraction; `cheerio` for selector queries; falls back to a Python `trafilatura` sidecar via stdin/stdout for tough articles (it still beats every JS-side option).
- **Queue**: BullMQ on Redis 7. Concurrency knob per tier so cheap fetches don't starve behind T3.
- **Cache**: Redis with content keyed by `sha256(canonical_url)`; respect `Cache-Control` / `ETag` where present, default TTL 1 h, configurable per tool call.
- **Container**: One `docker-compose.yml` with services: `mcp`, `worker` (scaled), `redis`, `flaresolverr`, `tor` (optional), `prometheus` (optional).
- **Transport to Claude**: MCP server exposes both stdio (run via `ssh user@vps mcp-web` from Claude config) and streamable HTTP behind Tailscale auth.

---

## 6. VPS sizing & provider

**Recommendation: Hetzner CCX23** (dedicated AMD, 4 vCPU / 16 GB / 240 GB NVMe, 20 TB egress) — €25/mo. Reasons:
- Dedicated vCPUs matter; Chromium is bursty and noisy neighbors hurt p95 latency a lot.
- Generous egress (20 TB) — scraping eats bandwidth.
- Floating IPs are free to attach/detach via `hcloud` CLI → enables Tier 4 IP rotation without paid proxies.
- EU-based; if you need US egress add a second `cx22` in Ashburn (€4/mo) and route through it.

**Alternatives**
- **Vultr High Frequency** ($24/mo, 2 vCPU / 4 GB) — slightly worse $/perf, better US presence.
- **Netcup VPS 2000 G11** (€7/mo, 4 vCPU / 8 GB) — cheapest credible option, oversubscribed CPU hurts T3.
- **Skip**: DigitalOcean (overpriced for this), AWS/GCP (egress costs torch the budget).

**Sizing math**
- T1 fetch: ~30 MB RAM, <1% CPU, ~50 ms — handle hundreds/sec
- T2/T3 fetch: ~250 MB RAM per browser context, 30–80% of one core for 5 s — ~6 concurrent on CCX23
- Set BullMQ concurrency: T1=64, T2=4, T3=4, T4=2, T5=2

---

## 7. Hardening

- **Networking**: Bind MCP HTTP to Tailscale interface only; SSH-key auth; UFW deny-all inbound except 22 + Tailscale.
- **Process isolation**: Each browser worker runs as non-root in its own container with `--cap-drop=ALL`, `seccomp=default`. Chromium sandbox enabled.
- **SSRF guard**: Block fetches to RFC1918, link-local, and the VPS's own metadata endpoint (`169.254.169.254`). Resolve hostname first, reject if private.
- **Resource caps**: Per-fetch wall clock 60 s, per-fetch memory 512 MB (cgroup), max response size 25 MB, max redirect chain 10.
- **robots.txt**: Honored by default; `respect_robots: false` flag exists but logs a warning. Default rate limit: 1 req/s per host.
- **Disk**: Auto-prune screenshot cache > 7 days; rotate logs daily.
- **Secrets**: `.env` file (already in repo style), never logged.

---

## 8. Phased delivery

**Phase 1 — MVP (1–2 days)**
- Repo skeleton, Dockerfile, compose, MCP server with `fetch_url` + `fetch_raw` only.
- Tiers T1 + T2 only. Redis cache. Trafilatura sidecar.
- Tailscale connection from a dev laptop.
- Goal: Claude can browse 60% of the web from a VPS.

**Phase 2 — Stealth + queue (2–3 days)**
- Add Patchright (T3), BullMQ queue, per-domain "remember which tier worked" map.
- Add `screenshot`, `list_links`, `search_in_page`.
- Sanity-check heuristics for soft blocks.

**Phase 3 — Egress rotation + last resort (2 days)**
- Hetzner floating-IP rotation script as T4.
- FlareSolverr container as T5.
- Optional TOR SOCKS5 path.
- Prometheus metrics, Grafana dashboard, `health` tool.

**Phase 4 — Future paid add-ons (only if needed)**
- Pluggable proxy adapter (interface ready; drop in IPRoyal/Bright Data creds later).
- CAPTCHA solver adapter (CapSolver).
- Per-user cookie jars for authenticated browsing.

---

## 9. Risks & honest tradeoffs

| Risk | Mitigation |
|---|---|
| Cloudflare-protected sites (a *lot* of the web in 2026) frequently defeat OSS stealth | Accept the gap; surface clearly in `health` tool; Phase 4 add Bright Data Web Unlocker (~$3/1k req) as opt-in. |
| FlareSolverr breaks every few months when CF updates | Pin a working version; treat T5 as "best-effort"; don't gate the system on it. |
| TOR exit IPs are pre-blocked on most commercial sites | Use TOR only as last resort and only for legitimately TOR-friendly sites; mostly rely on Hetzner floating-IP rotation. |
| Single VPS = single point of failure & single egress IP block | Phase 3 supports adding worker nodes in other regions; cache is centralized via Redis. |
| Bandwidth blowup from screenshot-heavy use | Screenshot tool returns saved-path by default, not base64; 25 MB response cap. |
| MCP transport latency over residential ISP | stdio-over-SSH adds ~30 ms RTT; acceptable. HTTP+SSE over Tailscale is fine for batched calls. |
| Legal / ToS | Respect robots.txt by default; rate-limit; document that Claude operators are responsible for what they scrape. |

---

## 10. Repo layout (when implemented)

```
mcp-web/
├── docker-compose.yml
├── .env.example
├── Dockerfile
├── package.json
├── src/
│   ├── mcp/
│   │   ├── server.ts            # MCP entry, tool registrations
│   │   └── tools/
│   │       ├── fetch_url.ts
│   │       ├── screenshot.ts
│   │       └── ...
│   ├── orchestrator/
│   │   ├── ladder.ts            # tier dispatch + per-domain memory
│   │   ├── sanity.ts            # block-page heuristics
│   │   └── ssrf.ts
│   ├── tiers/
│   │   ├── t1_http.ts
│   │   ├── t2_playwright.ts
│   │   ├── t3_patchright.ts
│   │   ├── t4_rotate.ts
│   │   └── t5_flaresolverr.ts
│   ├── extract/
│   │   ├── readability.ts
│   │   └── trafilatura_sidecar.py
│   ├── cache/redis.ts
│   └── queue/bullmq.ts
└── ops/
    ├── prometheus.yml
    └── rotate-floating-ip.sh
```

---

## 11. Estimated monthly cost

| Item | Cost |
|---|---|
| Hetzner CCX23 | €25 |
| Hetzner floating IPs ×3 (rotation pool) | €3 |
| Tailscale (free tier) | €0 |
| Domain (optional, for HTTPS endpoint) | ~€1 |
| **Total** | **~€29/mo** |

Future paid uplifts (not part of v1):
- Bright Data Web Unlocker: ~$3 / 1000 successful fetches
- CapSolver: ~$1 / 1000 CAPTCHAs
- Residential proxy pool: $50–500/mo depending on volume

---

## 12. Open questions before build

1. Do you already have a domain you want to point at the MCP HTTP endpoint, or is Tailscale-only fine?
2. Should the MCP server be in this repo (as a sibling package) or a brand-new repo?
3. Is there a specific shortlist of domains you most often hit walls on? Worth running a probe pass against them to validate Phase 2 stealth coverage before building the full ladder.
