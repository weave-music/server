# Weave — Requirements

> Self-hosted music platform. Name: "Weave" (working/current — not finalized as a trademark, but in active use for the project).

## 1. Vision

A self-hosted music streaming + library management platform that replaces
both a streaming client (Spotify-like) and a media manager (Lidarr-like).
It should be as **flexible and extensible** as possible: any audio source —
self-hosted, streamed, or downloaded — can be plugged in, and third parties
should be able to build their own clients against the server's API.

Core differentiator: playback **seamlessly mixes downloaded and streamed
audio** behind one player, with **live handoff** between devices.

## 2. System Overview

- **Server**: Rust. Single source of truth for library, users, playback
  sessions, and provider orchestration.
- **Clients**:
  - Web client (first-party)
  - Android app, native (first-party; iOS native later)
  - Third-party clients supported via a **Subsonic-compatible API**
- **Deployment**: Docker / docker-compose, matching how self-hosters already
  run Jellyfin/the *arr stack.
- **License**: AGPL-3.0 (open source).

## 3. Users & Auth

- Multi-user, **shared library** (one library, many user accounts — like
  Plex/Jellyfin), with per-user playlists, history, and queues on top.
- Auth: both built-in username/password + API tokens **and** OIDC/SSO
  (Authelia/Authentik/Keycloak) support.
- Admin role(s) manage users, providers, and system config via a full
  web-based admin dashboard (not just config files).
- **Implemented so far**: built-in accounts (SQLite-backed, Argon2 password
  hashing, bearer-token sessions), first-run setup creates the initial admin,
  admin-only user creation endpoint. OIDC/SSO and the admin dashboard UI are
  not built yet. Database choice: SQLite (file in the `/config` volume) —
  matches Jellyfin/Navidrome/the *arr stack, no extra container to run.

## 4. Media Sources ("Providers")

Two categories of provider, under one conceptual interface:

- **Download sources** — acquire files into the local library: Lidarr,
  Soulseek (via `slskd`), yt-dlp, and others to be added over time.
- **Streaming sources** — play without necessarily owning the file:
  YouTube Music, Piped, and others.

### Extensibility approach (tech stack still being discussed)

Most known sources already expose their own API or CLI (Lidarr's REST API,
`slskd`'s HTTP API for Soulseek, yt-dlp as a subprocess). Current direction:

- Start with **compiled-in Rust trait implementations** ("connectors") for
  known sources — fast to build, no ABI issues.
- Leave room to add a **sidecar/gRPC-based provider mode** later, so
  third-party developers can implement the same provider interface
  out-of-process, in any language, without forking/rebuilding the server.
- Rejected for now: traditional dynamic-library (.so) plugins (Rust has no
  stable ABI) and WASM plugins (more complex authoring toolchain) — may be
  revisited.

### Streaming cache

Streamed audio is **cached transparently** server-side after first play, so
replays are instant and previously-streamed tracks can be marked available
offline — this is the mechanism underlying the "seamless mix" goal.

### Source/quality resolution

When multiple sources could serve the same track (e.g. a Lidarr download
and a YouTube Music stream both exist), resolution is governed by
**configurable quality profiles** (à la Lidarr/Radarr quality profiles) —
e.g. "prefer lossless > 320kbps > streamed" or "always prefer local."

### Audio format/quality

Quality is **user-configurable per profile**, not fixed — users/admins
choose their preferred tier (e.g. FLAC-first vs. storage-efficient lossy),
and the server transcodes on the fly per client/network conditions.

## 5. Library Management (Lidarr replacement)

**Full automation**, matching Lidarr's behavior:

- Monitor artists/albums for new releases.
- Automatically search configured download providers when a new release is
  detected.
- Automatically download matching the configured quality profile — no
  manual approval step required (though this should be overridable).

### Metadata

Pluggable/flexible metadata sourcing — not locked to one provider:

- MusicBrainz (primary/default)
- Last.fm
- Discogs
- Explicitly "anything goes" for future metadata sources — same
  extensibility philosophy as media providers.

## 6. Search

**Unified search**: one search box queries the local library and all
active providers simultaneously, merging results. (Not local-only with a
manual "search online" step.)

## 7. Playback & Multi-Device Sync

- **Live handoff** (Spotify Connect / Chromecast style): the server tracks
  a "now playing" session per user; any client can take remote control and
  playback continues from the exact position in real time. This is a step
  beyond Subsonic's native save/restore play-queue endpoints and will need
  its own session/control-plane design.
- Player mixes downloaded and streamed/cached audio under one queue with no
  user-visible distinction in playback behavior.

## 8. Offline (Mobile)

- **Explicit sync**: users mark albums/playlists "available offline"; the
  Android app downloads and manages them locally with a storage cap —
  similar to Spotify's offline downloads model (not automatic/background
  caching).

## 9. Social / Collaborative Features

- **Collaborative/shared playlists** — multiple users editing the same
  playlist.
- **Jam / listen-together**: a **shared queue**, not synced real-time
  playback — participants add to one shared queue, but each person's
  playback stays independent/local. (Simpler than Spotify Jam; no
  cross-device audio sync required for this feature specifically — distinct
  from the live-handoff feature in §7, which *is* about one person's
  session moving between their own devices.)
- **Recommendations/radio**: similar-artist or auto-generated radio based
  on current playback.
- **Scrobbling**: Last.fm / ListenBrainz support.

## 10. Notifications

- New release detected (from library monitoring/automation).
- Download complete / failed.
- Jam/session invites.

## 11. API

- **Subsonic-API compatible** — so existing third-party clients (e.g.
  Symfonium, DSub) work out of the box.
- Custom extensions on top for features Subsonic has no concept of: live
  handoff/session control, multi-provider search, jam shared queues,
  automation/monitoring status.

## 12. MVP Scope (v1)

Deliberately narrow, to prove the core architecture before expanding:

- Server + web client.
- One or two providers (e.g. local files + one streaming source).
- Basic playback (no live handoff, no full automation, no Android app yet).

Everything else in this document is the target full vision, to be built out
in phases after the MVP proves the core server/provider/client architecture.

## 13. Open Questions / Not Yet Decided

- Final plugin-loading architecture for third-party providers (sidecar vs.
  WASM vs. other — paused mid-discussion).
- Live-handoff session protocol details (WebSocket design, how control
  transfer is negotiated between clients).
- iOS native app timeline (explicitly deferred after Android).
- Exact admin dashboard feature list beyond users/providers/queue/storage.
