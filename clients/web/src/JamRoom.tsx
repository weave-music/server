import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { Artwork } from "./Artwork";
import { ChevronDownIcon, PauseIcon, PlayIcon, RepeatIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import { searchTracks } from "./api";
import {
  dedupeMembers,
  repeatModeToNumber,
  type JamLive,
  type JamMemberInfo,
  type JamQueueLogEntry,
  type JamSettings,
  type RemoteCommandName,
} from "./jamApi";
import type { Track } from "./types";
import { nextRepeatMode } from "./useQueue";

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
  // Remote controls — host-role devices can always use these (e.g. a phone
  // co-hosting the same account's jam controlling whichever device is the
  // actual source, see is_source in main.rs); guests can too, but only for
  // whatever `permissions` below allows.
  onCommand?: (command: RemoteCommandName, value?: number) => void;
  // Whether THIS device is the jam's audio source — purely cosmetic here
  // (a small "acting as a remote" label), the real enforcement happens
  // server-side/in useJam, which only ever acts on a RemoteCommand locally
  // when this device is the source.
  isSource?: boolean;
  // What GUESTS are currently allowed to do — irrelevant for isHost (the
  // account's own devices are never restricted by this). Comes from the
  // jam_state response, which is itself account-settings-backed so it
  // reflects the host's latest choice even mid-jam.
  permissions?: JamSettings;
  // Host-only: this account's persistent jam settings + a way to change
  // them. Both undefined for guests (and simply not rendered).
  settings?: JamSettings | null;
  onUpdateSettings?: (next: JamSettings) => void;
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
  onCommand,
  isSource,
  permissions,
  settings,
  onUpdateSettings,
}: Props) {
  // The account's own devices are never restricted by jam settings — those
  // only ever gate a GUEST's requests (enforced server-side too; this is
  // just so the guest UI doesn't offer controls that would 403).
  const canControlPlayback = isHost || !!permissions?.guests_can_control_playback;
  const canShuffleRepeat = isHost || !!permissions?.guests_can_shuffle_repeat;
  const canAddQueue = isHost || !!permissions?.guests_can_add_queue;
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
  const displayMembers = useMemo(() => dedupeMembers(members), [members]);

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
          {displayMembers.length} {displayMembers.length === 1 ? "person" : "people"}
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
              {displayMembers.map((member, i) => (
                <li key={`${member.name}-${i}`} className="jam-member-chip">
                  {member.name}
                  {member.is_host && <span className="jam-member-host-badge">Host</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="jam-room-section">
            <h3>Now Playing</h3>
            {isHost && onCommand && !isSource && (
              <p className="jam-remote-indicator">Acting as a remote — controls the device that started this jam.</p>
            )}
            {live?.now_playing ? (
              <div className="jam-now-playing">
                <Artwork url={live.now_playing.artwork_url} size="md" alt="" />
                <div className="jam-now-playing-text">
                  <div className="jam-now-playing-title">{live.now_playing.title}</div>
                  {live.now_playing.artist_name && (
                    <div className="jam-now-playing-subtitle">{live.now_playing.artist_name}</div>
                  )}
                </div>
                {canControlPlayback && onCommand && (
                  <div className="jam-now-playing-controls">
                    <button onClick={() => onCommand("prev")} title="Previous">
                      <SkipBackIcon />
                    </button>
                    <button onClick={() => onCommand(live.is_playing ? "pause" : "play")} title={live.is_playing ? "Pause" : "Play"}>
                      {live.is_playing ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <button onClick={() => onCommand("next")} title="Next">
                      <SkipForwardIcon />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="jam-room-empty">Nothing playing yet.</p>
            )}
            {canShuffleRepeat && onCommand && (
              <div className="jam-now-playing-controls jam-shuffle-repeat">
                <button
                  className={live?.shuffle ? "active" : ""}
                  onClick={() => onCommand("shuffle", live?.shuffle ? 0 : 1)}
                  title="Shuffle"
                >
                  <ShuffleIcon />
                </button>
                <button
                  className={live && live.repeat !== "off" ? "active" : ""}
                  onClick={() => onCommand("repeat", repeatModeToNumber(nextRepeatMode(live?.repeat ?? "off")))}
                  title="Repeat"
                >
                  <RepeatIcon />
                  {live?.repeat === "one" && <span className="repeat-one-badge">1</span>}
                </button>
              </div>
            )}
            {isHost && onCommand && (
              <div className="jam-volume-control">
                <label htmlFor="jam-volume">Volume</label>
                <input
                  id="jam-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={live?.volume ?? 1}
                  onChange={(e) => onCommand("volume", parseFloat(e.target.value))}
                />
              </div>
            )}
          </section>

          {isHost && settings && onUpdateSettings && (
            <section className="jam-room-section">
              <h3>Jam Settings</h3>
              <p className="jam-room-empty">What guests (not your own devices) can do — saved for your next jam too.</p>
              <ul className="jam-settings-list">
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.guests_can_add_queue}
                      onChange={(e) => onUpdateSettings({ ...settings, guests_can_add_queue: e.target.checked })}
                    />
                    Guests can add songs to the queue
                  </label>
                </li>
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.guests_can_control_playback}
                      onChange={(e) => onUpdateSettings({ ...settings, guests_can_control_playback: e.target.checked })}
                    />
                    Guests can play, pause, and skip
                  </label>
                </li>
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.guests_can_shuffle_repeat}
                      onChange={(e) => onUpdateSettings({ ...settings, guests_can_shuffle_repeat: e.target.checked })}
                    />
                    Guests can shuffle and repeat
                  </label>
                </li>
                <li>
                  <label>
                    End the jam automatically after
                    <select
                      value={settings.inactivity_timeout_minutes}
                      onChange={(e) => onUpdateSettings({ ...settings, inactivity_timeout_minutes: Number(e.target.value) })}
                    >
                      <option value={0}>never</option>
                      <option value={15}>15 minutes</option>
                      <option value={30}>30 minutes</option>
                      <option value={60}>1 hour</option>
                      <option value={120}>2 hours</option>
                      <option value={240}>4 hours</option>
                    </select>
                    of inactivity
                  </label>
                </li>
              </ul>
            </section>
          )}

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

            {canAddQueue && recommendations.length > 0 && (
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

          {canAddQueue ? (
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
          ) : (
            !isHost && <p className="jam-room-empty">The host has turned off adding songs for guests.</p>
          )}
        </>
      )}
    </div>
  );
}
