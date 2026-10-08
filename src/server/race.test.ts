import { describe, it, expect, beforeEach, vi } from 'vitest'
import { indexById, sweep, search } from './indexer.js'
import { assetSearchHandlers } from './handlers.js'
import { memoryStore } from './memory-store.js'
import type { Model } from './model.js'
import type { AssetIndexHost } from './host.js'
import type { AssetInput, IndexEntry } from '../types.js'

// What actually ends up in the index when the app's data changes while the model is describing,
// or when the app cannot read an asset at all. The app's data is a plain map the fake model can
// mutate mid-describe, which is exactly the window a slow model call opens in production.

type Who = 'owner' | 'friend'
type Row = { text: string; hidden?: boolean; visibleTo: Who[] }
let rows: Record<string, Row> = {}
let broken = new Set<string>()
// Runs inside the first describe call: after the asset was loaded, before its entry is put.
let during: (() => Promise<void> | void) | null = null

const model: Model = {
  async describe(_p, input) {
    const fn = during
    during = null
    await fn?.()
    const t = input.text ?? 'x'
    return JSON.stringify({ caption: t, tags: t.split(' '), visibleText: '' })
  },
  async embed(text) { return [text.includes('beach') ? 1 : 0, text.includes('city') ? 1 : 0, 0.01] },
}

const load = async (id: string): Promise<AssetInput | null> => {
  if (broken.has(id)) throw new Error('storage hiccup')
  const r = rows[id]
  if (!r || r.hidden) return null
  return { id, kind: 'text', text: r.text, takenAt: '2026-10-01T00:00:00Z', href: `/a/${id}`, thumbPath: null, visibleTo: [...r.visibleTo] }
}

let host: AssetIndexHost<Who> & { store: ReturnType<typeof memoryStore> }
beforeEach(() => {
  rows = {}
  broken = new Set()
  during = null
  host = {
    member: async () => null,
    agentMember: async () => 'owner',
    people: async () => [{ id: 'owner', name: 'Owner' }, { id: 'friend', name: 'Friend' }],
    store: memoryStore(),
    model,
    signedUrl: async (p) => `https://signed/${p}`,
    load,
    listAll: async () => ({ ids: Object.keys(rows).sort(), next: null }),
    log: () => {},
  }
})

const failedEntry = (id: string, visibleTo: string[] = []): IndexEntry => ({
  id, kind: 'text', status: 'failed', error: 'x', caption: '', tags: [], visibleText: '', terms: [],
  embedding: null, takenAt: 'x', href: `/a/${id}`, thumbPath: null, visibleTo, indexedAt: 'x',
})

