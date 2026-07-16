<div align="center">

<a href="https://soyrage.es/">
  <img src="./assets/soyrage-banner.svg" alt="SoyRage Agency — Full-Stack Developer × Infrastructure Engineer · soyrage.es" width="100%">
</a>

<br/>

```
 ███████╗ ██████╗ ██╗   ██╗██████╗  █████╗  ██████╗ ███████╗
 ██╔════╝██╔═══██╗╚██╗ ██╔╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝
 ███████╗██║   ██║ ╚████╔╝ ██████╔╝███████║██║  ███╗█████╗
 ╚════██║██║   ██║  ╚██╔╝  ██╔══██╗██╔══██║██║   ██║██╔══╝
 ███████║╚██████╔╝   ██║   ██║  ██║██║  ██║╚██████╔╝███████╗
 ╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

# 🐳 Docker MCP Server

**Chat with your Docker host.** A [Model Context Protocol](https://modelcontextprotocol.io) server that turns any MCP‑capable AI — Claude Desktop, Cursor, Continue, Zed — into a natural‑language DevOps copilot for **Docker & Docker Compose**.

*“Restart the `api` container.” · “Why did `web` crash — show me the last 100 log lines.” · “Deploy the stack in `./prod` and confirm it’s healthy.”*

<br/>

[![Node](https://img.shields.io/badge/Node-%3E%3D18-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.x-6E56CF)](https://modelcontextprotocol.io)
[![Docker](https://img.shields.io/badge/Docker-Engine%20API-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/engine/api/)
[![License: SRAL](https://img.shields.io/badge/License-SoyRage%20Attribution-orange)](./LICENSE)

### Designed, built & maintained by **[SoyRage Agency](https://soyrage.es/)** · **https://soyrage.es/**

</div>

---

## 📑 Table of contents

- [What is this?](#-what-is-this)
- [Why it exists](#-why-it-exists)
- [Feature overview](#-feature-overview)
- [How it works](#-how-it-works)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [Connecting to your AI client](#-connecting-to-your-ai-client)
  - [Claude Desktop](#claude-desktop)
  - [Cursor / Continue / Zed](#cursor--continue--zed)
- [Configuration reference](#-configuration-reference)
- [Connecting to remote / TLS daemons](#-connecting-to-remote--tls-daemons)
- [Security model](#-security-model)
- [Complete tool reference](#-complete-tool-reference)
- [Example conversations](#-example-conversations)
- [Project structure](#-project-structure)
- [Design principles](#-design-principles)
- [Development](#-development)
- [Troubleshooting & FAQ](#-troubleshooting--faq)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [About SoyRage Agency](#-about-soyrage-agency)
- [Credits & License](#-credits--license)

---

## 🧭 What is this?

The **Model Context Protocol (MCP)** is an open standard that lets AI assistants talk to external tools through a well‑defined JSON‑RPC interface. **Docker MCP Server** is an MCP *server* that speaks that protocol over **stdio** and exposes your Docker host as a set of safe, richly‑described tools.

Point any MCP‑capable assistant at it and you can operate containers and Compose stacks **in plain language** — the model reads each tool’s schema, decides which to call, and reports the results back to you. No more memorising flags or copy‑pasting container IDs.

> **In one line:** it’s the bridge between “*I wish I could just tell my server what to do*” and your actual Docker daemon.

---

## 💡 Why it exists

Day‑to‑day container work is a stream of small, repetitive commands:

```bash
docker ps -a
docker logs --tail 100 -f my-api
docker compose -f ./prod/compose.yaml up -d --build
docker stats my-api
```

Every one of those is trivial *once you remember the exact syntax*. The friction is the memorisation and the context‑switching. This server removes that friction by letting the AI do the translation, while **keeping you in control** through:

- **Read‑only mode** for safe demos and production insight.
- A **container allowlist** so the assistant can only touch what you allow.
- **Opt‑in exec** so arbitrary in‑container commands are never available by accident.
- **Confirmation‑friendly design** — destructive tools are clearly described so the model asks before it acts.

Built by **[SoyRage Agency](https://soyrage.es/)** for the self‑hosting and home‑lab community — and equally at home on a CI runner or a production VM behind read‑only mode.

---

## 🚀 Feature overview

| Area | Capabilities |
| --- | --- |
| 🔎 **Insight** | List containers · inspect full config · live CPU/memory/network stats · tail logs with time windows · list images / networks / volumes · host summary · disk usage. |
| ⚙️ **Lifecycle** | Start · stop · restart · remove containers — with graceful stop timeouts. |
| 📦 **Compose** | Validate config · list services & health · **deploy** (`up -d`, optional `--build`) · tear down · restart · pull — via the official `docker compose` CLI. |
| 🛡️ **Safety** | Global **read‑only** mode · **container allowlist** · **opt‑in exec** · soft attribution guard. |
| 🔌 **Transport** | Local Unix socket · Windows named pipe · secured remote **TCP + TLS**. |
| 🎨 **Identity** | ASCII welcome banner · `about` tool · MCP `instructions` that credit **SoyRage Agency** to the AI on connect. |
| 🧱 **Engineering** | 100% TypeScript, strict mode · one module per concern · tiny dependency surface · stderr‑only logging. |

---

## 🛠️ How it works

```
                 ┌──────────────────────────────────────────────┐
   You  ◀──────▶ │  AI assistant (Claude / Cursor / Continue …)  │
                 └───────────────────────┬──────────────────────┘
                              stdio · JSON‑RPC (MCP)
                 ┌───────────────────────▼──────────────────────┐
                 │              Docker MCP Server                │
                 │                                               │
                 │  1. Client sends `initialize` → server        │
                 │     replies with tool schemas + SoyRage       │
                 │     `instructions` (identity & welcome).      │
                 │  2. Model picks a tool and sends `tools/call`.│
                 │  3. Server executes it against Docker and     │
                 │     returns human‑readable text.              │
                 └───────────┬───────────────────────┬──────────┘
                  Engine API  │             spawn      │  docker compose
                 ┌───────────▼───────────┐ ┌──────────▼──────────┐
                 │     Docker Engine      │ │   Compose plugin     │
                 └───────────────────────┘ └─────────────────────┘
