import { it, expect } from 'vitest'
import { indexAsset, forgetAsset, search, sweep } from './indexer.js'
import { memoryStore } from './memory-store.js'
import type { Model } from './model.js'
import type { AssetInput } from '../types.js'

const vec = (s: string) => [s.includes('beach') ? 1 : 0, s.includes('city') ? 1 : 0, 0.01]
const fake = (fail = false): Model => ({
  async describe(_p, input) {
    if (fail) throw new Error('model down')
    const t = input.text ?? 'beach photo'
    return JSON.stringify({ caption: t, tags: t.split(' '), visibleText: '' })
  },
  async embed(text) { return vec(text) },
})
const asset = (id: string, text: string, visibleTo: string[] = []): AssetInput =>
  ({ id, kind: 'text', text, takenAt: '2026-10-01T00:00:00Z', href: `/a/${id}`, thumbPath: null, visibleTo })
const hostWith = (model: Model, assets: AssetInput[] = []) => ({
  member: async () => null, people: async () => [{ id: 'g' as const, name: 'G' }, { id: 'd' as const, name: 'D' }],
  store: memoryStore(), model, signedUrl: async (p: string) => `https://signed/${p}`,
  load: async (id: string) => assets.find((a) => a.id === id) ?? null,
  listAll: async (cursor: string | null, limit: number) => {
    const start = cursor ? Number(cursor) : 0
    const ids = assets.slice(start, start + limit).map((a) => a.id)
    return { ids, next: start + limit < assets.length ? String(start + limit) : null }
  },
})

it('indexes and finds by meaning', async () => {
  const h = hostWith(fake())
  await indexAsset(h, asset('1', 'sunny beach day'))
  await indexAsset(h, asset('2', 'city lights'))
  const hits = await search(h, 'g', 'beach')
  expect(hits[0].id).toBe('1')
  expect(hits[0]).not.toHaveProperty('caption')
})
it('a model failure writes a failed entry and does not throw', async () => {
  const h = hostWith(fake(true))
  const e = await indexAsset(h, asset('1', 'x'))
  expect(e.status).toBe('failed')
  expect((await h.store.failed(10)).map((x) => x.id)).toEqual(['1'])
})
it('search hides assets the member cannot see', async () => {
  const h = hostWith(fake())
  await indexAsset(h, asset('1', 'beach', ['d']))
  expect(await search(h, 'g', 'beach')).toEqual([])
  expect((await search(h, 'd', 'beach'))[0].id).toBe('1')
})
it('sweep backfills unindexed assets, skips indexed ones, pages by cursor', async () => {
  const all = [asset('1', 'beach'), asset('2', 'city'), asset('3', 'beach city')]
  const h = hostWith(fake(), all)
  await indexAsset(h, all[0])
  const r1 = await sweep(h, { cursor: null, limit: 2, backfill: true })
  expect(r1).toMatchObject({ indexed: 1, skipped: 1, next: '2' })
  const r2 = await sweep(h, { cursor: r1.next, limit: 2, backfill: true })
  expect(r2).toMatchObject({ indexed: 1, next: null })
})
it('sweep without backfill retries only failed entries', async () => {
  const all = [asset('1', 'beach')]
  const h = hostWith(fake(true), all)
  await indexAsset(h, all[0])
  h.model = fake()
  expect(await sweep(h, { cursor: null, limit: 10, backfill: false })).toMatchObject({ indexed: 1, failed: 0 })
})
it('a failed entry whose asset is gone is deleted by the sweep, in both modes', async () => {
  for (const backfill of [false, true]) {
    const h = hostWith(fake(true), [asset('1', 'x')])
    await indexAsset(h, asset('1', 'x'))
    const gone = { ...h, load: async () => null, listAll: async () => ({ ids: ['1'], next: null }) }
    expect(await sweep(gone, { cursor: null, limit: 10, backfill })).toMatchObject({ skipped: 1 })
    expect(await h.store.get('1')).toBeNull()
    expect(await h.store.failed(10)).toEqual([])
  }
})
it('with limit 1 and two failing entries, the second retry sweep picks the other one', async () => {
  const all = [asset('1', 'a'), asset('2', 'b')]
  const h = hostWith(fake(true), all)
  await indexAsset(h, all[0])
  await new Promise((r) => setTimeout(r, 5))
  await indexAsset(h, all[1])
  await new Promise((r) => setTimeout(r, 5))
  const seen: string[] = []
  const spy = { ...h, load: async (id: string) => { seen.push(id); return all.find((a) => a.id === id) ?? null } }
  await sweep(spy, { cursor: null, limit: 1, backfill: false })
  await new Promise((r) => setTimeout(r, 5))
  await sweep(spy, { cursor: null, limit: 1, backfill: false })
  // Each id is read twice: once to index it, once after the put to confirm it did not change.
  expect(seen).toEqual(['1', '1', '2', '2'])
})

