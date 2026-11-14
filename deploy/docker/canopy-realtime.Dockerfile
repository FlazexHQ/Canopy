# The canopy-realtime sidecar image (deployment mode A). Build from the repository root:
#   docker build -f deploy/docker/canopy-realtime.Dockerfile -t canopy-realtime .
# Mount policy files at /app/policies, and optionally a config file (--config). The isolated linker keeps
# workspace packages out of the root node_modules, so @canopy/policy and @canopy/config are linked there for
# policy and config files to import.

FROM oven/bun:1.4.4 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig*.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts
RUN bunx tsc -b packages/realtime
RUN bun install --frozen-lockfile --production --ignore-scripts
RUN mkdir -p node_modules/@canopy && ln -s ../../packages/policy node_modules/@canopy/policy \
    && ln -s ../../packages/config node_modules/@canopy/config

FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    METRICS_HOST=0.0.0.0 \
    CANOPY_POLICIES=/app/policies
USER 65532:65532
EXPOSE 8080 9464
ENTRYPOINT ["bun", "packages/realtime/dist/bin/canopy-realtime.js"]
