import { describePrompt, parseDescription, terms, fuse } from '../core.js'
import type { AssetInput, IndexEntry, SearchHit } from '../types.js'
import type { AssetIndexHost } from './host.js'

const now = () => new Date().toISOString()

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
    host.log?.(`asset-index: ${a.id} failed`, err)
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
  const hits: SearchHit[] = await Promise.all(picked.map(async (e) => ({
    id: e.id, kind: e.kind, takenAt: e.takenAt, href: e.href,
    thumbUrl: e.thumbPath ? await host.signedUrl(e.thumbPath) : null, score: score.get(e.id)!,
  })))
  return hits
}

export async function sweep<M extends string>(host: AssetIndexHost<M>, opts: { cursor: string | null; limit: number; backfill: boolean }) {
  let indexed = 0, failed = 0, skipped = 0
  const run = async (id: string) => {
    const a = await host.load(id)
    if (!a) { await host.store.delete(id); skipped++; return }
    const e = await indexAsset(host, a)
    if (e.status === 'indexed') indexed++; else failed++
  }
  if (!opts.backfill) {
    for (const e of await host.store.failed(opts.limit)) await run(e.id)
    return { indexed, failed, skipped, next: null }
  }
  const page = await host.listAll(opts.cursor, opts.limit)
  for (const id of page.ids) {
    const existing = await host.store.get(id)
    if (existing?.status === 'indexed') { skipped++; continue }
    await run(id)
  }
  return { indexed, failed, skipped, next: page.next }
}

/** Removes an asset's entry. Call it wherever the app deletes the asset; forgetting an unknown id is a no-op. */
export async function forgetAsset<M extends string>(host: AssetIndexHost<M>, id: string): Promise<void> {
  await host.store.delete(id)
}
