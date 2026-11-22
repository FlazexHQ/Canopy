# The canopy server image: REST, GraphQL, auth, storage, realtime, health and metrics. CANOPY_ROLE picks
# what one container runs: all (the default), api or realtime, so the container stack runs this image as
# separate services. Build from the repository root, with Canopy.js checked out next to Canopy:
#   docker build -f deploy/docker/canopy.Dockerfile --build-context canopyjs=../Canopy.js -t canopy .
# Mount policy files at /app/policies, and optionally a config file (--config). The isolated linker keeps
# workspace packages out of the root node_modules, so canopy.js (and @canopy/policy and @canopy/config, for
# older files) are linked there for policy and config files to import.

FROM rust:1.100.0-alpine@sha256:8d0e82abfdf9a38071e07cabc5afba4ddbe077631a80e4e742a760c38beadc33 AS gateway-build
WORKDIR /src
RUN apk add --no-cache build-base
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY packages/native/Cargo.toml packages/native/build.rs ./packages/native/
COPY packages/native/src ./packages/native/src
COPY packages/wasm/Cargo.toml ./packages/wasm/
COPY packages/wasm/src ./packages/wasm/src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    target="$(rustc -vV | sed -n 's/^host: //p')" \
    && RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked -p canopy-gateway --target "$target" \
    && install -m 755 "target/$target/release/canopy-gateway" /src/canopy-gateway \
    && headers="$(readelf -l -d /src/canopy-gateway)" \
    && ! printf '%s\n' "$headers" | grep -E 'INTERP|NEEDED'

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY --from=canopyjs . /Canopy.js
COPY package.json bun.lock bunfig.toml tsconfig*.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts \
    && node_modules/.bin/tsc -b /Canopy.js/src/tsconfig.json /Canopy.js/src/tsconfig.config.json \
    && bun install --frozen-lockfile --ignore-scripts
RUN bunx tsc -b packages/server
RUN bun install --frozen-lockfile --production --ignore-scripts && mkdir -p /src/storage
RUN mkdir -p node_modules/@canopy && ln -s ../../packages/policy node_modules/@canopy/policy \
    && ln -s ../../packages/config node_modules/@canopy/config \
    && ln -sfn "$(realpath --relative-to=node_modules "$(readlink -f packages/graphql/node_modules/canopy.js)")" node_modules/canopy.js \
    && test -f node_modules/canopy.js/dist/core/policy/index.js

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --chown=65532:65532 --from=build /src/storage ./storage
COPY --from=gateway-build /src/canopy-gateway /usr/local/bin/canopy-gateway
ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    METRICS_HOST=0.0.0.0 \
    CANOPY_POLICIES=/app/policies \
    CANOPY_GATEWAY_BIN=/usr/local/bin/canopy-gateway
USER 65532:65532
EXPOSE 8080 9464
ENTRYPOINT ["bun", "packages/server/dist/bin/canopy-server.js"]
