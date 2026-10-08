import { it, expect } from 'vitest'
import { memoryStore } from './memory-store.js'
import type { IndexEntry } from '../types.js'

const e = (id: string, embedding: number[], t: string[], takenAt = '2026-10-01T00:00:00Z'): IndexEntry => ({
  id, kind: 'photo', status: 'indexed', caption: '', tags: [], visibleText: '', terms: t, embedding,
  takenAt, href: `/x/${id}`, thumbPath: null, visibleTo: [], indexedAt: takenAt,
})

it('nearest orders by cosine similarity', async () => {
  const s = memoryStore()
  await s.put(e('a', [1, 0], []))
  await s.put(e('b', [0, 1], []))
  expect(await s.nearest([0.9, 0.1], 2)).toEqual(['a', 'b'])
})
it('byTerms matches any word, newest first', async () => {
  const s = memoryStore()
  await s.put(e('old', [0, 0], ['beach'], '2026-01-01T00:00:00Z'))
  await s.put(e('new', [0, 0], ['beach', 'sunset'], '2026-09-01T00:00:00Z'))
  await s.put(e('no', [0, 0], ['city']))
  expect(await s.byTerms(['beach'], 10)).toEqual(['new', 'old'])
})
it('failed lists only failed entries', async () => {
  const s = memoryStore()
  await s.put({ ...e('f', [0, 0], []), status: 'failed', embedding: null })
  await s.put(e('ok', [0, 0], []))
  expect((await s.failed(10)).map((x) => x.id)).toEqual(['f'])
})
it('nearest skips null embeddings and failed entries, and honors limit', async () => {
  const s = memoryStore()
  await s.put({ ...e('f', [1, 0], []), status: 'failed' })
  await s.put({ ...e('n', [1, 0], []), embedding: null })
  await s.put(e('a', [1, 0], []))
  await s.put(e('b', [0, 1], []))
  expect(await s.nearest([1, 0], 1)).toEqual(['a'])
  expect(await s.nearest([1, 0], 10)).toEqual(['a', 'b'])
})
it('byTerms applies limit and empty words match nothing', async () => {
  const s = memoryStore()
  await s.put(e('1', [0, 0], ['x'], '2026-01-01T00:00:00Z'))
  await s.put(e('2', [0, 0], ['x'], '2026-02-01T00:00:00Z'))
  expect(await s.byTerms(['x'], 1)).toEqual(['2'])
  expect(await s.byTerms([], 5)).toEqual([])
})
it('getMany preserves input order and drops missing ids', async () => {
  const s = memoryStore()
  await s.put(e('a', [1, 0], []))
  await s.put(e('b', [0, 1], []))
  expect((await s.getMany(['b', 'zzz', 'a'])).map((x) => x.id)).toEqual(['b', 'a'])
})
it('get returns null for a missing id and stores copies', async () => {
  const s = memoryStore()
  const entry = e('a', [1, 0], ['t'])
  await s.put(entry)
  entry.caption = 'mutated'
  entry.terms.push('leak')
  const got = await s.get('a')
  expect(got?.caption).toBe('')
  expect(got?.terms).toEqual(['t'])
  got!.caption = 'again'
  expect((await s.get('a'))?.caption).toBe('')
  expect(await s.get('nope')).toBeNull()
  expect(s.all().map((x) => x.id)).toEqual(['a'])
})
