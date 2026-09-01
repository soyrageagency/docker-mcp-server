# Two-stage build: compile the TypeScript with the full toolchain, then ship
# only the runtime deps and the emitted JS on a slim base.
#
#   docker run --rm -i \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     ghcr.io/soyrageagency/docker-mcp
#
# The server speaks MCP over stdio, so keep -i (interactive) and do not
# allocate a TTY: stdout is the JSON-RPC stream. Mounting the Docker socket
# grants full control of the host daemon — pair it with DOCKER_MCP_READONLY=true
# or a container allowlist unless you mean to allow writes.
#
# For the web panel instead of the MCP server:
#   docker run --rm -p 4611:4611 -v /var/run/docker.sock:/var/run/docker.sock \
#     ghcr.io/soyrageagency/docker-mcp docker-mcp-panel

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY updates.json ./
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md LICENSE ./

# The Docker socket is normally root:docker on the host. Running as root inside
# the container is the pragmatic default here; drop to `node` and add the right
# group id (--group-add) if your host socket permissions allow it.

ENTRYPOINT ["node", "dist/index.js"]