```

- **Engine operations** (containers, images, stats, logs, system info) use the Docker Engine API through [`dockerode`](https://github.com/apocas/dockerode).
- **Compose operations** shell out to the official `docker compose` CLI with a **shell‑free**, fully argument‑quoted spawn (no string interpolation, no injection surface).
- **stdout is sacred**: it carries only the JSON‑RPC stream. Every log line goes to **stderr**.

---

## ✅ Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 18** | ES modules + modern APIs. Node 20+ recommended. |
| **A reachable Docker Engine** | Local socket by default; remote TCP/TLS supported. |
| **`docker` CLI on `PATH`** | Only needed for the **Compose** tools. Insight/lifecycle tools work without it. |
| **An MCP client** | Claude Desktop, Cursor, Continue, Zed, or the MCP Inspector. |

---

## 📦 Installation

```bash
# 1. Clone
git clone https://github.com/<your-user>/docker-mcp-server.git
cd docker-mcp-server

# 2. Install dependencies
npm install

# 3. Build to dist/
npm run build
```

Kick the tyres with the official MCP Inspector (no AI client required):

```bash
npm run inspect
```

This opens a UI where you can list tools and call them by hand — perfect for verifying your Docker connection before wiring up an assistant.

---

## 🔌 Connecting to your AI client

### Claude Desktop

Edit your Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "docker": {
      "command": "node",
      "args": ["/absolute/path/to/docker-mcp-server/dist/index.js"],
      "env": {
        "DOCKER_MCP_READONLY": "false",
        "DOCKER_MCP_ALLOW_EXEC": "false",
        "DOCKER_MCP_DEFAULT_LOG_TAIL": "200"
      }
    }
  }
}
```

> A ready‑to‑edit copy lives in [`examples/claude_desktop_config.json`](./examples/claude_desktop_config.json).

