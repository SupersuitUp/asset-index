# Changelog

## 0.1.0

2026-10-07

- Describe at upload, find by describing: `indexAsset` writes a caption, tags, visible text, search
  terms and a 768-dimension embedding for a photo, video, voice note or text.
- `search` ranks by meaning and by word together (rank fusion), enforces `visibleTo`, signs
  thumbnails at search time, and never returns the caption.
- `sweep` retries failed entries oldest first and, with `backfill`, pages through every asset the
  app holds; entries whose asset is gone are removed.
- `assetSearchHandlers(host)`: `GET` searches for a member or the agent key, `POST` runs a sweep
  for the agent key only.
- `AssetIndexHost`, `IndexStore` and `Model` seams, with `firestoreStore`, `memoryStore` and
  `geminiModel` (embedding model pinned to `gemini-embedding-2`, 768 dimensions).
- README with the wiring recipe, environment, the three required Firestore indexes and the
  refusals.
- Publish by tag push through GitHub Actions OIDC trusted publishing.
