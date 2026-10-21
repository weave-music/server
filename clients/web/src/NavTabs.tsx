import type { ComponentType, SVGProps } from "react";
import { AdminIcon, DiscoverIcon, PlaylistIcon, QueueIcon, SearchIcon } from "./icons";

type Tab = "search" | "discover" | "queue" | "playlists" | "admin";

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
  isAdmin: boolean;
}

// Rendered twice (desktop header nav, mobile bottom tab bar) from one
// definition — CSS decides which icons/labels actually show in each spot.
export function NavTabs({ tab, setTab, queueCount, isAdmin }: Props) {
  const items = isAdmin ? [...ITEMS, { key: "admin" as Tab, label: "Admin", Icon: AdminIcon }] : ITEMS;

  return (
    <>
      {items.map((item) => (
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