Restart Claude Desktop and ask: **“What containers are running?”** — the assistant will greet you on behalf of **SoyRage Agency** and take it from there.

### Cursor / Continue / Zed

Any MCP‑capable client works the same way — register a stdio server whose command is `node` and whose argument is the absolute path to `dist/index.js`, passing the same environment variables. Consult your client’s MCP documentation for the exact config location; the server block is identical.

---

## ⚙️ Configuration reference

Every setting is an environment variable. A local **`.env`** file (next to `package.json`) is loaded automatically at startup; values already present in the process environment always win, so your MCP client can override the file. See [`.env.example`](./.env.example) for a commented template.

| Variable | Default | Description |
| --- | --- | --- |
| `DOCKER_HOST` | platform socket | Engine endpoint. Accepts `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine`, or `tcp://host:port`. Empty = platform default. |
| `DOCKER_CERT_PATH` | — | Directory containing `ca.pem`, `cert.pem`, `key.pem` for a TLS‑secured remote daemon. |
| `DOCKER_TLS_VERIFY` | `false` | `1`/`true` to verify the daemon certificate (recommended for remote hosts). |
| `DOCKER_MCP_READONLY` | `false` | When `true`, **all** state‑changing tools are hidden — the server exposes insight only. |
| `DOCKER_MCP_ALLOW_EXEC` | `false` | When `true`, registers the `exec_in_container` tool (arbitrary in‑container commands). |
| `DOCKER_MCP_CONTAINER_ALLOWLIST` | — | Comma‑separated container **names or prefixes** the server may operate on. Empty = all. Prefix matching means `web` covers `web-1`, `web-2`. |
| `DOCKER_MCP_DEFAULT_LOG_TAIL` | `200` | Default number of log lines returned by `container_logs` when `tail` is omitted. |
| `DOCKER_MCP_COMPOSE_CWD` | process cwd | Base directory used to resolve **relative** Compose file paths. |
| `DOCKER_MCP_LOG_LEVEL` | `info` | Diagnostic verbosity written to stderr: `debug` \| `info` \| `warn` \| `error`. |

**Boolean parsing:** any of `1`, `true`, `yes`, `on` (case‑insensitive) counts as true.

---

## 🌐 Connecting to remote / TLS daemons

Manage a Docker host over the network by pointing `DOCKER_HOST` at its TCP endpoint. For anything beyond `localhost`, **always** use TLS.

```bash
# Plain TCP (trusted networks only!)
DOCKER_HOST=tcp://192.168.1.50:2375

# Secured TCP with mutual TLS
DOCKER_HOST=tcp://docker.internal:2376
DOCKER_TLS_VERIFY=1
DOCKER_CERT_PATH=/home/you/.docker/certs
```

When TLS is enabled the server reads `ca.pem`, `cert.pem` and `key.pem` from `DOCKER_CERT_PATH` and connects over HTTPS (default port `2376`; plain TCP defaults to `2375`).

---

## 🛡️ Security model

This server can control your infrastructure, so it ships with defence‑in‑depth defaults. **You** decide how much power to grant.

| Control | What it does | Recommended for |
| --- | --- | --- |
| **Read‑only mode** (`DOCKER_MCP_READONLY=true`) | Hides every state‑changing tool. The model literally cannot see `stop`, `remove`, `deploy_stack`, etc. | Demos, dashboards, production insight. |
| **Container allowlist** (`DOCKER_MCP_CONTAINER_ALLOWLIST`) | Restricts *all* container tools to matching names/prefixes. Anything else returns a clear “not allowed” error. | Multi‑tenant hosts, “manage the app, never the database”. |
| **Opt‑in exec** (`DOCKER_MCP_ALLOW_EXEC`) | The powerful `exec_in_container` tool is **not registered** unless you enable it. | Keep disabled unless you specifically need it. |
| **Shell‑free Compose** | Compose commands are spawned as argument arrays — no shell, no interpolation. | Always on. |
| **Graceful errors** | A failing tool returns an `isError` text result instead of crashing the transport, so a bad call never takes the session down. | Always on. |

