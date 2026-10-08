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
- `@supersuit/asset-index/server`: `indexAsset`, `forgetAsset`, `search`, `sweep`, `assetSearchHandlers`,
  `firestoreStore`, `memoryStore`, `geminiModel`, and the `AssetIndexHost`, `IndexStore` and
  `Model` types. Server only: it imports `server-only`, so a client bundle that reaches it fails to
  build.

```ts
import type { AssetInput, SearchHit } from '@supersuit/asset-index'
import { indexAsset, firestoreStore, geminiModel } from '@supersuit/asset-index/server'
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
  /** Re-reads an asset for retry/backfill; null if it no longer exists. */
  load(id: string): Promise<AssetInput | null>
  /** Ids of every asset the app holds, for backfill. Paged by cursor. */
  listAll(cursor: string | null, limit: number): Promise<{ ids: string[]; next: string | null }>
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
- `load(id)`: re-reads one asset as an `AssetInput`, or `null` once it is gone. A failed entry whose asset is gone is
  removed on the next retry sweep; a deleted asset's entry is removed by `forgetAsset`.
- `listAll(cursor, limit)`: one page of every asset id the app holds, for backfill.
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

2. Right after the step that finalizes an upload, index it with `after`, so indexing never blocks
   the upload and a failure never fails it.

```ts
import { after } from 'next/server'
import { indexAsset } from '@supersuit/asset-index/server'

// inside the finalize route, once the asset is saved
after(() => indexAsset(host, input))
```

`input` is an `AssetInput`: the id, the kind (`photo`, `video`, `voice` or `text`), a display-size
JPEG or poster frame in `image` and/or the transcript or body in `text`, `takenAt`, an app-relative
`href`, the thumbnail's storage path, and `visibleTo` (an empty array means every member).

3. Mount the handlers at `src/app/api/asset-search/route.ts` (the 30 seconds block above).
   `GET /api/asset-search?q=...&limit=24` returns `{ hits: SearchHit[] }`. `POST` runs a sweep and
   answers only to the agent key.

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

6. When an asset is deleted, call `forgetAsset(host, id)` in the same delete path.

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
  and score. The caption is used to find the asset and is not handed back, so a search cannot be
  used to read what the model said about a photo someone else can see.
- **People come only from `host.people()`.** The describing model is given the names the app
  supplies and nothing else, so a caption never names someone the app did not say is there.
- **An index failure never fails an upload.** `indexAsset` catches every describe and embed error and records a failed entry. If the store
  itself is down, `indexAsset` rejects, which is why it runs inside `after()` and never on the upload
  path. The hourly sweep retries failed entries.
- **Visibility is enforced at search.** An entry with a non-empty `visibleTo` is returned only to
  the people listed.

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
