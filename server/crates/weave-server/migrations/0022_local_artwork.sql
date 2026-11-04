-- Embedded cover art extracted alongside the other tags (ID3 APIC, FLAC/
-- Vorbis picture blocks, MP4 cover atoms, via lofty) — stored as a BLOB in
-- the same cache row rather than a separate file, since embedded art is
-- small enough (tens to low-hundreds of KB) for SQLite at self-hosted
-- scale, and this keeps everything in the one cache table already being
-- scanned/upserted.
ALTER TABLE local_tag_cache ADD COLUMN artwork BLOB;
ALTER TABLE local_tag_cache ADD COLUMN artwork_mime TEXT;
