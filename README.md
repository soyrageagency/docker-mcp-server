<div align="center">

```
 ███████╗ ██████╗ ██╗   ██╗██████╗  █████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗╚██╗ ██╔╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝
 ███████╗██║   ██║ ╚████╔╝ ██████╔╝███████║██║  ███╗█████╗
 ╚════██║██║   ██║  ╚██╔╝  ██╔══██╗██╔══██║██║   ██║██╔══╝
 ███████║╚██████╔╝   ██║   ██║  ██║██║  ██║╚██████╔╝███████╗
 ╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

# 🐳 Docker MCP Server

**Chat with your Docker host.** A [Model Context Protocol](https://modelcontextprotocol.io) server that turns any MCP-capable AI — Claude Desktop, Cursor, Continue, Zed — into a natural-language DevOps copilot for Docker & Compose.

*“Restart the `api` container.” · “Why did `web` crash — show me the last 100 log lines.” · “Deploy the stack in `./prod`.”*

[![Node](https://img.shields.io/badge/Node-%3E%3D18-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-6E56CF)](https://modelcontextprotocol.io)
[![License: SRAL](https://img.shields.io/badge/License-SoyRage%20Attribution-orange)](./LICENSE)

**Crafted by [SoyRage Agency](https://soyrage.es/) — https://soyrage.es/**

</div>

---

## ✨ Why this exists

Managing containers usually means memorising `docker ps`, `docker logs`, `docker compose up -d --build`, flags, container IDs… This server exposes those operations as **safe, well-described MCP tools** so you can just *talk to your server* and let the model translate intent into the right Docker calls — with guardrails that keep it from doing anything reckless.

It’s built for the **self-hosting** and **home-lab** crowd, but it’s equally at home on a CI box or a production VM behind read-only mode.

---

## 🚀 Features

| Area | What you get |
| --- | --- |
| 🔎 **Insight** | List containers, inspect config, live CPU/memory/network stats, tail logs (with time windows), list images / networks / volumes, host & disk usage. |
| ⚙️ **Lifecycle** | Start, stop, restart and remove containers — with graceful timeouts. |
| 📦 **Compose** | Validate config, list services, **deploy** (`up -d`, optional `--build`), tear down, restart and pull — driven by the official `docker compose` CLI. |
| 🛡️ **Safety rails** | Global **read-only mode**, an opt-in **exec** tool, and a **container allowlist** so the AI only ever touches what you permit. |
| 🔌 **Transport** | Local socket, Windows named pipe, or secured remote **TCP + TLS**. |
| 🎨 **Branding** | Greets the user with a SoyRage Agency ASCII welcome and identifies its author to the AI on connect. |

---

## 🧩 Tool reference

> Tools marked **W** change state and are hidden when `DOCKER_MCP_READONLY=true`.

| Tool | Type | Description |
| --- | :---: | --- |
| `about` | R | Show credits, license and the SoyRage welcome banner. |
| `list_containers` | R | Running (or all) containers with status, image and ports. |
| `inspect_container` | R | Full low-level configuration of one container. |
| `container_stats` | R | One-shot CPU %, memory and network snapshot. |
| `container_logs` | R | Tail stdout/stderr, with `tail`, `since` and `timestamps`. |
| `list_images` | R | Cached images with size and age. |
| `system_info` | R | Engine version, host OS, CPU/RAM, object counts. |
| `disk_usage` | R | Reclaimable space across images/containers/volumes. |
| `list_networks` | R | Networks with driver and scope. |
| `list_volumes` | R | Named volumes and drivers. |
| `compose_ps` | R | Services and health of a Compose stack. |
| `compose_config` | R | Validate & render the effective Compose config. |
| `start_container` | **W** | Start a stopped container. |
| `stop_container` | **W** | Gracefully stop a running container. |
| `restart_container` | **W** | Restart a container. |
| `remove_container` | **W** | Remove a container (destructive; needs `force` if running). |
| `deploy_stack` | **W** | `compose up -d` (optionally `--build`, scoped to services). |
| `compose_down` | **W** | Tear a stack down (optionally with volumes). |
| `compose_restart` | **W** | Restart all or selected services. |
| `compose_pull` | **W** | Pull latest images for a stack. |
| `exec_in_container` | **W**† | Run a command inside a container. †Off unless `DOCKER_MCP_ALLOW_EXEC=true`. |

---

## 📦 Installation

**Requirements:** Node.js ≥ 18, and a reachable Docker Engine. Compose tools additionally need the `docker` CLI on `PATH`.

```bash
git clone https://github.com/<your-user>/docker-mcp-server.git
cd docker-mcp-server
npm install
npm run build
```

Try it locally with the MCP Inspector:

```bash
npm run inspect
```

---

## 🔌 Connect it to your AI

Add the server to your MCP client. Example for **Claude Desktop**
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```jsonc
{
  "mcpServers": {
    "docker": {
      "command": "node",
      "args": ["/absolute/path/to/docker-mcp-server/dist/index.js"],
      "env": {
        "DOCKER_MCP_READONLY": "false",
        "DOCKER_MCP_ALLOW_EXEC": "false"
      }
    }
  }
}
```

A ready-to-edit copy lives in [`examples/claude_desktop_config.json`](./examples/claude_desktop_config.json).
Restart your client and ask: *“What containers are running?”* — the assistant will greet you on behalf of SoyRage Agency and take it from there.

---

## ⚙️ Configuration

Every setting is an environment variable (a local `.env` is loaded automatically). See [`.env.example`](./.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_HOST` | platform socket | Engine endpoint (`unix://`, `npipe://`, `tcp://host:port`). |
| `DOCKER_CERT_PATH` | — | Directory with `ca.pem`/`cert.pem`/`key.pem` for TLS. |
| `DOCKER_TLS_VERIFY` | `false` | Verify the daemon certificate. |
| `DOCKER_MCP_READONLY` | `false` | Hide **all** state-changing tools. |
| `DOCKER_MCP_ALLOW_EXEC` | `false` | Expose the `exec_in_container` tool. |
| `DOCKER_MCP_CONTAINER_ALLOWLIST` | — | Comma-separated names/prefixes the AI may touch. |
| `DOCKER_MCP_DEFAULT_LOG_TAIL` | `200` | Default log lines returned. |
| `DOCKER_MCP_COMPOSE_CWD` | process cwd | Base dir for relative Compose paths. |
| `DOCKER_MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

### 🛡️ Safety recipes

- **Give a demo without risk** → `DOCKER_MCP_READONLY=true`
- **Only manage your app, never the database** → `DOCKER_MCP_CONTAINER_ALLOWLIST=web,api`
- **Never let the AI shell into anything** → keep `DOCKER_MCP_ALLOW_EXEC=false` (default)

---

## 🏗️ Architecture

```
                 ┌──────────────────────────────────────────────┐
   Your AI  ◀────▶  MCP client (Claude / Cursor / Continue …)    │
                 └───────────────────────┬──────────────────────┘
                                stdio (JSON-RPC)
                 ┌───────────────────────▼──────────────────────┐
                 │              Docker MCP Server                │
                 │                                               │
                 │  index.ts ─ boots server, banner, guards      │
                 │  branding.ts ─ SoyRage identity & attribution │
                 │  config.ts ─ env parsing & safety flags       │
                 │  tools/*  ─ one module per capability group   │
                 │  docker/client.ts  ─ Engine API (dockerode)   │
                 │  docker/compose.ts ─ `docker compose` CLI     │
                 └───────────┬───────────────────────┬──────────┘
                    Engine API │            spawn      │ docker compose
                 ┌───────────▼───────────┐ ┌──────────▼──────────┐
                 │   Docker Engine        │ │   Compose plugin     │
                 └───────────────────────┘ └─────────────────────┘
```

```
src/
├── index.ts            # Entry point: banner, attribution guard, wiring
├── branding.ts         # SoyRage identity, ASCII banner, MCP instructions
├── config.ts           # Env-driven, validated configuration
├── logger.ts           # stderr-only structured logger (stdout is sacred)
├── docker/
│   ├── client.ts       # Typed dockerode wrapper + allowlist enforcement
│   └── compose.ts      # Safe, shell-free `docker compose` driver
├── tools/
│   ├── index.ts        # Registry — wires every group, honours read-only
│   ├── about.ts        # Credits & welcome
│   ├── containers.ts   # list / inspect / stats
│   ├── logs.ts         # log tailing with stream demuxing
│   ├── lifecycle.ts    # start / stop / restart / remove / exec
│   ├── images.ts       # image inventory
│   ├── system.ts       # system_info / disk_usage / networks / volumes
│   └── compose.ts      # deploy / down / restart / pull / ps / config
└── utils/
    ├── format.ts       # tables, byte & time humanisers
    └── result.ts       # MCP result helpers + error guard
```

**Design notes**

- **stdout is reserved** for the JSON-RPC stream; every diagnostic goes to stderr.
- **No shell interpolation** — Compose commands are spawned with an argument array, never a shell string.
- **Fail soft** — a handler that throws returns a clean `isError` result the model can read, instead of killing the connection.
- **Tiny dependency surface** — a hand-rolled `.env` loader keeps `dotenv` out.

---

## 🧪 Development

```bash
npm run dev        # hot-reload with tsx
npm run typecheck  # strict type check, no emit
npm run build      # compile to dist/
npm run inspect    # launch the MCP Inspector against the built server
```

Want a stack to play with? [`examples/demo-stack/compose.yaml`](./examples/demo-stack/compose.yaml) spins up nginx + redis. Ask your assistant to *“deploy the demo stack and show me its services.”*

---

## 🖋️ Credits & License

<div align="center">

**Designed, built and maintained by [SoyRage Agency](https://soyrage.es/)**

</div>

This project is released under the **SoyRage Attribution License** (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE)). You are free to use, modify and self-host it — **as long as the credit to SoyRage Agency stays visible**: the source headers, the `package.json` author field, and the runtime identity (ASCII banner, `about` tool and MCP instructions) must remain intact.

> ℹ️ Software that runs on your machine can always be modified — this is not DRM. The attribution is baked in as the default everywhere so that removing it is a deliberate act, and the license makes that act a violation. If you’d like white-labelling or a commercial license, reach out via [soyrage.es](https://soyrage.es/).

If this saved you time, a ⭐ on the repo and a link back to **https://soyrage.es/** genuinely help. Thank you! 🙌
