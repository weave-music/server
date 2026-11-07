import { useEffect, useRef } from "react";

type CloseFn = () => void;

// Module-level, not Context — every overlay/menu in the app already
// manages its own open/close `useState` independently (TrackOverflowMenu,
// AddToPlaylistMenu, App.tsx's nowPlayingOpen/detail/jamPanelOpen,
// JamRoom's invite/settings popups), so this just needs a shared place to
// register "what's currently open, and how to close it" without lifting
// any of that state — components keep owning their own state, they just
// also call this hook.
const stack: CloseFn[] = [];

// Registers `onClose` while `isOpen` is true, in registration order (last
// opened = first closed by Back, matching the existing backdrop-click
// behavior each of these already has). The wrapper pushed onto the stack
// has a stable identity across re-renders (via a ref to the latest
// `onClose`), so callers don't need to memoize `onClose` themselves.
export function useBackHandler(isOpen: boolean, onClose: CloseFn) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const wrapper: CloseFn = () => onCloseRef.current();
    stack.push(wrapper);
    return () => {
      const idx = stack.lastIndexOf(wrapper);
      if (idx !== -1) stack.splice(idx, 1);
    };
  }, [isOpen]);
}

// Called by the global Back listener. Pops and runs the topmost
// registered close handler. Returns whether anything was actually open,
// so the caller can decide whether Back should do something else (e.g.
// let the platform's own exit-the-app behavior run) when nothing was.
export function popBackStack(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top();
  return true;
}
