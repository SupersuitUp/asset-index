# @supersuit/asset-index

Find anything uploaded to an app by describing it. When a photo, video, voice note or text is
uploaded, a model describes it once (a caption, tags, any words visible in it) and an embedding is
written beside the description. Later a person types what they remember ("the dog at the beach",
"the receipt from the hardware store") and gets the matching assets back, ranked by meaning and by
word together.

The package knows how the feature works: describing, indexing, ranking, visibility, retry and
backfill, and the request handlers. The app says who the people are, where its assets live, and
where the index is kept.

## 30 seconds

```ts
// src/app/api/asset-search/route.ts
import { assetSearchHandlers } from '@supersuit/asset-index/server'
import { host } from '@/lib/asset-host'

export const runtime = 'nodejs'
export const { GET, POST } = assetSearchHandlers(host)
```

## Install

```bash
npm install @supersuit/asset-index firebase-admin @google/genai
```

`next` and `server-only` are peer dependencies a Next app already has. Node 20.18.1 or later. Two entry points:

- `@supersuit/asset-index`: the types and the pure rules, safe anywhere (`AssetInput`,
  `IndexEntry`, `SearchHit`, `Description`, `AssetKind`, `EMBED_DIMENSIONS`,
  `DEFAULT_DESCRIBE_MODEL`, `DEFAULT_EMBED_MODEL`).
- `@supersuit/asset-index/server`: `indexById`, `indexAsset`, `forgetAsset`, `search`, `sweep`, `assetSearchHandlers`,
  `firestoreStore`, `memoryStore`, `geminiModel`, and the `AssetIndexHost`, `IndexStore`,
  `Model` and `IndexOutcome` types. Server only: it imports `server-only`, so a client bundle that reaches it fails to
  build.

```ts
import type { AssetInput, SearchHit } from '@supersuit/asset-index'
import { indexById, firestoreStore, geminiModel } from '@supersuit/asset-index/server'
```

## The host

The app implements `AssetIndexHost<M>`, where `M` is the app's member id type.

```ts
export interface AssetIndexHost<M extends string> {
  member(req: Request): Promise<M | null>
  agentMember?(req: Request): Promise<M | null>
  people(): Promise<{ id: M; name: string }[]>
  store: IndexStore
  model: Model
  signedUrl(path: string): Promise<string>
  /** Reads one asset as it is now; null if it no longer exists or must not be searchable. */
  load(id: string): Promise<AssetInput | null>
  /** Ids of every asset the app holds, for backfill. Paged by cursor. */
  listAll(cursor: string | null, limit: number): Promise<{ ids: string[]; next: string | null }>
  /** Optional. Whether `who` may open this asset right now, read from its live record. */
  visibleNow?(entry: IndexEntry, who: M): Promise<boolean>
  /** Optional. The asset's own title and a short snippet, for the hits a search returns. */
  present?(entry: IndexEntry, ctx: { who: M }): Promise<{ title?: string; text?: string } | null>
  log?(msg: string, err?: unknown): void
}
```

- `member(req)`: who is signed in for this request, or `null`. Search is answered for this person.
- `agentMember(req)`: optional. Who an agent key acts as, or `null`. Required for the sweep route,
  which only an agent key may call. Search accepts either.
- `people()`: everyone in the app. Names are handed to the describing model so a caption can say
  who is in a photo, and nothing else supplies a name (see the refusals).
- `store`: where entries live. `firestoreStore(db, collection)` for production,
  `memoryStore()` for tests.
- `model`: `geminiModel(apiKey)` for production.
- `signedUrl(path)`: turns a stored thumbnail path into a URL, at search time.
- `load(id)`: reads one asset as it is right now, as an `AssetInput`, or `null` once it is gone or
  must not be searchable (hidden, emptied). `indexById` calls it before and after every write, so it
  has to answer the current truth, never a cached copy. A throw is recorded as a failed entry. A failed entry whose asset is gone is
  removed on the next retry sweep; a deleted asset's entry is removed by `forgetAsset`.
