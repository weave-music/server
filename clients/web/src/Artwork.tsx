import { useState } from "react";
import { DiscIcon } from "./icons";

interface Props {
  url: string | null;
  size?: "sm" | "md" | "lg";
  alt: string;
}

// Not every provider has artwork yet (local files have no tag-based cover
// art extraction), and even when a URL exists it can 404 (not every video
// has an hqdefault.jpg) — both cases fall back to the same plain disc glyph
// rather than a broken image or an empty gap.
export function Artwork({ url, size = "sm", alt }: Props) {
  const [failed, setFailed] = useState(false);
  const className = `artwork artwork-${size}`;

  if (!url || failed) {
    return (
      <div className={`${className} artwork-placeholder`}>
        <DiscIcon />
      </div>
    );
  }
  return <img className={className} src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
