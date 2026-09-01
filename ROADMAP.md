# Roadmap

What this project is for, what already works, and what comes next.

The goal is narrow on purpose: **let anyone run a Docker host by talking to
it**, without giving up the safety rails that keep a natural-language interface
from being a liability. Everything below is judged against that.

Dates are targets, not promises. If something slips it is because it was not
ready, and shipping a half-finished tool that holds your Docker socket is worse
than being late.

---

## Shipped

### v1.1 — the foundation
- **21 tools** across containers, logs, images, networks, volumes, system
  insight, lifecycle and Compose.
- **Safety rails that are on by default**: global read-only mode, a container
  allowlist, exec into containers **off** unless you turn it on, and no shell
  interpolation anywhere near Compose.
- **A modular plugin system** — load exactly the surface you want, from
  *insight only* to the full toolbox, without touching code.
- **Live web panel** — containers, logs, a file browser and editor, backups,
  alerts, a terminal and Prometheus metrics at `/metrics`.
- **Terminal dashboard (`ragedocker`)** with an AI copilot.
- **Standalone binaries** for Linux, macOS and Windows — no Node, no npm.

### Since v1.1
- **Streamable HTTP transport.** stdio means one server per client, on the
  client's machine — backwards when the daemon you want to manage lives on a
  server. `DOCKER_MCP_HTTP=true` runs one instance beside the daemon that every
  machine on your network connects to. Bearer auth, DNS-rebinding protection,
  loopback by default.
- **Diagnostics.** `host_health` answers "is anything wrong?" in one call —
  failing healthchecks, crash loops, containers down despite a restart policy,
  and disk pressure. `find_restart_loops` returns the offenders *with the tail
  of their logs*, which is where the reason almost always is.
  `find_unused_resources` breaks down reclaimable space and refuses to be glib
  about volumes.
- **MCP prompts and resources.** Tools only answer questions you already knew
  how to ask. Prompts make *debug this container*, *audit my host*, *review my
  Compose file* and *free up disk* discoverable in the client itself.
- **MIT licensed**, on npm as `@soyrageagency/docker-mcp`, and on the official
  MCP registry.

---

## Next

### Now — run it as a container, properly
- A multi-arch `ghcr.io` image, published from the release workflow.
- A documented Compose file for the panel + MCP server together.
- A socket-proxy recipe, so the server gets the narrow subset of the Docker API
  it needs instead of unrestricted root over your host.

### Next — make the safety rails finer
Read-only or read-write is a blunt instrument. What people actually want is
"you may restart the web container, but never touch the database".
- Per-tool permissions, not just per-plugin.
- A dry-run mode that reports what *would* happen.
- An audit log of every mutating call, with who asked and what the assistant
  did.

### Later — the things that need real design first
- **Image update checking.** "Which of my containers are running an image with
  a newer tag upstream?" is the single most requested homelab question. Doing
  it properly means talking to several registries, handling anonymous rate
  limits and digest comparison — and doing it badly means confidently wrong
  answers about whether you are up to date.
- **Metrics history.** Tools answer about *now*. "Has this container been
  slowly leaking memory for a month?" needs stored history, which needs a
  storage decision that does not turn a small tool into a database server.
- **Swarm and multi-host.** One server, several daemons, without the tool
  surface doubling.

---

## Not planned

Some things are deliberately out of scope. Saying so is more useful than a
silent backlog:

- **A replacement for Portainer.** This is for the questions that are awkward
  to click through, not for the ones that are already one click away.
- **Autonomous action.** The server will not decide on its own to redeploy your
  stack at 3am. Destructive operations stay behind explicit confirmation, and
  that is not a limitation to be optimised away.
- **Telemetry.** No usage data leaves your machine. There is no analytics
  endpoint and there will not be one.

---

## Have an opinion?

The most useful thing you can send is *what you tried to ask your host and
couldn't*. Open an [issue](https://github.com/soyrageagency/docker-mcp-server/issues)
or a [discussion](https://github.com/soyrageagency/docker-mcp-server/discussions) —
a concrete missing question beats a feature request.
