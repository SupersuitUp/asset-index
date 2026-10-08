import 'server-only'

export { indexAsset, search, sweep } from './indexer.js'
export { firestoreStore } from './store.js'
export type { IndexStore } from './store.js'
export { memoryStore } from './memory-store.js'
export { geminiModel } from './model.js'
export type { Model } from './model.js'
export type { AssetIndexHost } from './host.js'