- `listAll(cursor, limit)`: one page of every asset id the app holds, for backfill.
- `visibleNow(entry, who)`: optional, and recommended. The live check. Search finds hits by each
  entry's STORED `visibleTo`, and an entry can lag its asset: a hide or an unshare whose
  `forgetAsset` failed leaves an entry wider than the asset now is, until something settles it.
  When `visibleNow` is set, `search` asks it about each ranked candidate, in ranking order, before
  signing a thumbnail and before calling `present`, and keeps walking down the ranking until it has
  `limit` hits that pass or runs out, so a dropped hit's slot is filled by the next one that passes.
  At most `limit` x 3 candidates are checked per search (a mass of stale entries cannot make one
  search unbounded), in small parallel batches. A throw, no answer within 1500 ms, or anything but
  `true` counts as false and drops the hit: it fails closed. Answer from the asset's live record,
  never from the entry. It receives a shallow copy of the entry. Without `visibleNow`, search
  behaves exactly as in 0.1.2.
- `present(entry, ctx)`: optional. Called at query time, once per hit a search is about to return
  (after visibility is filtered and after `visibleNow`, never for the rest of the ranked
  candidates), in parallel, each call caught and each given 1500 ms. `ctx.who` is the person the
  search is answered for, so the host can judge which words that person may read. `present` never
  receives the query. It receives a shallow copy of the entry. Return `{ title?, text? }`: the asset's own title and its full
  human text (a poem body, a note body, an excerpt). A throw, a timeout or `null` just means that
  hit has no title; without `present`, hits are unchanged. It runs at query time so titles stay
  fresh after an edit and nothing needs re-indexing.
  The package builds the rest, using the query, which the host never sees. Both strings are
  NFC-normalized first, and only the first 20,000 characters of `text` are read. `title` is trimmed and
  cut at 120 characters with a trailing `…`. `snippet` is about 160 characters of `text`, whitespace
  collapsed, centered on the first word that begins with a query term (so `love` finds `loved`),
  starting at a word boundary, with `…` on each cut end; with no match it is the first 160
  characters. `titleMatches` and `snippetMatches` are `[start, end)` ranges, one per matching word,
  sorted and non-overlapping, as JavaScript string indices (UTF-16 code units, so slice the string
  with them directly) into the returned (normalized) `title` and `snippet`; absent when nothing
  matched. Words are runs of letters and digits, so text written without spaces (Chinese, Japanese,
  Thai) is a single run: a query matches it only from the start of the run, and a query word from
  the middle of a sentence in those scripts does not match by word (it can still be found by
  meaning).
  **The package never returns HTML. The UI must escape `title` and `snippet` and wrap only the given
  ranges in `<mark>`.**
  **Hard rule: `present` must return the asset's own human-written words** (a poem's title and
  body, a note's title, a moment's name). Never return the entry's AI `caption`, `tags` or
  `visibleText`: those are never shown to people. The package cannot enforce what a host returns,
  but it never copies caption, tags or visibleText onto a hit itself.
- `log(message, err)`: optional. Where indexing failures are reported.

## Wiring it into a Next.js app

1. Build the host once.

```ts
// src/lib/asset-host.ts
import 'server-only'
import { firestoreStore, geminiModel, type AssetIndexHost } from '@supersuit/asset-index/server'

export const host: AssetIndexHost<MemberId> = {
  member: sessionMember,
  agentMember: agentKeyMember,
  people: async () => (await listMembers()).map((m) => ({ id: m.id, name: m.name })),
  store: firestoreStore(() => adminDb(), 'assetIndex'),
  model: geminiModel(() => process.env.GEMINI_API_KEY!),
  signedUrl: (path) => signStoragePath(path),
  load: loadAssetInput,
  listAll: listAssetIds,
  log: (msg, err) => console.error(msg, err),
}
```

2. Right after the step that finalizes an upload, and after any change to what an asset says or who
   may see it, index it by id with `after`, so indexing never blocks the request and a failure
   never fails it.

```ts
import { after } from 'next/server'
import { indexById } from '@supersuit/asset-index/server'

// inside the finalize route, once the asset is saved
after(() => indexById(host, id))
```

`indexById` reads the asset through `host.load`, indexes it, and answers `'indexed'`, `'failed'` or
`'forgotten'`. `indexAsset(host, input)` is still exported as the low-level call that indexes an
`AssetInput` you already hold, once, with no re-read; prefer `indexById` from finalize hooks.

