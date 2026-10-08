# Changelog

## 0.1.2

2026-10-08

- New optional host method `present(entry)`: returns the asset's own `{ title?, snippet? }`. `search`
  calls it only for the final hits it returns (after visibility), in parallel, each call caught, so a
  throw or `null` just leaves that hit untitled. `title` is trimmed and capped at 120 characters;
  `snippet` is whitespace-collapsed and capped at 160, ending in `…` when cut. `SearchHit` gains
  optional `title` and `snippet`; `assetSearchHandlers` GET returns them as part of the hits.
- `present` must return the asset's own human-written words, never the AI caption, tags or
  visibleText. The package never copies those onto a hit.
- Additive: without `present`, hits are exactly as in 0.1.1.

## 0.1.1

2026-10-07

- `indexById(host, id)`: the call to make from a finalize hook. It loads the asset, indexes it, then
  reads it again: an asset hidden or deleted while it was being described is forgotten, a narrowed
  `visibleTo` is indexed once more, and visibility that still disagrees on a third read is recorded
  failed. Answers `'indexed'`, `'failed'` or `'forgotten'` (`IndexOutcome`). Before this, a hide,
  delete or unshare landing during describe left a stale, wider entry in search for good.
- A `host.load` that throws is now recorded as a failed entry (never searchable), so the retry sweep
  picks it up instead of it never being indexed.
- `sweep` sends every id through `indexById`, each caught on its own, so one asset that throws is
  counted failed and no longer aborts the run; a retry that still cannot read an id keeps its failed
  entry. Forgotten ids count as skipped. Same options and same answer.
- `assetSearchHandlers` `POST` inherits all of this through `sweep`; its contract is unchanged.
- `indexAsset` is unchanged and still exported as the low-level call.
- Every `indexById` call, from a finalize hook or a sweep, reads the asset through `host.load` twice
  (three times when visibility changed mid-describe), against zero for `indexAsset(host, input)`.
  Keep `load` cheap or accept the extra reads.
- `indexById` never rejects: if even the failed entry cannot be written, it logs and answers
  `'failed'`. A `host.log` that throws is swallowed everywhere it is called, so it can no longer
  defeat a sweep's per-id catch or turn a handler's 500 into a rejection.

## 0.1.0

2026-10-07

- Describe at upload, find by describing: `indexAsset` writes a caption, tags, visible text, search
  terms and a 768-dimension embedding for a photo, video, voice note or text.
- `search` ranks by meaning and by word together (rank fusion), enforces `visibleTo`, signs
  thumbnails at search time, and never returns the caption.
- `sweep` retries failed entries oldest first and, with `backfill`, pages through every asset the
  app holds; a failed entry whose asset is gone is removed on the next retry sweep.
- `forgetAsset(host, id)` removes a deleted asset's entry, so it stops being searchable.
- `assetSearchHandlers(host)`: `GET` searches for a member or the agent key, `POST` runs a sweep
  for the agent key only.
- `AssetIndexHost`, `IndexStore` and `Model` seams, with `firestoreStore`, `memoryStore` and
  `geminiModel` (embedding model pinned to `gemini-embedding-2`, 768 dimensions).
- README with the wiring recipe, environment, the three required Firestore indexes and the
  refusals.
- Publish by tag push through GitHub Actions OIDC trusted publishing.
