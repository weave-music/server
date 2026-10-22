import { useState } from "react";
import { JamRoom } from "./JamRoom";
import { joinJam } from "./jamApi";
import { useJamViewer } from "./useJam";

interface Props {
  code: string;
}

interface StoredMembership {
  token: string;
  name: string;
}

function storageKey(code: string) {
  return `weave.jam.${code}`;
}

function loadMembership(code: string): StoredMembership | null {
  try {
    const raw = sessionStorage.getItem(storageKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Rendered standalone, outside <App> and without a login — this is the
// "scan the QR, pick a name" path (see main.tsx's manual /jam/:code route).
export function JamGuestEntry({ code }: Props) {
  const [membership, setMembership] = useState<StoredMembership | null>(() => loadMembership(code));
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { state, recommendations, ended, addTrack } = useJamViewer(
    membership?.token ?? null,
    membership ? code : null,
  );

  async function join(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setJoining(true);
    setError(null);
    try {
      const result = await joinJam(code, trimmed);
      const next = { token: result.token, name: result.name };
      sessionStorage.setItem(storageKey(code), JSON.stringify(next));
      setMembership(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join this jam.");
    } finally {
      setJoining(false);
    }
  }

  if (!membership) {
    return (
      <div className="jam-guest-entry">
        <h1>Weave</h1>
        <p>You've been invited to a Jam.</p>
        <form onSubmit={join}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus maxLength={40} />
          <button type="submit" disabled={joining}>
            {joining ? "Joining…" : "Join Jam"}
          </button>
        </form>
        {error && <p className="auth-error">{error}</p>}
      </div>
    );
  }

  return (
    <JamRoom
      searchToken={membership.token}
      members={state?.members ?? []}
      queueLog={state?.queue_log ?? []}
      live={state?.live ?? null}
      recommendations={recommendations}
      ended={ended}
      onAddTrack={addTrack}
      isHost={false}
    />
  );
}
