# UAI Agents Team

**English** · [Türkçe](./README.md)

> A self-hostable, 6-agent autonomous multi-agent orchestration system that runs on your own server.
> Kendi sunucunda çalışan, 6 ajanlı otonom multi-agent orkestrasyon sistemi.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node%2020+-3178c6.svg)](https://www.typescriptlang.org/)
[![BYOK](https://img.shields.io/badge/LLM-BYOK%20(OpenRouter%2FOpenAI%2FGemini%2FOllama)-8b5cf6.svg)](#llm-provider-byok)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/ihsandeniz/uai-agents?style=social)](https://github.com/ihsandeniz/uai-agents/stargazers)

You submit a task; the **Core** agent analyzes it and routes it to the most suitable
specialist agent; the **QA** agent verifies the result. Past work is embedded into
pgvector, and routing decisions improve over time through learning. Fully TypeScript,
no external queue system (in-process event bus), and the LLM provider is swapped with
a single line in `.env`.

---

## Highlights

- 🧭 **Automatic routing** — the Core agent analyzes the task and picks the right specialist agent itself
- 🧠 **Semantic memory** — past operations turn into embeddings; similar tasks are found via pgvector
- 📈 **Learning-based routing** — agent performance is persisted, so decisions improve over time
- 🔀 **DAG-based parallelism** — subtasks run in parallel along a dependency graph, with deadlock protection
- 🔗 **Webhooks** — results are pushed out via HTTP POST; auto-disabled after 5 failures
- ⏸️ **Away mode** — the system waits for human approval; the queue can be paused by hour/day
- 🔑 **BYOK** — switch between OpenRouter / OpenAI / Gemini / Ollama / custom endpoint via `.env`
- 🔌 **MCP** — brings external MCP servers' tools to the agents (stdio + HTTP) **and** exposes UAI itself as an MCP server → [`docs/MCP.md`](./docs/MCP.md)

---

## Quick Start

**Requirements:** Node.js ≥ 20, [pnpm](https://pnpm.io/), Docker (+ Compose).
Runs on **Windows 10/11, Linux, and macOS**.

### Easy path — setup wizard (recommended)

```bash
git clone https://github.com/ihsandeniz/uai-agents.git
cd uai-agents
pnpm install
pnpm setup        # interactive: pick provider → enter key → writes .env → launch
```

The wizard checks prerequisites, asks for your LLM provider, auto-generates
`UAI_API_KEY`, writes `.env`, and can bring up the infrastructure and run
migrations for you. Zero dependencies, pure Node — identical on every platform.

### Manual setup (alternative)

```bash
cp .env.example .env      # Windows: copy .env.example .env
# fill in LLM_PROVIDER + your key inside .env (see below)
pnpm install

docker compose up -d --wait   # PostgreSQL (pgvector) + Redis, waits until healthy
pnpm db:migrate               # schema + pgvector extension installed automatically

pnpm --filter @uai/runtime dev
curl http://localhost:3000/health
```

Single command (infra → migrate → dev):

```bash
pnpm start
```

---

## LLM Provider (BYOK)

The system works on a **bring-your-own-key** basis — it is not locked to any provider.
Changing a single line in `.env` is enough; the code stays the same:

```bash
LLM_PROVIDER=openrouter   # openrouter | openai | gemini | ollama | custom
OPENROUTER_API_KEY=sk-or-...
```

| Provider | Requires | Note |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | Default — [openrouter.ai/keys](https://openrouter.ai/keys) |
| `openai` | `OPENAI_API_KEY` | |
| `gemini` | `GEMINI_API_KEY` | Google's OpenAI-compatible endpoint |
| `ollama` | — | Local, **free & unlimited** (`http://localhost:11434`) |
| `custom` | `LLM_API_KEY` + `LLM_BASE_URL` | LM Studio / Groq / Together / vLLM |

The entire layer is reduced to a single OpenAI-compatible request interface (`apps/runtime/src/llm/`).

---

## MCP (Model Context Protocol)

UAI is both an **MCP client** and an **MCP server** — fully optional (behavior does not
change if the env vars are not set).

```bash
# Client: bring external MCP tools to the agents (mcp__<server>__<tool>)
MCP_ENABLED=true MCP_SERVER_COMMAND=npx \
  MCP_SERVER_ARGS="-y @modelcontextprotocol/server-filesystem /tmp" pnpm dev
# …or use MCP_SERVERS='[{...}]' for multiple servers (stdio + http)

# Server: expose UAI's own tools (stdio or HTTP + X-Api-Key)
pnpm mcp:serve
```

For bridging details (JSON Schema → flat arguments), multi-server + resilience, agent
subscription (`MCP_AGENTS`), observability, and the `uai_run_bash` allowlist →
[`docs/MCP.md`](./docs/MCP.md). Example configurations → [`examples/mcp/`](./examples/mcp).
End-to-end live test: `pnpm test:mcp`.

## Structure

```
uai-agents/
├── apps/
│   ├── runtime/     # Agent loop, orchestrator, tools, HTTP/WS server
│   └── web/         # Next.js 15 dashboard
├── packages/shared/ # Zod schemas, shared types, event types
├── db/              # Drizzle schema + migrations + pgvector init
├── config/          # Away mode policy, etc.
├── docs/            # Progress reports, ADRs, MCP.md
├── examples/        # Example configurations (mcp/)
└── scripts/         # Test & helper scripts (uai-mcp-server.ts, test-mcp.ts)
```

## Stack

| Layer | Technology |
|---|---|
| Backend | TypeScript + Node ≥ 20 |
| Frontend | Next.js 15 (App Router) |
| Database | PostgreSQL 16 + pgvector |
| Cache/Bus | Redis 7 + in-process event bus |
| LLM | BYOK (OpenAI-compatible — OpenRouter/OpenAI/Gemini/Ollama/custom) |
| ORM | Drizzle |

## Ports

| Service | Port |
|---|---|
| Runtime API | 3000 |
| Web Dashboard | 3001 |
| PostgreSQL | 5434 |
| Redis | 6380 |

---

## Development

```bash
pnpm dev                              # all packages in parallel (watch)
pnpm --filter @uai/runtime dev        # runtime only
pnpm test                             # vitest across all packages
pnpm test:mcp                         # MCP end-to-end live test (stdio + HTTP)
pnpm mcp:serve                        # expose UAI as an MCP server
pnpm lint                             # tsc --noEmit (in every package)
pnpm db:generate                      # generate migration
pnpm db:studio                        # Drizzle Studio
```

For details and architectural decisions → [`docs/`](./docs).

## Security

- `X-Api-Key` auth is mandatory on all `/api/*` routes (`UAI_API_KEY`).
- A real `.env` is **never** committed (`.gitignore`). Only `.env.example` is shared.
- If you find a vulnerability, please reach out directly instead of opening a public issue.

## Contributing

Contributions are welcome — see the [CONTRIBUTING.md](./CONTRIBUTING.md) guide.
Search existing issues before opening a new one; PRs must pass `pnpm lint` + `pnpm test`.

## License

[MIT](./LICENSE) © 2026 İhsan Deniz Tüfekci
