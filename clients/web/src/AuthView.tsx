import { useEffect, useState } from "react";
import { getOidcLoginEnabled, getRegistrationAllowed, getSetupComplete, oidcLoginUrl } from "./api";

type Mode = "login" | "setup" | "register";

interface Props {
  onLogin: (username: string, password: string) => Promise<void>;
  onSetup: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
}

export function AuthView({ onLogin, onSetup, onRegister }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [registrationAllowed, setRegistrationAllowed] = useState(false);
  const [setupComplete, setSetupComplete] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRegistrationAllowed().then(setRegistrationAllowed);
    getSetupComplete().then(setSetupComplete);
    getOidcLoginEnabled().then(setSsoEnabled);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await onLogin(username, password);
      else if (mode === "setup") await onSetup(username, password);
      else await onRegister(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const submitLabel =
    mode === "login" ? "Log in" : mode === "setup" ? "Create admin account" : "Create account";

  return (
    <div className="auth-view">
      <h1>Weave</h1>
      <form onSubmit={submit}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoFocus
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </form>
      {error && <p className="auth-error">{error}</p>}

      {mode === "login" && ssoEnabled && (
        <a className="auth-toggle auth-sso-button" href={oidcLoginUrl()}>
          Log in with SSO
        </a>
      )}

      {mode === "login" && (
        <>
          {registrationAllowed && (
            <button type="button" className="auth-toggle" onClick={() => setMode("register")}>
              Need an account? Register
            </button>
          )}
          {!setupComplete && (
            <button type="button" className="auth-toggle" onClick={() => setMode("setup")}>
              First time? Set up the admin account
            </button>
          )}
        </>
      )}
      {mode !== "login" && (
        <button type="button" className="auth-toggle" onClick={() => setMode("login")}>
          Already have an account? Log in
        </button>
      )}
    </div>
  );
}