describe('indexById: a change while describing never leaves a wider entry behind', () => {
  it('an untouched asset is indexed once, with no retry', async () => {
    rows.a1 = { text: 'beach day', visibleTo: [] }
    const spy = vi.spyOn(model, 'describe')
    expect(await indexById(host, 'a1')).toBe('indexed')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
    expect(await host.store.get('a1')).toMatchObject({ status: 'indexed', visibleTo: [] })
  })
  it('a missing asset is forgotten', async () => {
    await host.store.put(failedEntry('gone'))
    expect(await indexById(host, 'gone')).toBe('forgotten')
    expect(await host.store.get('gone')).toBeNull()
  })
  it('an asset hidden during describe ends up out of the index', async () => {
    rows.a1 = { text: 'beach day', visibleTo: [] }
    during = () => { rows.a1!.hidden = true }
    expect(await indexById(host, 'a1')).toBe('forgotten')
    expect(await host.store.get('a1')).toBeNull()
    expect(await search(host, 'friend', 'beach')).toEqual([])
  })
  it('an asset deleted during describe ends up out of the index', async () => {
    rows.a1 = { text: 'beach day', visibleTo: [] }
    during = () => { delete rows.a1 }
    expect(await indexById(host, 'a1')).toBe('forgotten')
    expect(await host.store.get('a1')).toBeNull()
  })
  it('an unshare during describe ends narrow', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    during = () => { rows.n1!.visibleTo = ['owner'] }
    expect(await indexById(host, 'n1')).toBe('indexed')
    expect(await host.store.get('n1')).toMatchObject({ status: 'indexed', visibleTo: ['owner'] })
    expect(await search(host, 'friend', 'beach')).toEqual([])
  })
  it('a share-then-unshare race ends narrow, even when the unshare\'s own index finishes first', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    during = async () => {
      rows.n1!.visibleTo = ['owner']
      await indexById(host, 'n1') // the unshare's own run, which lands before the share's put
    }
    await indexById(host, 'n1')
    expect(await host.store.get('n1')).toMatchObject({ status: 'indexed', visibleTo: ['owner'] })
    expect(await search(host, 'friend', 'beach')).toEqual([])
  })
  it('visibility that keeps changing is recorded failed, never searchable', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    let flips = 0
    const flipping: typeof host = { ...host, load: async (id) => {
      const a = await load(id)
      flips++
      return a && { ...a, visibleTo: flips % 2 ? ['owner', 'friend'] : ['owner'] }
    } }
    expect(await indexById(flipping, 'n1')).toBe('failed')
    expect(await host.store.get('n1')).toMatchObject({ status: 'failed', embedding: null, terms: [] })
    expect(await search(host, 'friend', 'beach')).toEqual([])
    expect(await search(host, 'owner', 'beach')).toEqual([])
  })
  it('visibility compares as a set, so a reorder is not a change', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    during = () => { rows.n1!.visibleTo = ['friend', 'owner'] }
    const spy = vi.spyOn(model, 'describe')
    expect(await indexById(host, 'n1')).toBe('indexed')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})

describe('indexById: an asset that cannot be read', () => {
  it('a load throw writes a failed entry, never searchable', async () => {
    rows.a1 = { text: 'beach day', visibleTo: [] }
    broken.add('a1')
    expect(await indexById(host, 'a1')).toBe('failed')
    expect(await host.store.get('a1')).toMatchObject({ status: 'failed', embedding: null, terms: [] })
    expect((await host.store.failed(10)).map((e) => e.id)).toEqual(['a1'])
    expect(await search(host, 'owner', 'beach')).toEqual([])
  })
  it('a load failure keeps the last known fields of the prior entry', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner'] }
    await indexById(host, 'n1')
    broken.add('n1')
    expect(await indexById(host, 'n1')).toBe('failed')
    expect(await host.store.get('n1')).toMatchObject({ status: 'failed', href: '/a/n1', visibleTo: ['owner'] })
  })
  it('a re-load that throws after the put records failed rather than leaving the put', async () => {
    rows.a1 = { text: 'beach day', visibleTo: [] }
    during = () => { broken.add('a1') }
    expect(await indexById(host, 'a1')).toBe('failed')
    expect((await host.store.get('a1'))?.status).toBe('failed')
  })
})

