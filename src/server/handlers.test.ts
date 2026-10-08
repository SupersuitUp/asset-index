import { it, expect } from 'vitest'
import { assetSearchHandlers } from './handlers.js'
import { indexAsset } from './indexer.js'
import { memoryStore } from './memory-store.js'
import type { Model } from './model.js'
import type { AssetInput } from '../types.js'
import type { AssetIndexHost } from './host.js'

const vec = (s: string) => [s.includes('beach') ? 1 : 0, s.includes('city') ? 1 : 0, 0.01]
const model: Model = {
  async describe(_p, input) { const t = input.text ?? 'x'; return JSON.stringify({ caption: t, tags: t.split(' '), visibleText: '' }) },
  async embed(text) { return vec(text) },
}
const asset = (id: string, text: string): AssetInput =>
  ({ id, kind: 'text', text, takenAt: '2026-10-01T00:00:00Z', href: `/a/${id}`, thumbPath: null, visibleTo: [] })
const mk = (over: Partial<AssetIndexHost<'g'>> = {}): AssetIndexHost<'g'> => ({
  member: async () => null, agentMember: async () => null,
  people: async () => [{ id: 'g', name: 'G' }],
  store: memoryStore(), model, signedUrl: async (p) => `https://signed/${p}`,
  load: async () => null,
  listAll: async () => ({ ids: [], next: null }),
  ...over,
})
const get = (qs = '') => new Request(`http://x/api/asset-search${qs}`)
const post = (body: unknown) => new Request('http://x/api/asset-search', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

it('GET 401 with no member', async () => {
  const r = await assetSearchHandlers(mk()).GET(get('?q=beach'))
  expect(r.status).toBe(401)
  expect(await r.json()).toEqual({ error: 'unauthorized' })
})
it('GET 200 hits for a session member', async () => {
  const h = mk({ member: async () => 'g' })
  await indexAsset(h, asset('1', 'sunny beach'))
  const r = await assetSearchHandlers(h).GET(get('?q=beach'))
  expect(r.status).toBe(200)
  expect((await r.json()).hits[0].id).toBe('1')
})
it('GET 200 for an agent key', async () => {
  const h = mk({ agentMember: async () => 'g' })
  await indexAsset(h, asset('1', 'sunny beach'))
  const r = await assetSearchHandlers(h).GET(get('?q=beach'))
  expect(r.status).toBe(200)
  expect((await r.json()).hits).toHaveLength(1)
})
it('GET truncates a long q instead of refusing', async () => {
  const seen: string[] = []
  const h = mk({ member: async () => 'g', model: { ...model, async embed(t, k) { seen.push(t); return model.embed(t, k) } } })
  const r = await assetSearchHandlers(h).GET(get('?q=' + 'a'.repeat(500)))
  expect(r.status).toBe(200)
  expect(seen[0]).toHaveLength(300)
})
it('GET blank or missing q returns empty hits', async () => {
  const g = assetSearchHandlers(mk({ member: async () => 'g' })).GET
  for (const qs of ['', '?q=', '?q=%20%20']) {
    const r = await g(get(qs))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hits: [] })
  }
})
it('GET clamps limit to 1..50 and defaults to 24', async () => {
  const h = mk({ member: async () => 'g' })
  for (let i = 0; i < 60; i++) await indexAsset(h, asset(String(i), 'beach'))
  const g = assetSearchHandlers(h).GET
  expect((await (await g(get('?q=beach&limit=999'))).json()).hits).toHaveLength(50)
  expect((await (await g(get('?q=beach&limit=0'))).json()).hits).toHaveLength(1)
  expect((await (await g(get('?q=beach&limit=-5'))).json()).hits).toHaveLength(1)
  expect((await (await g(get('?q=beach&limit=abc'))).json()).hits).toHaveLength(24)
  expect((await (await g(get('?q=beach'))).json()).hits).toHaveLength(24)
})
it('POST 401 for a session-only member, and when agentMember is absent', async () => {
  const body = { sweep: { cursor: null, limit: 5, backfill: true } }
  expect((await assetSearchHandlers(mk({ member: async () => 'g' })).POST(post(body))).status).toBe(401)
  const { agentMember: _a, ...noAgent } = mk({ member: async () => 'g' })
  expect((await assetSearchHandlers(noAgent as AssetIndexHost<'g'>).POST(post(body))).status).toBe(401)
})
it('POST runs the sweep and returns its counts', async () => {
  const all = [asset('1', 'beach'), asset('2', 'city')]
  const h = mk({
    agentMember: async () => 'g',
    load: async (id) => all.find((a) => a.id === id) ?? null,
    listAll: async () => ({ ids: ['1', '2'], next: null }),
  })
  const r = await assetSearchHandlers(h).POST(post({ sweep: { cursor: null, limit: 10, backfill: true } }))
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({ indexed: 2, failed: 0, skipped: 0, next: null })
})
it('POST clamps sweep limit to 1..50 and defaults backfill false', async () => {
  const limits: number[] = []
  const h = mk({ agentMember: async () => 'g', listAll: async (_c, l) => { limits.push(l); return { ids: [], next: null } } })
  const p = assetSearchHandlers(h).POST
  await p(post({ sweep: { cursor: null, limit: 9999, backfill: true } }))
  await p(post({ sweep: { cursor: 'c', limit: 0, backfill: true } }))
  await p(post({ sweep: { backfill: true } }))
  expect(limits).toEqual([50, 1, 25])
  const r = await p(post({ sweep: { limit: 5 } }))
  expect(await r.json()).toMatchObject({ next: null })
  expect(limits).toHaveLength(3)
})
it('POST 400 on a malformed body', async () => {
  const p = assetSearchHandlers(mk({ agentMember: async () => 'g' })).POST
  for (const b of ['{not json', {}, { sweep: 'x' }, { sweep: null }, [1]]) {
    const r = await p(post(b))
    expect(r.status).toBe(400)
    expect(typeof (await r.json()).error).toBe('string')
  }
})
it('500 when the store throws, never leaking the message, and logs', async () => {
  const logs: unknown[][] = []
  const boom = async () => { throw new Error('SECRET-internal-detail') }
  const store = { ...memoryStore(), nearest: boom, byTerms: boom, failed: boom }
  const h = mk({ member: async () => 'g', agentMember: async () => 'g', store, log: (...a) => { logs.push(a) } })
  const hs = assetSearchHandlers(h)
  for (const r of [await hs.GET(get('?q=beach')), await hs.POST(post({ sweep: { cursor: null, limit: 5, backfill: false } }))]) {
    expect(r.status).toBe(500)
    const text = await r.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal' })
    expect(text).not.toContain('SECRET')
  }
  expect(logs).toHaveLength(2)
})
it('every response carries cache-control: no-store', async () => {
  const hs = assetSearchHandlers(mk({ member: async () => 'g' }))
  for (const r of [await hs.GET(get('?q=a')), await hs.GET(get()), await hs.POST(post({}))]) {
    expect(r.headers.get('cache-control')).toBe('no-store')
  }
  const unauth = await assetSearchHandlers(mk()).GET(get())
  expect(unauth.headers.get('cache-control')).toBe('no-store')
})
it('GET passes title and snippet from host.present through in hits', async () => {
  const h = mk({ member: async () => 'g', present: async () => ({ title: 'Ode', snippet: 'first line' }) })
  await indexAsset(h, asset('1', 'sunny beach'))
  const r = await assetSearchHandlers(h).GET(get('?q=beach'))
  expect((await r.json()).hits[0]).toMatchObject({ id: '1', title: 'Ode', snippet: 'first line' })
})
