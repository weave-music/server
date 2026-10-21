import { useEffect, useState } from "react";
import { createUser, deleteUser, getRegistrationAllowed, listUsers, setRegistrationAllowed, UserInfo } from "./api";

interface Props {
  token: string;
  selfId: string;
}

export function AdminView({ token, selfId }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationAllowed, setRegistrationAllowedState] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <h2>Settings</h2>
      <label>
        <input type="checkbox" checked={registrationAllowed} onChange={toggleRegistration} />
        Allow anyone to create their own account from the login page
      </label>

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
    </section>
  );
}
