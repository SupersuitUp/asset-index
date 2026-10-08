import type { IndexEntry } from '../types.js'
import type { IndexStore } from './store.js'

const copy = (e: IndexEntry): IndexEntry => ({
  ...e,
  tags: [...e.tags],
  terms: [...e.terms],
  visibleTo: [...e.visibleTo],
  embedding: e.embedding ? [...e.embedding] : null,
})

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * (b[i] ?? 0); na += a[i]! ** 2; nb += (b[i] ?? 0) ** 2 }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/** In-memory store with the same observable behavior as the Firestore one. For tests and local runs. */
export function memoryStore(): IndexStore & { all(): IndexEntry[] } {
  const rows = new Map<string, IndexEntry>()
  return {
    async put(e) { rows.set(e.id, copy(e)) },
    async get(id) { const e = rows.get(id); return e ? copy(e) : null },
    async nearest(vector, limit) {
      return [...rows.values()]
        .filter((e) => e.status === 'indexed' && e.embedding !== null)
        .map((e) => ({ id: e.id, s: cosine(vector, e.embedding!) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.id)
    },
    async byTerms(words, limit) {
      if (!words.length) return []
      return [...rows.values()]
        .filter((e) => e.terms.some((w) => words.includes(w)))
        .sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : 0))
        .slice(0, limit)
        .map((e) => e.id)
    },
    async getMany(ids) {
      return ids.flatMap((id) => { const e = rows.get(id); return e ? [copy(e)] : [] })
    },
    async failed(limit) {
      return [...rows.values()].filter((e) => e.status === 'failed').slice(0, limit).map(copy)
    },
    all() { return [...rows.values()].map(copy) },
  }
}
