import { HeartFilledIcon, HeartIcon } from "./icons";
import { useLikesContext } from "./LikesContext";
import type { Track } from "./types";

export function LikeButton({ track }: { track: Track }) {
  const { isLiked, toggleLike } = useLikesContext();
  const liked = isLiked(track);
  return (
    <button
      className={liked ? "like-button liked" : "like-button"}
      onClick={() => toggleLike(track)}
      title={liked ? "Unlike" : "Like"}
    >
      {liked ? <HeartFilledIcon /> : <HeartIcon />}
    </button>
  );
}
