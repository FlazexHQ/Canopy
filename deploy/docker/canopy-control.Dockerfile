# Build from the repository root with the sibling Canopy.js checkout.
# docker build -f deploy/docker/canopy-control.Dockerfile --build-context canopyjs=../Canopy.js -t canopy-control .

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY --from=canopyjs . /Canopy.js
COPY package.json bun.lock bunfig.toml tsconfig*.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts \
    && node_modules/.bin/tsc -b /Canopy.js/src/tsconfig.json && bun /Canopy.js/scripts/sync-wasm.ts --dist \
    && bun install --frozen-lockfile --ignore-scripts
RUN bunx tsc -b packages/control
RUN mkdir /runtime \
    && find packages -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents '{}' /runtime \; \
    && find packages -mindepth 2 -maxdepth 2 -type d -name dist -exec cp -r --parents '{}' /runtime \;

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS production
WORKDIR /src
COPY --from=build /Canopy.js /Canopy.js
COPY package.json bun.lock bunfig.toml ./
COPY --from=build /runtime/packages ./packages
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @canopy/control
RUN mkdir -p node_modules/@canopy \
    && ln -s ../../packages/policy node_modules/@canopy/policy \
    && ln -s ../../packages/config node_modules/@canopy/config \
    && ln -sfn "$(realpath --relative-to=node_modules "$(readlink -f packages/server/node_modules/canopy.js)")" node_modules/canopy.js \
    && test -f node_modules/canopy.js/dist/policy/index.js

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY --from=production /src/node_modules ./node_modules
COPY --from=production /src/packages ./packages
ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    METRICS_HOST=0.0.0.0
USER 65532:65532
EXPOSE 8080 9464
ENTRYPOINT ["bun", "packages/control/dist/bin/canopy-control.js"]