### Safety recipes

```bash
# Give a live demo with zero risk of mutation
DOCKER_MCP_READONLY=true

# Let the AI manage only the app tier, never data stores
DOCKER_MCP_CONTAINER_ALLOWLIST=web,api,worker

# Never allow shelling into containers (this is the default)
DOCKER_MCP_ALLOW_EXEC=false
```

> ⚠️ **Principle of least privilege.** Start read‑only, add an allowlist, and only enable writes/exec once you trust the setup. Treat the assistant as a very fast junior engineer: helpful, but you sign off on the destructive stuff.

---

## 🧰 Complete tool reference

Tools marked **W** change state and are **hidden** when `DOCKER_MCP_READONLY=true`.
`exec_in_container` is additionally hidden unless `DOCKER_MCP_ALLOW_EXEC=true`.

### Identity

| Tool | Parameters | Description |
| --- | --- | --- |
| `about` | — | Returns the SoyRage Agency welcome banner, credits and license. The assistant uses it to introduce the server. |

### Insight (read‑only)

| Tool | Parameters | Description |
| --- | --- | --- |
| `list_containers` | `all?: boolean` | List containers with state, image, status and published ports. `all` includes stopped ones. |
| `inspect_container` | `container: string` | Full low‑level config for one container (env, mounts, network, restart policy, health) plus a readable summary. |
| `container_stats` | `container: string` | One‑shot snapshot of live CPU %, memory usage/limit and network RX/TX. |
| `container_logs` | `container: string`, `tail?: number`, `since?: string`, `timestamps?: boolean` | Tail stdout/stderr. `since` accepts a Unix timestamp or a relative value like `10m`, `2h`, `1d`. Docker stream headers are demultiplexed automatically. |
| `list_images` | — | Locally cached images with `repo:tag`, short ID, size and age; plus total disk footprint. |
| `system_info` | — | Engine version, host OS/arch, kernel, CPU/RAM, storage driver and object counts. |
| `disk_usage` | — | Reclaimable space across images/containers/volumes (`docker system df`). |
| `list_networks` | — | Networks with driver and scope. |
| `list_volumes` | — | Named volumes with driver and mountpoint. |

### Compose — read‑only

| Tool | Parameters | Description |
| --- | --- | --- |
| `compose_ps` | `file: string`, `project?: string` | List a stack’s services and their state/health. `file` is a compose file **or** a directory containing one. |
| `compose_config` | `file`, `project?` | Validate and render the fully‑resolved Compose configuration (a non‑zero result means the file has errors). |

### Lifecycle (**W**)

| Tool | Parameters | Description |
| --- | --- | --- |
| `start_container` | `container` | Start a stopped container (no‑op if already running). |
| `stop_container` | `container`, `timeout?: number` | Graceful stop (SIGTERM → SIGKILL after `timeout` seconds, default 10). |
| `restart_container` | `container`, `timeout?: number` | Restart a container. |
| `remove_container` | `container`, `force?: boolean`, `removeVolumes?: boolean` | Remove a container. Destructive; `force` required if running. |
| `exec_in_container` | `container`, `command: string[]`, `workdir?: string` | Run a one‑off command (argument array, no shell) inside a running container. **Opt‑in only.** |

### Compose — state‑changing (**W**)

| Tool | Parameters | Description |
| --- | --- | --- |
| `deploy_stack` | `file`, `project?`, `build?: boolean`, `services?: string[]` | `docker compose up -d --remove-orphans` — deploy/refresh a stack, optionally rebuilding and scoped to services. |
| `compose_down` | `file`, `project?`, `removeVolumes?: boolean` | Stop and remove a stack. `removeVolumes` also deletes named volumes (destructive). |
| `compose_restart` | `file`, `project?`, `services?: string[]` | Restart all or selected services. |
| `compose_pull` | `file`, `project?`, `services?: string[]` | Pull the latest images for a stack (pair with `deploy_stack` for a rolling update). |

---

## 💬 Example conversations

Natural‑language prompts and the tools the model will typically reach for:

