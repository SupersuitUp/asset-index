# Changelog

## 0.1.3

2026-10-08

- New optional host method `visibleNow(entry, who)`: the live check. `search` calls it for each
  ranked candidate, in ranking order, before signing a thumbnail and before `present`, and keeps
  going down the ranking until it has `limit` passing hits or runs out, so a dropped hit's slot is
  filled. At most `limit` x 3 candidates are checked per search, in parallel batches of up to 6
  (shrunk to the open slots only until a check fails), within a 6000 ms budget for the whole search,
  after which what passed is returned and the rest dropped. A throw, a timeout (1500 ms) or any
  answer but `true` drops the hit (fail closed). Without it,
  search is exactly as in 0.1.2. This replaces the `liveSearchGET` wrapper three host apps wrote
  around `GET`; the README shows how to delete one.
- `present` gains a second argument, `ctx: { who }`, the person the search is answered for. It
  still never receives the query. Existing one-argument `present` functions keep working.
- `present` and `visibleNow` receive a shallow copy of the entry, so a host that writes to it cannot
  change the hit being built.
- Only the first 20,000 characters of `present`'s `text` are read (cut without splitting a
  surrogate pair).
- NFC normalization in `terms()`, in the query, and in `title`/`snippet` matching, so a query typed
  in decomposed form matches precomposed text. Ranges index the returned, normalized strings.
  Entries indexed from decomposed text before this keep their old terms until re-indexed; nearly
  all text is already NFC.
- `assetSearchHandlers` GET: no contract change; it gets the live check through `search`.
- Words now include combining marks (`[\p{L}\p{M}\p{N}]`) in `terms()` and in highlight matching,
  and the two-character minimum counts code points. Before, Thai and Devanagari were split at every
  vowel sign or virama (नमस्ते became `नमस` and `त`). Entries indexed before 0.1.3 from text in
  scripts with combining marks should be re-indexed (a backfill sweep) to match by word; meaning
  search is unaffected.
- README: text with no spaces between words (CJK) matches as whole runs.

## 0.1.2

2026-10-08

- New optional host method `present(entry)`: returns the asset's own `{ title?, text? }`, where
  `text` is its full human text. `search` calls it only for the final hits it returns (after
  visibility), in parallel, each call caught and limited to 1500 ms, so a throw, a timeout or `null`
  leaves that hit untitled.
- The package builds the snippet from `text` using the query (the host never sees it): about 160
  characters centered on the first word that begins with a query term, from a word boundary, with
  `…` on cut ends; the first 160 characters when nothing matches. `title` is trimmed and cut at 120
  with `…`.
- `SearchHit` gains optional `title`, `snippet`, `titleMatches` and `snippetMatches`. The ranges are
  `[start, end)` JS string indices, one per matching word, sorted and non-overlapping, absent when
  nothing matched. The package never returns HTML: the UI escapes the text and wraps only the ranges.
  `assetSearchHandlers` GET returns all of it as part of the hits.
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
