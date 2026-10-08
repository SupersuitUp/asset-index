import { describePrompt, parseDescription, terms, fuse } from '../core.js'
import type { AssetInput, IndexEntry, SearchHit } from '../types.js'
import type { AssetIndexHost } from './host.js'

const now = () => new Date().toISOString()

/** Reports through host.log, swallowing anything the log itself throws, so a broken logger never turns a handled failure into a rejection. */
export function safeLog<M extends string>(host: AssetIndexHost<M>, msg: string, err?: unknown): void {
  try { host.log?.(msg, err) } catch { /* a logger that throws must not change the outcome */ }
}

export async function indexAsset<M extends string>(host: AssetIndexHost<M>, a: AssetInput): Promise<IndexEntry> {
  const base = { id: a.id, kind: a.kind, takenAt: a.takenAt, href: a.href, thumbPath: a.thumbPath ?? null, visibleTo: a.visibleTo, indexedAt: now() }
  try {
    const names = (await host.people()).map((p) => p.name)
    const d = parseDescription(await host.model.describe(describePrompt(a.kind, names), { image: a.image, text: a.text }))
    const doc = [d.caption, d.tags.join(', '), d.visibleText, a.text ?? ''].filter(Boolean).join('\n')
    const entry: IndexEntry = { ...base, status: 'indexed', ...d, terms: terms(d.caption, d.tags.join(' '), d.visibleText, a.text ?? ''), embedding: await host.model.embed(doc, 'document') }
    await host.store.put(entry)
    return entry
  } catch (err) {
    safeLog(host, `asset-index: ${a.id} failed`, err)
    const entry: IndexEntry = { ...base, status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 300), caption: '', tags: [], visibleText: '', terms: [], embedding: null }
    await host.store.put(entry)
    return entry
  }
}

export async function search<M extends string>(host: AssetIndexHost<M>, who: M, q: string, limit = 24): Promise<SearchHit[]> {
  const query = q.trim().slice(0, 300)
  if (!query) return []
  const [byMeaning, byWord] = await Promise.all([
    host.model.embed(query, 'query').then((v) => host.store.nearest(v, 50)),
    // Firestore array-contains-any accepts at most 30 values; cap here so every store behaves the same.
    host.store.byTerms(terms(query).slice(0, 30), 50),
  ])
  const ranked = fuse([byMeaning, byWord])
  const entries = new Map((await host.store.getMany(ranked.map((r) => r.id))).map((e) => [e.id, e]))
  const picked: IndexEntry[] = []
  for (const r of ranked) {
    const e = entries.get(r.id)
    if (!e || e.status !== 'indexed') continue
    if (e.visibleTo.length && !e.visibleTo.includes(who)) continue
    picked.push(e)
    if (picked.length === limit) break
  }
  const score = new Map(ranked.map((r) => [r.id, r.score]))
  const hits: SearchHit[] = await Promise.all(picked.map(async (e) => {
    const hit: SearchHit = {
      id: e.id, kind: e.kind, takenAt: e.takenAt, href: e.href,
      thumbUrl: e.thumbPath ? await host.signedUrl(e.thumbPath) : null, score: score.get(e.id)!,
    }
    // Only the final hits reach here, after visibility filtering. HARD RULE: whatever present
    // returns must be the asset's own human-written words. This function never copies the entry's
    // caption, tags or visibleText onto a hit; those are never shown to people.
    const shown = await presentOne(host, e)
    if (shown.title) hit.title = shown.title
    if (shown.snippet) hit.snippet = shown.snippet
    return hit
  }))
  return hits
}

const TITLE_MAX = 120
const SNIPPET_MAX = 160

