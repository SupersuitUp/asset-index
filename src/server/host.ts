import type { AssetInput } from '../types.js'
import type { IndexStore } from './store.js'
import type { Model } from './model.js'

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
