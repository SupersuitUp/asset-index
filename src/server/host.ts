import type { AssetInput, IndexEntry } from '../types.js'
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
  /**
   * Optional. Called at query time, only for the hits a search is about to return, to say what to
   * show for each: the asset's own `title` and its full human `text` (a poem body, a note body, an
   * excerpt). The package picks the snippet and the highlight ranges from `text` using the query,
   * which the host never sees. Gives up after 1500 ms and the hit goes out untitled. HARD RULE: return the asset's OWN human-written words (a poem's title and first
   * line, a note's title, a moment's name). Never return the entry's AI caption, tags or
   * visibleText: those are never shown to people. The package cannot enforce what a host returns,
   * but it never copies caption, tags or visibleText onto a hit itself. A throw or null means the
   * hit goes out untitled.
   */
  present?(entry: IndexEntry): Promise<{ title?: string; text?: string } | null>
  log?(msg: string, err?: unknown): void
}
