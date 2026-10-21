import { useRef, useState } from "react";

interface TrackSource {
  provider_id: string;
  source_ref: string;
  is_local: boolean;
  is_lossless: boolean;
}

interface Track {
  id: string;
  title: string;
  duration_secs: number | null;
  sources: TrackSource[];
}

export default function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    setResults(data.results ?? []);
  }

  function play(track: Track) {
    const source = track.sources[0];
    if (!source || !audioRef.current) return;
    const url = `/api/stream?provider=${encodeURIComponent(source.provider_id)}&ref=${encodeURIComponent(source.source_ref)}`;
    audioRef.current.src = url;
    audioRef.current.play();
    setNowPlaying(track.title);
  }

  return (
    <main>
      <h1>Weave</h1>
      <form onSubmit={runSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library and providers..."
        />
        <button type="submit">Search</button>
      </form>
      <ul>
        {results.map((track) => {
          const source = track.sources[0];
          return (
            <li key={track.id}>
              <button onClick={() => play(track)}>▶</button>{" "}
              {track.title}{" "}
              {source && (
                <span className="tag">{source.is_local ? "local" : "streamed"}</span>
              )}
            </li>
          );
        })}
      </ul>
      {nowPlaying && <p>Now playing: {nowPlaying}</p>}
      <audio ref={audioRef} controls />
    </main>
  );
}
