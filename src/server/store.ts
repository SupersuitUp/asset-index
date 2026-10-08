import 'server-only'
import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore'
import type { IndexEntry } from '../types.js'

export interface IndexStore {
  put(e: IndexEntry): Promise<void>
  get(id: string): Promise<IndexEntry | null>
  /** Ids of indexed entries, closest first. */
  nearest(vector: number[], limit: number): Promise<string[]>
  /** Ids of entries sharing any word, newest first. */
  byTerms(words: string[], limit: number): Promise<string[]>
  getMany(ids: string[]): Promise<IndexEntry[]>
  failed(limit: number): Promise<IndexEntry[]>
}

// Required Firestore indexes (created per app, see the README):
//   1. Vector index on `embedding`: dimension 768, flat, with `status` as the prefilter field.
//   2. Composite index on `terms` (array-contains) + `takenAt` (descending).
export function firestoreStore(db: () => Firestore, collection: string): IndexStore {
  const col = () => db().collection(collection)
  const toDoc = (e: IndexEntry) => ({ ...e, embedding: e.embedding ? FieldValue.vector(e.embedding) : null })
  const fromDoc = (d: DocumentSnapshot): IndexEntry => {
    const x = d.data()!
    return { ...(x as IndexEntry), embedding: x.embedding ? x.embedding.toArray() : null }
  }
  return {
    async put(e) { await col().doc(e.id).set(toDoc(e)) },
    async get(id) { const d = await col().doc(id).get(); return d.exists ? fromDoc(d) : null },
    async nearest(vector, limit) {
      const snap = await col().where('status', '==', 'indexed')
        .findNearest({ vectorField: 'embedding', queryVector: vector, limit, distanceMeasure: 'COSINE' }).get()
      return snap.docs.map((d) => d.id)
    },
    async byTerms(words, limit) {
      if (!words.length) return []
      const snap = await col().where('terms', 'array-contains-any', words.slice(0, 30)).orderBy('takenAt', 'desc').limit(limit).get()
      return snap.docs.map((d) => d.id)
    },
    async getMany(ids) {
      if (!ids.length) return []
      const docs = await db().getAll(...ids.map((id) => col().doc(id)))
      return docs.filter((d) => d.exists).map(fromDoc)
    },
    async failed(limit) {
      const snap = await col().where('status', '==', 'failed').limit(limit).get()
      return snap.docs.map(fromDoc)
    },
  }
}
