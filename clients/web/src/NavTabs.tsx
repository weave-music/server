import type { ComponentType, SVGProps } from "react";
import { DiscoverIcon, PlaylistIcon, QueueIcon, SearchIcon } from "./icons";

type Tab = "search" | "discover" | "queue" | "playlists" | "profile" | "admin";

interface Item {
  key: Tab;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const ITEMS: Item[] = [
  { key: "search", label: "Search", Icon: SearchIcon },
  { key: "discover", label: "Discover", Icon: DiscoverIcon },
  { key: "queue", label: "Queue", Icon: QueueIcon },
  { key: "playlists", label: "Playlists", Icon: PlaylistIcon },
];

interface Props {
  tab: Tab;
  setTab: (tab: Tab) => void;
  queueCount: number;
}

// Rendered twice (desktop header nav, mobile bottom tab bar) from one
// definition — CSS decides which icons/labels actually show in each spot.
// Profile/Admin live in the header's own icon-button cluster instead (see
// App.tsx), not in this shared list — they're account-level, not content
// tabs, and stay in the top bar on mobile rather than crowding the bottom
// bar.
export function NavTabs({ tab, setTab, queueCount }: Props) {
  return (
    <>
      {ITEMS.map((item) => (
        <button key={item.key} className={tab === item.key ? "active" : ""} onClick={() => setTab(item.key)}>
          <item.Icon className="nav-icon" />
          <span className="nav-label">
            {item.label}
            {item.key === "queue" && ` (${queueCount})`}
          </span>
        </button>
      ))}
    </>
  );
}
