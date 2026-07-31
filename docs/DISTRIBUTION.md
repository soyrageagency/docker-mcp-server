# Install & update system — the portable SoyRage drop-in

This repo carries a small, self-contained system that gives **any** SoyRage
project two things every user wants:

1. **One-command install with no Node and no npm** — a single standalone binary
   per OS, built with Node's Single Executable Applications (SEA).
2. **In-app update notices with changelogs** — read from one JSON in the repo,
   surfaced in both the terminal and the web UI, silent on failure, opt-out-able.

It's designed to be **copied into `docker`, `proxmox`, `vmware-to-proxmox`** and
any future repo with only a handful of values changed. Everything below is the
same pattern in every repo, so users learn it once.

---

## The files (copy these into another repo)

| File | Role |
|---|---|
| `scripts/build-sea.mjs` | Bundles `dist/` with esbuild → embeds assets → generates the SEA blob → injects it with postject. Produces `build/<bin>`. |
| `scripts/sea-stub-ssh2.cjs` | Empty stand-in so dockerode/ssh clients don't drag a native addon into the binary (only needed for repos that use `dockerode`/`ssh2`). |
| `scripts/install.ps1` | Windows one-liner: downloads the latest release asset to `%LOCALAPPDATA%\Programs\<bin>` and adds it to PATH. |
| `scripts/install.sh` | Linux/macOS one-liner: downloads the right asset to `~/.local/bin`. |
| `.github/workflows/release.yml` | On a `v*` tag, builds the binary on Windows/macOS-x64/macOS-arm64/Linux and attaches them to the GitHub Release. |
| `src/assets.ts` | Reads bundled assets from the SEA blob when packaged, else from disk. |
| `src/entry.ts` | `isEntryPoint()` — lets one file be both a standalone bin and something the launcher imports; returns `false` when packaged. |
| `src/update/channel.ts` | Fetch + semver-compare + cache + bundled-fallback update channel. |
| `updates.json` | The published channel document (the source of truth for "is there an update"). |

## The values to change per repo (that's it)

1. **Repo slug** — `soyrageagency/<repo>` in `install.ps1`, `install.sh`, and
   `channelUrl()` in `src/update/channel.ts` (the `DOCKER_MCP_UPDATE_URL` default).
2. **Binary / product name** — `ragedocker` → your bin, the asset names in
   `install.*` and `release.yml`, and the `matrix.asset` values.
3. **Entry point** — `dist/<launcher>.js` in `build-sea.mjs` (`entryPoints`).
4. **Opt-out env var** — `DOCKER_MCP_NO_UPDATE_CHECK` / `RAGEDOCKER_NO_UPDATE_CHECK`
   → your project's prefix, in `updatesDisabled()`.

Everything else — the SEA plumbing, asset embedding, caching, the banner UIs — is
identical across repos.

---

## How a user installs (no Node, no npm)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/scripts/install.ps1 | iex
```

**Linux / macOS:**
```sh
curl -fsSL https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/scripts/install.sh | sh
```

Both download a single ~90 MB executable (a Node runtime + the app fused into one
file) and put it on `PATH`. Re-running the same command updates in place.

The **npm path still works** for developers: `npm i -g docker-mcp-server`.

## How a maintainer ships a release

1. Bump the version in the four spots (`package.json`, `package-lock.json` ×2,
   `src/branding.ts`) and add a `releases[]` entry + bump `latest` in `updates.json`.
2. Commit, then `git tag vX.Y.Z && git push --tags`.
3. `release.yml` builds all four binaries and publishes the GitHub Release.
4. Running installs pick up the update notice within the cache TTL (6 h); the
   install one-liner re-run upgrades immediately.

## Build a binary locally

```bash
npm run build:sea      # → build/ragedocker(.exe)
./build/ragedocker version
```

Requires Node ≥ 20 (for SEA) and the `esbuild` + `postject` devDependencies.

---

Crafted by **SoyRage Agency** — https://soyrage.es/
