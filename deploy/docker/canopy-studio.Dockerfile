# The Canopy Studio image: the admin dashboard as static files with a small Bun server, no database access
# of its own. Studio calls the admin API on the same origin, so run it behind the edge next to the api
# service. Build from the repository root, with Canopy.js checked out next to Canopy:
#   docker build -f deploy/docker/canopy-studio.Dockerfile --build-context canopyjs=../Canopy.js -t canopy-studio .

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY --from=canopyjs . /Canopy.js
COPY package.json bun.lock bunfig.toml tsconfig*.json ./
COPY packages ./packages
COPY apps/studio ./apps/studio
RUN bun install --frozen-lockfile --ignore-scripts
RUN cd apps/studio && bun --bun run build
RUN bunx tsc -b packages/studio
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && test -f packages/studio/app/index.html

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/node-http ./packages/node-http
COPY --from=build /src/packages/studio ./packages/studio
ENV NODE_ENV=production \
    PORT=8080
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["bun", "packages/studio/dist/bin/canopy-studio.js"]