### Why indexById re-reads

Describing an asset takes seconds. If the app hides it, deletes it or narrows who may see it in that
window (a note unshared), the app's own forget or re-index can finish first, and a plain put landing
afterwards writes the old, wider entry back, where nothing ever corrects it. So after its put,
`indexById` reads the asset again: gone means the entry is forgotten, a different `visibleTo`
(compared as a set) means it is indexed once more, and a third read that still disagrees records a
failed entry for the retry sweep to settle. A `load` that throws is also recorded as failed, so it is
retried instead of silently never indexed. A failed entry is never returned by search. The sweep and
the `POST` handler go through `indexById` for every id, so they get the same protection.

The re-read has a cost: `indexById` calls `load` twice per asset, and three times when visibility
changed mid-describe, where `indexAsset(host, input)` calls it zero times. Keep `load` cheap, or
accept the extra reads (for a photo host that is typically one more Storage download per photo).

An `AssetInput` is the id, the kind (`photo`, `video`, `voice` or `text`), a display-size
JPEG or poster frame in `image` and/or the transcript or body in `text`, `takenAt`, an app-relative
`href`, the thumbnail's storage path, and `visibleTo` (an empty array means every member).

3. Mount the handlers at `src/app/api/asset-search/route.ts` (the 30 seconds block above).
   Implement `visibleNow` on the host rather than wrapping `GET`: `search` does the live check
   itself.
   `GET /api/asset-search?q=...&limit=24` returns `{ hits: SearchHit[] }`. `POST` runs a sweep and
   answers only to the agent key.

### Deleting a hand-rolled live check

Before 0.1.3, apps that needed search to respect live visibility wrapped `GET` with their own
`liveSearchGET`, which re-ran a `visibleNow(hit, who)` over the finished answer. That wrapper
filtered after the fact: it signed thumbnails and called `present` for hits it then threw away, and
a dropped hit left the answer short instead of being replaced. With 0.1.3, move the check onto the
host and delete the wrapper:

```ts
// src/lib/asset-host.ts
export const host: AssetIndexHost<MemberId> = {
  // ...as before
  // was: export async function visibleNow(hit: Pick<SearchHit, 'id' | 'href'>, who: string)
  visibleNow: (entry, who) => visibleNow(entry, who),
  present: presentAsset,
}
// delete: export function liveSearchGET(...) { ... }
```

```ts
// src/app/api/asset-search/route.ts
import { assetSearchHandlers } from '@supersuit/asset-index/server'
import { host } from '@/lib/asset-host'

export const runtime = 'nodejs'
// was: const handlers = assetSearchHandlers(host); export const GET = liveSearchGET(handlers.GET)
export const { GET, POST } = assetSearchHandlers(host)
```

An existing `visibleNow(hit, who)` that reads only `hit.id` and `hit.href` works unchanged, because
an `IndexEntry` carries both. A `presentAsset` that re-derived "may everyone the entry names still
read this" can now ask the narrower question with `ctx.who`, since every hit it sees has already
passed `visibleNow` for that person. Tests that exercised the wrapper move to the host's
`visibleNow`; the GET contract (auth, 401, limits, `{ hits }`, `no-store`) is the package's and is
unchanged.

4. Retry what failed, hourly. A cron that runs the sweep without backfill retries failed entries,
   oldest first.

```ts
import { sweep } from '@supersuit/asset-index/server'

await sweep(host, { cursor: null, limit: 25, backfill: false })
```

5. Backfill what already exists. POST the sweep with the agent key and repeat with each answer's
   `next` until it is `null`:

```bash
curl -X POST https://your.app/api/asset-search \
  -H "authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -d '{ "sweep": { "cursor": null, "limit": 25, "backfill": true } }'
# answers { indexed, failed, skipped, next }; send next back as cursor until next is null
```

How the agent key is presented is the app's choice: `agentMember` reads whatever header the app
uses. A backfill skips assets that are already indexed, so it is safe to run again.

6. When an asset is deleted, call `forgetAsset(host, id)` in the same delete path. When it is
   hidden or its visibility changes, `indexById(host, id)` settles the entry either way.

