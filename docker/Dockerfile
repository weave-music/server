FROM rust:1-slim-bookworm AS build
WORKDIR /build
COPY server/ server/
RUN cargo build --release --manifest-path server/Cargo.toml -p weave-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp ytmusicapi \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/server/target/release/weave-server /usr/local/bin/weave-server
COPY server/scripts/ytmusic_bridge.py /usr/local/bin/ytmusic_bridge.py
RUN chmod +x /usr/local/bin/ytmusic_bridge.py
EXPOSE 4533
ENV WEAVE_LIBRARY_PATH=/music
VOLUME ["/music", "/config"]
ENTRYPOINT ["weave-server"]