describe('sweep goes through indexById', () => {
  it('one throwing id never aborts the run: the others index and its failed entry is kept', async () => {
    rows.a0 = { text: 'beach', visibleTo: [] }
    rows.a1 = { text: 'city', visibleTo: [] }
    rows.a2 = { text: 'beach city', visibleTo: [] }
    broken.add('a1')
    expect(await sweep(host, { cursor: null, limit: 10, backfill: true })).toEqual({ indexed: 2, failed: 1, skipped: 0, next: null })
    expect((await host.store.get('a0'))?.status).toBe('indexed')
    expect((await host.store.get('a2'))?.status).toBe('indexed')
    expect((await host.store.get('a1'))?.status).toBe('failed')
  })
  it('an id whose indexing itself throws (the store refuses its put) is counted failed and the run goes on', async () => {
    rows.a0 = { text: 'beach', visibleTo: [] }
    rows.a1 = { text: 'city', visibleTo: [] }
    const put = host.store.put
    host.store = { ...host.store, put: async (e) => { if (e.id === 'a0') throw new Error('store down'); return put(e) } }
    expect(await sweep(host, { cursor: null, limit: 10, backfill: true })).toEqual({ indexed: 1, failed: 1, skipped: 0, next: null })
    expect((await host.store.get('a1'))?.status).toBe('indexed')
  })
  it('a retry sweep that still cannot read an id keeps its failed entry; once readable it is indexed', async () => {
    rows.a1 = { text: 'beach', visibleTo: [] }
    broken.add('a1')
    await indexById(host, 'a1')
    expect(await sweep(host, { cursor: null, limit: 10, backfill: false })).toMatchObject({ failed: 1 })
    expect((await host.store.get('a1'))?.status).toBe('failed')
    broken.clear()
    expect(await sweep(host, { cursor: null, limit: 10, backfill: false })).toMatchObject({ indexed: 1 })
    expect((await host.store.get('a1'))?.status).toBe('indexed')
  })
  it('a backfill skip check that throws is counted failed and does not abort the run', async () => {
    rows.a0 = { text: 'beach', visibleTo: [] }
    rows.a1 = { text: 'city', visibleTo: [] }
    const get = host.store.get
    host.store = { ...host.store, get: async (id) => { if (id === 'a0') throw new Error('store hiccup'); return get(id) } }
    expect(await sweep(host, { cursor: null, limit: 10, backfill: true })).toMatchObject({ indexed: 1, failed: 1 })
  })
  it('a retry sweep: an asset hidden during describe ends up gone and counts skipped', async () => {
    rows.a1 = { text: 'beach', visibleTo: [] }
    await host.store.put(failedEntry('a1'))
    during = () => { rows.a1!.hidden = true }
    expect(await sweep(host, { cursor: null, limit: 25, backfill: false })).toEqual({ indexed: 0, failed: 0, skipped: 1, next: null })
    expect(await host.store.get('a1')).toBeNull()
  })
  it('a retry sweep: an unshare during describe ends narrow', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    await host.store.put(failedEntry('n1', ['owner', 'friend']))
    during = () => { rows.n1!.visibleTo = ['owner'] }
    await sweep(host, { cursor: null, limit: 25, backfill: false })
    expect(await host.store.get('n1')).toMatchObject({ status: 'indexed', visibleTo: ['owner'] })
  })
})

describe('the POST backfill through assetSearchHandlers', () => {
  const backfill = () => assetSearchHandlers(host).POST(new Request('http://x/api/asset-search', {
    method: 'POST', body: JSON.stringify({ sweep: { cursor: null, limit: 25, backfill: true } }),
  }))
  it('an asset hidden during describe ends up gone, with the unchanged answer shape', async () => {
    rows.a1 = { text: 'beach', visibleTo: [] }
    during = () => { rows.a1!.hidden = true }
    const res = await backfill()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ indexed: 0, failed: 0, skipped: 1, next: null })
    expect(await host.store.get('a1')).toBeNull()
  })
  it('an unshare during describe ends narrow', async () => {
    rows.n1 = { text: 'beach note', visibleTo: ['owner', 'friend'] }
    during = () => { rows.n1!.visibleTo = ['owner'] }
    expect(await (await backfill()).json()).toEqual({ indexed: 1, failed: 0, skipped: 0, next: null })
    expect(await host.store.get('n1')).toMatchObject({ status: 'indexed', visibleTo: ['owner'] })
  })
  it('a throwing load does not 500 the run', async () => {
    rows.a0 = { text: 'beach', visibleTo: [] }
    rows.a1 = { text: 'city', visibleTo: [] }
    broken.add('a0')
    const res = await backfill()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ indexed: 1, failed: 1, skipped: 0, next: null })
  })
})