it('forgetAsset removes an indexed asset from search and the store', async () => {
  const h = hostWith(fake())
  await indexAsset(h, asset('a1', 'beach day'))
  expect((await search(h, 'g', 'beach')).map((x) => x.id)).toEqual(['a1'])
  await forgetAsset(h, 'a1')
  expect(await search(h, 'g', 'beach')).toEqual([])
  expect(await h.store.get('a1')).toBeNull()
})

it('forgetAsset on an unknown id is a no-op', async () => {
  const h = hostWith(fake())
  await expect(forgetAsset(h, 'nope')).resolves.toBeUndefined()
})

// present: the asset's own words, at query time, for returned hits only.
const five = () => ['1', '2', '3', '4', '5'].map((i) => asset(i, `beach day ${i}`))
const indexAll = async (h: ReturnType<typeof hostWith>, xs: AssetInput[]) => { for (const x of xs) await indexAsset(h, x) }

it('present is called only for returned hits, not every ranked candidate', async () => {
  const xs = five()
  const calls: string[] = []
  const h = { ...hostWith(fake(), xs), present: async (e: { id: string }) => { calls.push(e.id); return { title: `T${e.id}` } } }
  await indexAll(h, xs)
  const hits = await search(h, 'g', 'beach', 2)
  expect(hits).toHaveLength(2)
  expect(calls).toHaveLength(2)
  expect(hits.map((x) => x.title).sort()).toEqual(calls.map((c) => `T${c}`).sort())
})
it('a throwing or null present still returns the hit, untitled', async () => {
  const xs = five().slice(0, 2)
  const h = { ...hostWith(fake(), xs), present: async (e: { id: string }) => { if (e.id === '1') throw new Error('boom'); return null } }
  await indexAll(h, xs)
  const hits = await search(h, 'g', 'beach')
  expect(hits.map((x) => x.id).sort()).toEqual(['1', '2'])
  for (const x of hits) { expect(x).not.toHaveProperty('title'); expect(x).not.toHaveProperty('snippet') }
})
it('title is trimmed, cut at 120 with an ellipsis, and ranges past the cut are dropped', async () => {
  const xs = [asset('1', 'beach')]
  const title = `  beach ${'t'.repeat(150)} beach  `
  const h = { ...hostWith(fake(), xs), present: async () => ({ title }) }
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'beach')
  expect(hit.title!.length).toBe(120)
  expect(hit.title!.endsWith('…')).toBe(true)
  expect(hit.titleMatches).toEqual([[0, 5]])
  for (const [s, e] of hit.titleMatches!) expect(e).toBeLessThanOrEqual(hit.title!.length)
})
it('snippet is a window around a mid-text match, with ellipses and whitespace collapsed', async () => {
  const xs = [asset('1', 'beach')]
  const text = `${'alpha '.repeat(60)}\n\n  the   beach  is  here ${'omega '.repeat(60)}`
  const h = { ...hostWith(fake(), xs), present: async () => ({ text }) }
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'beach')
  const sn = hit.snippet!
  expect(sn.length).toBeLessThanOrEqual(160)
  expect(sn.startsWith('…')).toBe(true)
  expect(sn.endsWith('…')).toBe(true)
  expect(sn).toContain('the beach is here')
  expect(sn).not.toMatch(/\s{2}/)
  expect(sn.startsWith('… ')).toBe(false)
  expect(hit.snippetMatches).toHaveLength(1)
  const [s, e] = hit.snippetMatches![0]
  expect(sn.slice(s, e)).toBe('beach')
})
it('a query term matches word prefixes, so love finds loved, and ranges never overlap', async () => {
  const xs = [asset('1', 'beach love')]
  const text = 'I loved her. Love is love, and so on. Unloved is not a match.'
  const h = { ...hostWith(fake(), xs), present: async () => ({ title: 'Love and beach: loved', text }) }
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'love')
  expect(hit.snippetMatches!.map(([s, e]) => hit.snippet!.slice(s, e))).toEqual(['loved', 'Love', 'love'])
  expect(hit.titleMatches!.map(([s, e]) => hit.title!.slice(s, e))).toEqual(['Love', 'loved'])
  const r = hit.snippetMatches!
  for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThanOrEqual(r[i - 1][1])
})
it('a meaning-only match gives the first 160 characters and no ranges', async () => {
  const xs = [asset('1', 'beach')]
  const text = 'sea '.repeat(100)
  const h = { ...hostWith(fake(), xs), present: async () => ({ text }) }
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'beach')
  expect(hit.snippet!.length).toBeLessThanOrEqual(160)
  expect(hit.snippet!.length).toBeGreaterThan(150)
  expect(hit.snippet!.startsWith('sea sea')).toBe(true)
  expect(hit.snippet!.endsWith('…')).toBe(true)
  expect(hit).not.toHaveProperty('snippetMatches')
})
it('non-Latin terms get offsets that are JS string indices (Ethiopic, after an astral character)', async () => {
  const text = `😀 ሰላም ለሁሉም ፍቅር ነው ${'ሰላም '.repeat(5)}`
  const xs = [asset('1', 'ፍቅር')]
  const h = { ...hostWith(fake(), xs), present: async () => ({ title: 'ፍቅር ግጥም', text }) }
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'ፍቅር')
  expect(hit.snippetMatches!.map(([s, e]) => hit.snippet!.slice(s, e))).toEqual(['ፍቅር'])
  expect(hit.snippetMatches![0][0]).toBe(hit.snippet!.indexOf('ፍቅር'))
  expect(hit.titleMatches).toEqual([[0, 3]])
})
it('a present that takes longer than 1500 ms leaves the hit untitled', async () => {
  const xs = [asset('1', 'beach')]
  const h = { ...hostWith(fake(), xs), present: () => new Promise<null>(() => {}) }
  await indexAll(h, xs)
  const hits = await search(h, 'g', 'beach')
  expect(hits).toHaveLength(1)
  expect(hits[0]).not.toHaveProperty('title')
  expect(hits[0]).not.toHaveProperty('snippet')
})
it('without present, hits carry no title fields', async () => {
  const xs = [asset('1', 'beach')]
  const h = hostWith(fake(), xs)
  await indexAll(h, xs)
  const [hit] = await search(h, 'g', 'beach')
  expect(hit).not.toHaveProperty('title')
  expect(hit).not.toHaveProperty('snippet')
})
it('the caption, tags and visibleText never appear on a hit, even when present returns nothing', async () => {
  const xs = [asset('1', 'zebra beach')]
  const h = { ...hostWith(fake(), xs), present: async () => null }
  await indexAll(h, xs)
  const hits = await search(h, 'g', 'beach')
  expect(JSON.stringify(hits)).not.toContain('zebra')
  expect(Object.keys(hits[0]).sort()).toEqual(['href', 'id', 'kind', 'score', 'takenAt', 'thumbUrl'])
})
