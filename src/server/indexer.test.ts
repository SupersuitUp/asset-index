import { it, expect } from 'vitest'
import { indexAsset, search, sweep } from './indexer.js'
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
  expect(seen).toEqual(['1', '2'])
})
