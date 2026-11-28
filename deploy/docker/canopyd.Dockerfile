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
    && RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked -p canopyd --target "$target" \
    && install -m 755 "target/$target/release/canopyd" /src/canopyd \
    && headers="$(readelf -l -d /src/canopyd)" \
    && ! printf '%s\n' "$headers" | grep -E 'INTERP|NEEDED'
RUN printf '%s\n' '{"server":{"metricsHost":"0.0.0.0"}}' > gateway.json
RUN install -d -o 65532 -g 65532 /src/storage

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS studio-build
WORKDIR /src
COPY --from=canopyjs . /Canopy.js
COPY package.json bun.lock bunfig.toml tsconfig*.json ./
COPY packages ./packages
COPY apps/studio ./apps/studio
RUN bun install --frozen-lockfile --ignore-scripts
WORKDIR /src/apps/studio
RUN bun --bun run build --outDir /src/studio-assets && test -f /src/studio-assets/index.html

FROM scratch
WORKDIR /app
COPY --from=gateway-build /src/canopyd /usr/local/bin/canopyd
COPY --from=gateway-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=gateway-build /src/gateway.json ./gateway.json
COPY --from=gateway-build --chown=65532:65532 /src/storage ./storage
COPY --from=studio-build /src/studio-assets /app/studio
ENV CANOPY_STUDIO_DIR=/app/studio \
    NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    METRICS_HOST=0.0.0.0 \
    CANOPY_POLICIES=database
USER 65532:65532
EXPOSE 8080 9464
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD ["/usr/local/bin/canopyd", "--probe"]
ENTRYPOINT ["/usr/local/bin/canopyd"]
CMD ["--config", "/app/gateway.json"]