| You say… | The assistant calls… |
| --- | --- |
| “What’s running right now?” | `list_containers` |
| “Show me everything, including stopped ones.” | `list_containers { all: true }` |
| “Why did `api` crash? Last 100 lines.” | `container_logs { container: "api", tail: 100 }` |
| “Anything in the `web` logs from the last 15 minutes?” | `container_logs { container: "web", since: "15m" }` |
| “Is `db` using a lot of memory?” | `container_stats { container: "db" }` |
| “Restart `nginx`.” | `restart_container { container: "nginx" }` |
| “Deploy the stack in `./prod` and rebuild.” | `deploy_stack { file: "./prod", build: true }` |
| “Which services are up in the demo stack?” | `compose_ps { file: "examples/demo-stack" }` |
| “How much disk is Docker using?” | `disk_usage` |
| “Who built this integration?” | `about` |

Want a stack to practise on? [`examples/demo-stack/compose.yaml`](./examples/demo-stack/compose.yaml) spins up **nginx + redis**. Try: *“Deploy the demo stack, then show me its services and the web logs.”*

---

## 🗂️ Project structure

```
docker-mcp-server/
├── assets/
│   └── soyrage-banner.svg    # SoyRage Agency identity banner (this README)
├── examples/
│   ├── claude_desktop_config.json
│   └── demo-stack/
│       └── compose.yaml      # nginx + redis playground
├── src/
│   ├── index.ts              # Entry point: banner, attribution guard, wiring
│   ├── branding.ts           # SoyRage identity, ASCII banner, MCP instructions
│   ├── config.ts             # Env‑driven, validated configuration + .env loader
│   ├── logger.ts             # stderr‑only structured logger (stdout is sacred)
│   ├── docker/
│   │   ├── client.ts         # Typed dockerode wrapper + allowlist enforcement
│   │   └── compose.ts        # Safe, shell‑free `docker compose` driver
│   ├── tools/
│   │   ├── index.ts          # Registry — wires every group, honours read‑only
│   │   ├── context.ts        # Shared dependency bundle handed to each group
│   │   ├── about.ts          # Credits & welcome
│   │   ├── containers.ts     # list / inspect / stats
│   │   ├── logs.ts           # log tailing with stream demultiplexing
│   │   ├── lifecycle.ts      # start / stop / restart / remove / exec
│   │   ├── images.ts         # image inventory
│   │   ├── system.ts         # system_info / disk_usage / networks / volumes
│   │   └── compose.ts        # deploy / down / restart / pull / ps / config
│   └── utils/
│       ├── format.ts         # tables, byte & time humanisers
│       └── result.ts         # MCP result helpers + error guard
├── .env.example              # Commented configuration template
├── LICENSE                   # SoyRage Attribution License
├── NOTICE                    # Attribution notice
└── README.md
```

---

## 🧠 Design principles

1. **stdout is reserved** for the JSON‑RPC protocol stream; every diagnostic goes to **stderr**. Violating this corrupts the MCP connection — the logger enforces it.
2. **No shell interpolation.** Compose commands are spawned with an argument array, never a shell string, eliminating command‑injection risk.
3. **Fail soft.** A handler that throws returns a clean `isError` text result the model can read and recover from, instead of tearing down the transport.
4. **One concern per module.** Tools are grouped by capability; each group is a small, focused file that receives its dependencies explicitly (no globals).
5. **Tiny dependency surface.** A hand‑rolled `.env` loader keeps `dotenv` out; only `@modelcontextprotocol/sdk`, `dockerode` and `zod` are runtime dependencies.
6. **Safety by construction.** Read‑only mode and the allowlist are checked at the boundary, so an unsafe call can’t slip through a forgotten branch.

---

## 🧪 Development

```bash
npm run dev        # hot‑reload with tsx
npm run typecheck  # strict type check, no emit
npm run build      # compile to dist/
npm run start      # run the built server
npm run inspect    # launch the MCP Inspector against the built server
npm run clean      # remove dist/
```

