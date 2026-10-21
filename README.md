# Weave

A self-hosted music streaming and library-management platform. Server in
Rust, with a pluggable provider architecture so any source — self-hosted,
streamed, or downloaded — can feed one unified, seamless player.

Full requirements and design decisions: [`REQUIREMENTS.md`](./REQUIREMENTS.md).

## Layout

- `server/` — Rust workspace (Cargo).
  - `weave-core` — domain types and the `MediaProvider` trait every source implements.
  - `weave-server` — the HTTP server (Axum), Subsonic-API-compatible.
  - `weave-provider-local` — reads tracks from a local directory. First provider; more to follow (YouTube Music, Piped, Soulseek/slskd, Lidarr, yt-dlp, ...).
- `clients/web/` — first-party web client (React + TypeScript + Vite).
- `clients/android/` — native Android client. Not started yet; post-MVP.
- `docker/` — `Dockerfile` and `docker-compose.yml` for running the server.

## Status

Early scaffold only. Current MVP target (REQUIREMENTS.md §12): server +
web client + local files + one streaming provider + basic playback. No
automation, no live handoff, no Android app yet.

## Running the server

Requires a Rust toolchain (not installed in the environment this was
scaffolded in — install via [rustup](https://rustup.rs) or build inside
Docker).

```sh
cd server
WEAVE_LIBRARY_PATH=/path/to/music cargo run -p weave-server
```

Or via Docker:

```sh
cd docker
docker compose up --build
```

## Running the web client

Requires Node.js (not installed in the environment this was scaffolded in).

```sh
cd clients/web
npm install
npm run dev
```
