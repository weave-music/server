import { createContext, useContext } from "react";
import type { Track } from "./types";

interface LikesContextValue {
  isLiked: (track: Track) => boolean;
  toggleLike: (track: Track) => void;
}

const LikesContext = createContext<LikesContextValue>({
  isLiked: () => false,
  toggleLike: () => {},
});

export const LikesProvider = LikesContext.Provider;

export function useLikesContext() {
  return useContext(LikesContext);
}