## Environment

- `GEMINI_API_KEY`: read through the `apiKey` callback you pass to `geminiModel`, only when the
  first call is made, so building the app needs no key.
- `ASSET_INDEX_DESCRIBE_MODEL`: the model that writes captions. Default `gemini-3.8-flash`.
- `ASSET_INDEX_EMBED_MODEL`: the model that writes embeddings. Default `gemini-embedding-2`.
- Embeddings are 768 dimensions (`EMBED_DIMENSIONS`). A model that answers any other length is
  refused, and the entry is marked failed.

Both model names can also be passed as `geminiModel(apiKey, { describeModel, embedModel })`, which
wins over the environment. Change the embedding model and every existing entry must be re-indexed,
because vectors from two models are not comparable.

## Firestore indexes

Three indexes are required, once per project, for the collection you pass to `firestoreStore`.
Without them the queries fail with a message naming the missing index.

```bash
# Search by meaning: vector search over indexed entries
gcloud firestore indexes composite create --project=<P> --collection-group=<COLLECTION> \
  --query-scope=COLLECTION --field-config=field-path=status,order=ASCENDING \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'

# Search by word: entries sharing any word, newest first
gcloud firestore indexes composite create --project=<P> --collection-group=<COLLECTION> \
  --query-scope=COLLECTION --field-config=field-path=terms,array-config=contains \
  --field-config=field-path=takenAt,order=DESCENDING

# Retry: failed entries, oldest attempt first
gcloud firestore indexes composite create --project=<P> --collection-group=<COLLECTION> \
  --query-scope=COLLECTION --field-config=field-path=status,order=ASCENDING \
  --field-config=field-path=indexedAt,order=ASCENDING
```

## What it refuses

- **No central copy.** An entry lives only in the owning app's own Firestore. The package has no
  server, no shared index, and sends nothing anywhere but the model you configured.
- **Captions are never returned by search.** A hit carries the id, kind, date, link, thumbnail URL
  and score, plus the `title`, `snippet` and highlight ranges built from what the host's `present` supplied. The caption is used to find the asset and is not handed back, so a search cannot be
  used to read what the model said about a photo someone else can see.
- **People come only from `host.people()`.** The describing model is given the names the app
  supplies and nothing else, so a caption never names someone the app did not say is there.
- **An entry is never wider than the asset now is.** `indexById` re-reads after every write (see
  above), and a sweep that hits an asset it cannot read records it failed and carries on with the
  rest of the page. This holds provided `load` reads live state and the app calls `indexById` or
  `forgetAsset` after each visibility change.
- **An index failure never fails an upload.** `indexAsset` catches every describe and embed error and records a failed entry. `indexById` never rejects; `indexAsset` rejects if the store is down, so run it inside `after()`
  and never on the upload path. The hourly sweep retries failed entries.
- **Visibility is enforced at search.** An entry with a non-empty `visibleTo` is returned only to
  the people listed. With `visibleNow`, the asset's live record has the last word too, and a hit it
  refuses (or cannot answer for in time) is never signed, presented or returned.

## Releasing

A release is a tag push through GitHub Actions, never `npm publish` from a machine. The workflow
in `.github/workflows/publish.yml` publishes with OIDC trusted publishing: GitHub's identity for
the workflow is the credential, so there is no token to store and none should be added.

1. Bump `version` in `package.json` and write the `CHANGELOG.md` entry. Stage `package-lock.json`
   with `package.json`, or `npm ci` refuses the release.
2. Commit and push, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

The first publish of a new package is the one exception: npm only attaches a trusted publisher to
a package that already exists, so that first publish is done once by hand with web 2FA. After it,
set the trust record (the exact command is in a comment in `publish.yml`):

```bash
npm trust github @supersuit/asset-index --file publish.yml \
  --repo SupersuitUp/asset-index --allow-publish --allow-stage-publish
```

Every release after that is a tag.

## Checks

`npm run check` runs the typecheck, the tests, the build, the private-words check (no real
person's name in a tracked file), the comment-dates check (no calendar date in a `src/` comment),
and the consumer check (a stub that skips until `test/consumer` exists).

MIT.
