import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "weave.token";

interface Me {
  id: string;
  username: string;
  is_admin: boolean;
}

// A successful SSO login redirects back here as `/?token=...` (see
// oidc_callback in main.rs) — adopt it into normal token storage and strip
// it from the URL immediately so it doesn't linger in history/bookmarks.
function adoptTokenFromUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (!token) return null;
  localStorage.setItem(STORAGE_KEY, token);
  params.delete("token");
  const url = new URL(location.href);
  url.search = params.toString();
  history.replaceState(null, "", url.toString());
  return token;
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => adoptTokenFromUrl() ?? localStorage.getItem(STORAGE_KEY));
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  const fetchMe = useCallback(async (t: string) => {
    const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${t}` } });
    if (!res.ok) throw new Error("invalid session");
    return (await res.json()) as Me;
  }, []);

  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    fetchMe(token)
      .then(setMe)
      .catch(() => {
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
      })
      .finally(() => setChecking(false));
  }, [token, fetchMe]);

  async function authenticate(path: "login" | "setup" | "register", username: string, password: string) {
    const res = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const message =
        res.status === 409
          ? "Setup already completed — log in instead."
          : res.status === 403
            ? "Registration is currently disabled by the admin."
            : "Invalid username or password.";
      throw new Error(message);
    }
    const data = await res.json();
    localStorage.setItem(STORAGE_KEY, data.token);
    setToken(data.token);
    setMe(await fetchMe(data.token));
  }

  const login = useCallback((username: string, password: string) => authenticate("login", username, password), []);
  const setup = useCallback((username: string, password: string) => authenticate("setup", username, password), []);
  const register = useCallback(
    (username: string, password: string) => authenticate("register", username, password),
    [],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setMe(null);
  }, []);

  return { token, me, checking, login, setup, register, logout };
}
