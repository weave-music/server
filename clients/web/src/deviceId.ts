import { randomId } from "./randomId";

const STORAGE_KEY = "weave.device_id";

// Stable per-browser-profile id used to tell "an update I just sent myself"
// apart from "another device changed something" in playback sync — see
// useQueue's WebSocket handling.
export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
