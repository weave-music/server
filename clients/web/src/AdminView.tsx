import { useEffect, useState } from "react";
import {
  createUser,
  deleteUser,
  getLidarrQualityProfiles,
  getLidarrRootFolders,
  getLidarrSettings,
  getOidcSettings,
  getRegistrationAllowed,
  listUsers,
  setLidarrSettings,
  setOidcSettings,
  setRegistrationAllowed,
  type LidarrQualityProfile,
  type LidarrRootFolder,
  UserInfo,
} from "./api";

interface Props {
  token: string;
  selfId: string;
}

type AdminTab = "general" | "users" | "sso" | "lidarr";

export function AdminView({ token, selfId }: Props) {
  const [tab, setTab] = useState<AdminTab>("general");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationAllowed, setRegistrationAllowedState] = useState(false);

  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [lidarrHasApiKey, setLidarrHasApiKey] = useState(false);
  const [lidarrRootFolder, setLidarrRootFolder] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState<number | null>(null);
  const [lidarrRootFolders, setLidarrRootFolders] = useState<LidarrRootFolder[]>([]);
  const [lidarrQualityProfiles, setLidarrQualityProfiles] = useState<LidarrQualityProfile[]>([]);
  const [lidarrStatus, setLidarrStatus] = useState<string | null>(null);

  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcHasClientSecret, setOidcHasClientSecret] = useState(false);
  const [oidcStatus, setOidcStatus] = useState<string | null>(null);

  async function refresh() {
    try {
      setUsers(await listUsers(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users.");
    }
  }

  useEffect(() => {
    refresh();
    getRegistrationAllowed().then(setRegistrationAllowedState);
    getLidarrSettings(token).then((s) => {
      setLidarrUrl(s.url);
      setLidarrHasApiKey(s.has_api_key);
      setLidarrRootFolder(s.root_folder);
      setLidarrQualityProfileId(s.quality_profile_id);
    });
    getOidcSettings(token).then((s) => {
      setOidcIssuer(s.issuer);
      setOidcClientId(s.client_id);
      setOidcHasClientSecret(s.has_client_secret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveLidarrConnection() {
    setLidarrStatus(null);
    try {
      await setLidarrSettings(token, {
        url: lidarrUrl,
        api_key: lidarrApiKey || undefined,
        root_folder: lidarrRootFolder,
        quality_profile_id: lidarrQualityProfileId,
      });
      setLidarrApiKey("");
      setLidarrHasApiKey(lidarrHasApiKey || !!lidarrApiKey);
      setLidarrStatus("Saved.");
    } catch (err) {
      setLidarrStatus(err instanceof Error ? err.message : "Could not save Lidarr settings.");
    }
  }

  function submitLidarrConnection(e: React.FormEvent) {
    e.preventDefault();
    void saveLidarrConnection();
  }

  async function loadLidarrPickers() {
    setLidarrStatus(null);
    try {
      const [folders, profiles] = await Promise.all([getLidarrRootFolders(token), getLidarrQualityProfiles(token)]);
      setLidarrRootFolders(folders);
      setLidarrQualityProfiles(profiles);
    } catch (err) {
      setLidarrStatus(err instanceof Error ? err.message : "Could not reach Lidarr.");
    }
  }

  async function saveOidcSettings(e: React.FormEvent) {
    e.preventDefault();
    setOidcStatus(null);
    try {
      await setOidcSettings(token, {
        issuer: oidcIssuer,
        client_id: oidcClientId,
        client_secret: oidcClientSecret || undefined,
      });
      setOidcClientSecret("");
      setOidcHasClientSecret(oidcHasClientSecret || !!oidcClientSecret);
      setOidcStatus("Saved.");
    } catch (err) {
      setOidcStatus(err instanceof Error ? err.message : "Could not save SSO settings.");
    }
  }

  async function toggleRegistration(e: React.ChangeEvent<HTMLInputElement>) {
    const allow = e.target.checked;
    setRegistrationAllowedState(allow);
    try {
      await setRegistrationAllowed(token, allow);
    } catch (err) {
      setRegistrationAllowedState(!allow);
      setError(err instanceof Error ? err.message : "Could not update setting.");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createUser(token, username, password, isAdmin);
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user.");
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteUser(token, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete user.");
    }
  }

  return (
    <section>
      <div className="filter-tabs">
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
          General
        </button>
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
          Users
        </button>
        <button className={tab === "sso" ? "active" : ""} onClick={() => setTab("sso")}>
          Single Sign-On
        </button>
        <button className={tab === "lidarr" ? "active" : ""} onClick={() => setTab("lidarr")}>
          Lidarr
        </button>
      </div>

      {tab === "general" && (
        <>
          <h2>Settings</h2>
          <label>
            <input type="checkbox" checked={registrationAllowed} onChange={toggleRegistration} />
            Allow anyone to create their own account from the login page
          </label>
        </>
      )}

      {tab === "sso" && (
        <>
          <h2>Single Sign-On (OIDC)</h2>
          <p className="jam-room-empty">
            Works with any standards-compliant provider — Authelia, Authentik, Keycloak, etc. Leave the issuer blank
            to disable.
          </p>
          <form onSubmit={saveOidcSettings} className="admin-settings-form">
            <input
              value={oidcIssuer}
              onChange={(e) => setOidcIssuer(e.target.value)}
              placeholder="Issuer URL (e.g. https://auth.example.com)"
            />
            <input value={oidcClientId} onChange={(e) => setOidcClientId(e.target.value)} placeholder="Client ID" />
            <input
              type="password"
              value={oidcClientSecret}
              onChange={(e) => setOidcClientSecret(e.target.value)}
              placeholder={oidcHasClientSecret ? "Client secret (set — leave blank to keep)" : "Client secret"}
            />
            <button type="submit">Save SSO settings</button>
          </form>
          {oidcStatus && <p className="jam-room-empty">{oidcStatus}</p>}
        </>
      )}

      {tab === "lidarr" && (
        <>
          <h2>Lidarr</h2>
          <p className="jam-room-empty">Lets any user request an artist Lidarr doesn't have yet from search.</p>
          <form onSubmit={submitLidarrConnection} className="admin-settings-form">
            <input
              value={lidarrUrl}
              onChange={(e) => setLidarrUrl(e.target.value)}
              placeholder="Lidarr URL (e.g. http://lidarr:8686)"
            />
            <input
              type="password"
              value={lidarrApiKey}
              onChange={(e) => setLidarrApiKey(e.target.value)}
              placeholder={lidarrHasApiKey ? "API key (set — leave blank to keep)" : "API key"}
            />
            <button type="submit">Save connection</button>
          </form>
          <div className="admin-settings-form">
            <button type="button" onClick={loadLidarrPickers}>
              Load root folders &amp; quality profiles
            </button>
            {lidarrRootFolders.length > 0 && (
              <select value={lidarrRootFolder} onChange={(e) => setLidarrRootFolder(e.target.value)}>
                <option value="">Root folder…</option>
                {lidarrRootFolders.map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
            )}
            {lidarrQualityProfiles.length > 0 && (
              <select
                value={lidarrQualityProfileId ?? ""}
                onChange={(e) => setLidarrQualityProfileId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Quality profile…</option>
                {lidarrQualityProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {(lidarrRootFolder || lidarrQualityProfileId) && (
              <button type="button" onClick={() => saveLidarrConnection()}>
                Save root folder &amp; quality profile
              </button>
            )}
          </div>
          {lidarrStatus && <p className="jam-room-empty">{lidarrStatus}</p>}
        </>
      )}

      {tab === "users" && (
        <>
          <h2>Users</h2>
          <form onSubmit={submit}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
            <label>
              <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
              Admin
            </label>
            <button type="submit">Create user</button>
          </form>
          {error && <p className="auth-error">{error}</p>}
          <ul className="track-list">
            {users.map((u) => (
              <li key={u.id}>
                <span className="track-title">
                  {u.username} {u.is_admin && <span className="tag">admin</span>}
                </span>
                <button onClick={() => remove(u.id)} disabled={u.id === selfId} title="Delete user">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
