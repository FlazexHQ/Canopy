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
RUN printf '%s\n' '{"server":{"metricsHost":"0.0.0.0"}}' > gateway.json
RUN install -d -o 65532 -g 65532 /src/storage

FROM scratch
WORKDIR /app
COPY --from=gateway-build /src/canopy-gateway /usr/local/bin/canopy-gateway
COPY --from=gateway-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=gateway-build /src/gateway.json ./gateway.json
COPY --from=gateway-build --chown=65532:65532 /src/storage ./storage
ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    METRICS_HOST=0.0.0.0 \
    CANOPY_POLICIES=database
USER 65532:65532
EXPOSE 8080 9464
ENTRYPOINT ["/usr/local/bin/canopy-gateway"]
CMD ["--config", "/app/gateway.json"]