async function presentOne<M extends string>(host: AssetIndexHost<M>, e: IndexEntry): Promise<{ title?: string; snippet?: string }> {
  if (!host.present) return {}
  try {
    const p = await host.present(e)
    const title = typeof p?.title === 'string' ? p.title.trim().slice(0, TITLE_MAX).trim() : ''
    let snippet = typeof p?.snippet === 'string' ? p.snippet.replace(/\s+/g, ' ').trim() : ''
    if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX - 1).trimEnd()}…`
    return { title: title || undefined, snippet: snippet || undefined }
  } catch (err) {
    safeLog(host, `asset-index: present failed for ${e.id}`, err)
    return {}
  }
}

export type IndexOutcome = 'indexed' | 'failed' | 'forgotten'

// An asset that could not even be read is recorded as a failed entry, so the retry sweep picks it
// up rather than nobody noticing. A failed entry is never returned by search (no embedding, no
// terms, and search keeps only status 'indexed'), so its fields only have to be good enough to
// retry: the last known ones when there are any. The get and put are not atomic, and both ways
// they can interleave fail closed: a good entry overwritten is hidden until the retry re-indexes
// it, and a just-forgotten one re-created as failed is forgotten again when the retry finds it gone.
async function recordFailure<M extends string>(host: AssetIndexHost<M>, id: string, err: unknown): Promise<'failed'> {
  safeLog(host, `asset-index: could not load ${id}`, err)
  const prior = await host.store.get(id).catch(() => null)
  const at = now()
  await host.store.put({
    id, kind: prior?.kind ?? 'photo', status: 'failed',
    error: `load failed: ${String((err as Error)?.message ?? err)}`.slice(0, 300),
    caption: '', tags: [], visibleText: '', terms: [], embedding: null,
    takenAt: prior?.takenAt ?? at, href: prior?.href ?? '', thumbPath: null,
    visibleTo: prior?.visibleTo ?? [], indexedAt: at,
  })
  return 'failed'
}

const visibility = (a: AssetInput) => [...new Set(a.visibleTo)].sort().join('\n')

/**
 * Index one asset by id. The call a host makes from its finalize hook, and the one every sweep
 * makes. Describing takes seconds, and in that window the app can hide, delete or narrow the asset
 * and run its own forget, which a slower put would undo for good. So after the put the asset is read
 * again: gone means forget, a different visibleTo means index once more, and a third read that still
 * disagrees records a failed entry (never searchable) for the retry sweep to settle. A load that
 * throws records a failed entry too. Never leaves an entry wider than the asset now is, and never
 * rejects: if even the failed entry cannot be written, it logs and answers 'failed'.
 */
export async function indexById<M extends string>(host: AssetIndexHost<M>, id: string): Promise<IndexOutcome> {
  try {
    return await settle(host, id)
  } catch (err) {
    // Even the failure write could not land (the store is down). Never reject: report and answer failed.
    safeLog(host, `asset-index: ${id} could not be indexed or recorded`, err)
    return 'failed'
  }
}

async function settle<M extends string>(host: AssetIndexHost<M>, id: string): Promise<IndexOutcome> {
  let a: AssetInput | null
  try { a = await host.load(id) } catch (err) { return recordFailure(host, id, err) }
  for (let attempt = 0; ; attempt++) {
    if (!a) { await forgetAsset(host, id); return 'forgotten' }
    const entry = await indexAsset(host, a)
    let current: AssetInput | null
    try { current = await host.load(id) } catch (err) { return recordFailure(host, id, err) }
    if (current && visibility(current) === visibility(a)) return entry.status
    if (current && attempt === 1) return recordFailure(host, id, new Error('visibility kept changing while it was indexed'))
    a = current
  }
}

/**
 * Without backfill, retries failed entries oldest first; with it, indexes one page of listAll,
 * skipping what is already indexed. Every id goes through indexById, each caught on its own, so
 * one asset that throws is counted failed and never ends the run. A forgotten id counts as skipped.
 */
export async function sweep<M extends string>(host: AssetIndexHost<M>, opts: { cursor: string | null; limit: number; backfill: boolean }) {
  let indexed = 0, failed = 0, skipped = 0
  const run = async (id: string) => {
    let o: IndexOutcome
    try { o = await indexById(host, id) } catch (err) { safeLog(host, `asset-index: sweep of ${id} failed`, err); o = 'failed' }
    if (o === 'indexed') indexed++; else if (o === 'failed') failed++; else skipped++
  }
  if (!opts.backfill) {
    for (const e of await host.store.failed(opts.limit)) await run(e.id)
    return { indexed, failed, skipped, next: null }
  }
  const page = await host.listAll(opts.cursor, opts.limit)
  for (const id of page.ids) {
    let existing: IndexEntry | null
    try { existing = await host.store.get(id) } catch (err) { safeLog(host, `asset-index: sweep of ${id} failed`, err); failed++; continue }
    if (existing?.status === 'indexed') { skipped++; continue }
    await run(id)
  }
  return { indexed, failed, skipped, next: page.next }
}

/** Removes an asset's entry. Call it wherever the app deletes the asset; forgetting an unknown id is a no-op. */
export async function forgetAsset<M extends string>(host: AssetIndexHost<M>, id: string): Promise<void> {
  await host.store.delete(id)
}
