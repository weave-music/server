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

// "Remember me" unchecked keeps the token in sessionStorage instead of
// localStorage — gone once the browser/tab closes, same as not checking the
// box anywhere else. Checking both on read means a token survives whichever
// one it was written to.
function readStoredToken(): string | null {
  return localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
}

function clearStoredToken() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => adoptTokenFromUrl() ?? readStoredToken());
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
        clearStoredToken();
        setToken(null);
      })
      .finally(() => setChecking(false));
  }, [token, fetchMe]);

  async function authenticate(
    path: "login" | "setup" | "register",
    username: string,
    password: string,
    remember = true,
  ) {
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
    clearStoredToken();
    (remember ? localStorage : sessionStorage).setItem(STORAGE_KEY, data.token);
    setToken(data.token);
    setMe(await fetchMe(data.token));
  }

  const login = useCallback(
    (username: string, password: string, remember: boolean) => authenticate("login", username, password, remember),
    [],
  );
  const setup = useCallback((username: string, password: string) => authenticate("setup", username, password), []);
  const register = useCallback(
    (username: string, password: string) => authenticate("register", username, password),
    [],
  );

  const logout = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setMe(null);
  }, []);

  return { token, me, checking, login, setup, register, logout };
}
