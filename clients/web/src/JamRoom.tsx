import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { Artwork } from "./Artwork";
import { ChevronDownIcon } from "./icons";
import { searchTracks } from "./api";
import type { JamLive, JamMemberInfo, JamQueueLogEntry } from "./jamApi";
import type { Track } from "./types";

interface Props {
  // Login token for the host, jam-scoped token for a guest — either works
  // against /api/search (see Searcher in auth.rs).
  searchToken: string;
  members: JamMemberInfo[];
  queueLog: JamQueueLogEntry[];
  live: JamLive | null;
  recommendations: Track[];
  ended: boolean;
  onAddTrack: (track: Track) => void;
  isHost: boolean;
  joinUrl?: string | null;
  onEndJam?: () => void;
  onClose?: () => void;
}

function sourceKey(track: Track): string | null {
  const s = track.sources[0];
  return s ? `${s.provider_id}:${s.source_ref}` : null;
}

function trackRow(track: Track, key: string, action: React.ReactNode) {
  return (
    <li key={key}>
      <div className="track-main">
        <Artwork url={track.artwork_url} alt="" />
        <span className="track-title">{track.title}</span>
      </div>
      <div className="track-actions">{action}</div>
    </li>
  );
}

export function JamRoom({
  searchToken,
  members,
  queueLog,
  live,
  recommendations,
  ended,
  onAddTrack,
  isHost,
  joinUrl,
  onEndJam,
  onClose,
}: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  // Pops up automatically the moment a jam exists to join, and again
  // whenever a new jam starts (joinUrl changing from null to a fresh code)
  // — minimizing just hides the popup, the jam itself keeps running.
  const [inviteMinimized, setInviteMinimized] = useState(false);

  useEffect(() => {
    if (!joinUrl) {
      setQrDataUrl(null);
      return;
    }
    setInviteMinimized(false);
    QRCode.toDataURL(joinUrl, { margin: 1, width: 220 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [joinUrl]);

  // Most recent log entry for a given track's source wins — good enough to
  // show "who added this" without the server needing to track consumption.
  const attributionBySource = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of queueLog) {
      const key = sourceKey(entry.track);
      if (key) map.set(key, entry.added_by_name);
    }
    return map;
  }, [queueLog]);

  function attributionFor(track: Track): string {
    const key = sourceKey(track);
    return (key && attributionBySource.get(key)) || "the host";
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    try {
      setResults(await searchTracks(term, searchToken));
    } finally {
      setSearching(false);
    }
  }

  const joinCode = joinUrl?.split("/").pop();

  return (
    <div className="jam-room">
      <div className="jam-room-topbar">
        {onClose && (
          <button onClick={onClose} title="Close">
            <ChevronDownIcon />
          </button>
        )}
        <span>{isHost ? "Your Jam" : "Weave Jam"}</span>
        <span className="jam-room-members">
          {members.length} {members.length === 1 ? "person" : "people"}
        </span>
      </div>

      {ended ? (
        <p className="jam-room-empty">This jam has ended.</p>
      ) : (
        <>
          {isHost && joinUrl && (
            <div className="jam-room-invite-bar">
              <button className="jam-room-invite-chip" onClick={() => setInviteMinimized(false)}>
                Invite people · {joinCode}
              </button>
              {onEndJam && (
                <button className="jam-room-end" onClick={onEndJam}>
                  End Jam
                </button>
              )}
            </div>
          )}

          {isHost && joinUrl && !inviteMinimized && (
            <>
              <div className="jam-invite-backdrop" onClick={() => setInviteMinimized(true)} />
              <div className="jam-invite-popup" role="dialog" aria-label="Invite people to this jam">
                <h3>Invite people to your Jam</h3>
                {qrDataUrl && <img className="jam-room-qr" src={qrDataUrl} alt="QR code to join this jam" />}
                <div className="jam-room-code">{joinCode}</div>
                <p className="jam-room-url">Scan to join, or go to {joinUrl}</p>
                <button className="jam-invite-minimize" onClick={() => setInviteMinimized(true)}>
                  Minimize
                </button>
              </div>
            </>
          )}

          <section className="jam-room-section">
            <h3>Who's Here</h3>
            <ul className="jam-member-list">
              {members.map((member, i) => (
                <li key={`${member.name}-${i}`} className="jam-member-chip">
                  {member.name}
                  {member.is_host && <span className="jam-member-host-badge">Host</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="jam-room-section">
            <h3>Now Playing</h3>
            {live?.now_playing ? (
              <div className="jam-now-playing">
                <Artwork url={live.now_playing.artwork_url} size="md" alt="" />
                <div className="jam-now-playing-text">
                  <div className="jam-now-playing-title">{live.now_playing.title}</div>
                  {live.now_playing.artist_name && (
                    <div className="jam-now-playing-subtitle">{live.now_playing.artist_name}</div>
                  )}
                </div>
              </div>
            ) : (
              <p className="jam-room-empty">Nothing playing yet.</p>
            )}
          </section>

          <div className="jam-room-columns">
            <section className="jam-room-section">
              <h3>Up Next</h3>
              {(live?.upcoming ?? []).length === 0 ? (
                <p className="jam-room-empty">Queue is empty — add a song below.</p>
              ) : (
                <ul className="track-list">
                  {live!.upcoming.map((track, i) =>
                    trackRow(
                      track,
                      `${sourceKey(track)}-${i}`,
                      <span className="jam-added-by">Added by {attributionFor(track)}</span>,
                    ),
                  )}
                </ul>
              )}
            </section>

            {recommendations.length > 0 && (
              <section className="jam-room-section">
                <h3>Recommended</h3>
                <ul className="track-list">
                  {recommendations.map((track) =>
                    trackRow(
                      track,
                      track.id,
                      <button onClick={() => onAddTrack(track)} title="Add to jam">
                        + Add
                      </button>,
                    ),
                  )}
                </ul>
              </section>
            )}
          </div>

          <section className="jam-room-section">
            <h3>Add a song</h3>
            <form className="jam-room-search-form" onSubmit={runSearch}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your library and providers..."
                aria-label="Search for a song to add"
              />
              <button type="submit" disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </button>
            </form>
            {results.length > 0 && (
              <ul className="track-list">
                {results.map((track) =>
                  trackRow(
                    track,
                    track.id,
                    <button onClick={() => onAddTrack(track)} title="Add to jam">
                      + Add
                    </button>,
                  ),
                )}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
