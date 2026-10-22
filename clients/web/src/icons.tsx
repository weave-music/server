import type { SVGProps } from "react";

// Monochrome, inherit currentColor (so active/inactive nav states just work)
// instead of platform emoji, which render inconsistently and don't fit the
// theme.
function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="1em"
      height="1em"
      {...props}
    />
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

export function DiscoverIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16 8 14 14 8 16 10 10" />
    </Icon>
  );
}

export function QueueIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </Icon>
  );
}

export function PlaylistIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </Icon>
  );
}

export function AdminIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </Icon>
  );
}

export function DiscIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
    </Icon>
  );
}

export function RadioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <line x1="2" y1="20" x2="2.01" y2="20" />
    </Icon>
  );
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" {...props}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </Icon>
  );
}

export function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" {...props}>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </Icon>
  );
}

export function SkipBackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" {...props}>
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" strokeWidth="2.5" />
    </Icon>
  );
}

export function SkipForwardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" {...props}>
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" strokeWidth="2.5" />
    </Icon>
  );
}

export function ShuffleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </Icon>
  );
}

export function RepeatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </Icon>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <polyline points="15 18 9 12 15 6" />
    </Icon>
  );
}

export function UserIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}

const HEART_PATH = "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z";

export function HeartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d={HEART_PATH} />
    </Icon>
  );
}

export function HeartFilledIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" {...props}>
      <path d={HEART_PATH} />
    </Icon>
  );
}