**Coding standards:** TypeScript `strict` with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` and `noFallthroughCasesInSwitch`. Every source file carries a SoyRage Agency attribution header.

---

## 🩺 Troubleshooting & FAQ

<details>
<summary><b>“Could not reach the Docker daemon.”</b></summary>

The server started but couldn’t connect to Docker. Check that:
- Docker Desktop / the daemon is **running**.
- `DOCKER_HOST` is correct for your platform (empty = default socket).
- On Linux, your user can access the socket (`docker` group) or you’re running with sufficient permissions.

The server intentionally **keeps running** so tool calls return a friendly error inside your chat client instead of crashing.
</details>

<details>
<summary><b>Compose tools return “the `docker` CLI was not found on PATH”.</b></summary>

The Compose tools shell out to `docker compose`. Install Docker Desktop or the `docker-compose-plugin`, and make sure `docker` is on the `PATH` of the environment your MCP client launches the server in.
</details>

<details>
<summary><b>The assistant can’t see my write tools.</b></summary>

You’re probably in read‑only mode. Set `DOCKER_MCP_READONLY=false` (the default) and restart your MCP client so it re‑reads the tool list.
</details>

<details>
<summary><b>A container “is not covered by the allowlist”.</b></summary>

`DOCKER_MCP_CONTAINER_ALLOWLIST` is set and the target doesn’t match. Add its name/prefix to the list, or clear the variable to allow all.
</details>

<details>
<summary><b>Is my data sent anywhere?</b></summary>

No. This server talks only to your Docker daemon and your MCP client over local stdio. It makes no outbound network calls of its own.
</details>

---

## 🗺️ Roadmap

- [ ] `follow_logs` streaming with server‑sent progress
- [ ] Image pull/build tools with progress reporting
- [ ] Prune tools (`docker system prune`) gated behind explicit confirmation
- [ ] MCP **resources** for read‑only container/stack snapshots
- [ ] Optional Prometheus‑style metrics endpoint
- [ ] Published npm package for one‑line `npx` usage

Ideas and PRs welcome — see below.

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Open an issue describing the change before large PRs.
2. Keep the **stderr‑only logging** and **shell‑free Compose** invariants intact.
3. Retain the **SoyRage Agency** attribution headers and runtime identity (this is a license requirement).
4. Run `npm run typecheck && npm run build` before submitting.

---

## 🏢 About SoyRage Agency

<div align="center">

<a href="https://soyrage.es/"><img src="./assets/soyrage-banner.svg" alt="SoyRage Agency" width="88%"></a>

</div>

**SoyRage Agency** is a full‑stack development & infrastructure studio based in **Valencia, Spain**, building tools where **DevOps meets AI**. We craft polished, production‑minded software for developers and the self‑hosting community.

- 🌐 Web: **[soyrage.es](https://soyrage.es/)**
- 🧑‍💻 Focus: full‑stack development · infrastructure engineering · AI tooling
- 📫 Work with us: **[soyrage.es](https://soyrage.es/)**

If this project is useful to you, a ⭐ on the repo and a link back to **[soyrage.es](https://soyrage.es/)** genuinely help us keep building in the open. Thank you! 🙌

---

## 🖋️ Credits & License

<div align="center">

**Designed, built and maintained by [SoyRage Agency](https://soyrage.es/) — https://soyrage.es/**

</div>

This project is released under the **SoyRage Attribution License** (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE)). You are free to use, modify and self‑host it — **as long as the credit to SoyRage Agency stays visible**: the source headers, the `package.json` author field, and the runtime identity (ASCII banner, `about` tool and MCP `instructions`) must remain intact.

> ℹ️ **On “anti‑clone”:** software that runs on your machine can always be modified — this is not DRM. The attribution is baked in as the default everywhere so that removing it is a deliberate act, and the license makes that act a violation. For white‑labelling or a commercial license, reach out via **[soyrage.es](https://soyrage.es/)**.

<div align="center">

**© 2026 SoyRage Agency — https://soyrage.es/**

Made with ❤ in Valencia, Spain.

</div>
