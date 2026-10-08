export const EMBED_DIMENSIONS = 768
export const DEFAULT_DESCRIBE_MODEL = 'gemini-3.8-flash'
export const DEFAULT_EMBED_MODEL = 'gemini-embedding-2'

export type AssetKind = 'photo' | 'video' | 'voice' | 'text'

/** What the app hands the indexer for one asset. Exactly one of image/text is the primary source. */
export interface AssetInput {
  id: string
  kind: AssetKind
  /** Display-size JPEG for photos, poster frame for videos. */
  image?: { bytes: Buffer; contentType: string }
  /** Transcript for voice/video, body for poems and notes. */
  text?: string
  takenAt: string
  /** App-relative deep link, e.g. `/m/<momentId>?p=<photoId>`. */
  href: string
  /** Storage path of the thumbnail, signed at search time. */
  thumbPath?: string | null
  /** Who may see this asset. Empty array = every member of the app. */
  visibleTo: string[]
}

export interface Description { caption: string; tags: string[]; visibleText: string }

export interface IndexEntry {
  id: string
  kind: AssetKind
  status: 'indexed' | 'failed'
  error?: string
  caption: string
  tags: string[]
  visibleText: string
  /** Lowercased unique words from caption, tags, visibleText and text; max 200. */
  terms: string[]
  embedding: number[] | null
  takenAt: string
  href: string
  thumbPath: string | null
  visibleTo: string[]
  indexedAt: string
}

/** What a search returns to a caller. Never carries the caption. */
export interface SearchHit {
  id: string
  kind: AssetKind
  takenAt: string
  href: string
  thumbUrl: string | null
  score: number
}
