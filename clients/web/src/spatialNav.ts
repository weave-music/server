// Geometry-based D-pad focus movement — no spatial-navigation library,
// since this is a well-known, small technique and every interactive
// element in the app is already a real, natively-focusable <button>
// (confirmed across the whole app — see the TV-support plan). Works
// generically over whatever's currently in the DOM, so it needs no
// per-view wiring: arrow keys just move `document.activeElement` to the
// closest focusable thing in the pressed direction.

export type Direction = "up" | "down" | "left" | "right";

const FOCUSABLE_SELECTOR = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function focusableCandidates(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

// Moves focus one step in `direction`, returns whether anything moved
// (callers use this to decide whether to preventDefault — if nothing
// moved, e.g. already at the edge, let the key event fall through
// normally rather than swallowing it).
export function moveFocus(direction: Direction): boolean {
  const candidates = focusableCandidates();
  if (candidates.length === 0) return false;

  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !candidates.includes(current)) {
    // Nothing sensible focused yet — land on the leftmost thing in the
    // topmost visual row. A plain top-then-left sort breaks here: two
    // buttons that are visually in the same header row can still differ
    // by a couple px in exact `top` (different padding/height before
    // flex-centering), which would otherwise let a far-right button with
    // a marginally smaller `top` win outright over the actual first
    // button in reading order. A tolerance band fixes that.
    const tops = candidates.map((el) => el.getBoundingClientRect().top);
    const minTop = Math.min(...tops);
    const topRow = candidates.filter((el) => el.getBoundingClientRect().top <= minTop + 24);
    topRow.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    topRow[0].focus();
    return true;
  }

  const fromRect = current.getBoundingClientRect();
  const fromCenter = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === current) continue;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const dx = center.x - fromCenter.x;
    const dy = center.y - fromCenter.y;

    let primary: number;
    let perpendicular: number;
    switch (direction) {
      case "up":
        if (dy >= -1) continue;
        primary = -dy;
        perpendicular = Math.abs(dx);
        break;
      case "down":
        if (dy <= 1) continue;
        primary = dy;
        perpendicular = Math.abs(dx);
        break;
      case "left":
        if (dx >= -1) continue;
        primary = -dx;
        perpendicular = Math.abs(dy);
        break;
      case "right":
        if (dx <= 1) continue;
        primary = dx;
        perpendicular = Math.abs(dy);
        break;
    }

    // Standard spatial-nav heuristic: penalize perpendicular offset more
    // heavily than primary-axis distance, so "the next item straight down
    // in this column" beats "a slightly closer item several columns over."
    const score = primary + perpendicular * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (!best) return false;
  // Native .focus() already scrolls the target into view within any
  // scrollable ancestor (e.g. a horizontal "Top Artists" row) by default,
  // so no manual scrollIntoView is needed here.
  best.focus();
  return true;
}
