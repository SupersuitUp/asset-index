import type { AssetKind, Description } from './types.js'

const STOP = new Set(['the','a','an','and','or','of','at','in','on','to','with','for','is','are','was','it','its','this','that','by','from','as'])

/**
 * Lowercased unique words, NFC-normalized so a query typed in decomposed form (e + combining accent)
 * matches text stored precomposed. Splits on anything that is not a letter or digit, so scripts
 * written without spaces (CJK, Thai) come out as whole runs, not words.
 */
export function terms(...parts: string[]): string[] {
  const out = new Set<string>()
  for (const part of parts) {
    for (const w of part.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 2 || STOP.has(w)) continue
      out.add(w)
      if (out.size === 200) return [...out]
    }
  }
  return [...out]
}

export function fuse(lists: string[][], k = 60): { id: string; score: number }[] {
  const score = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score)
}

export function parseDescription(raw: string): Description {
  const body = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const j = JSON.parse(body) as Partial<Description>
  if (typeof j.caption !== 'string' || !j.caption.trim()) throw new Error('description has no caption')
  return {
    caption: j.caption.trim(),
    tags: Array.isArray(j.tags) ? j.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
    visibleText: typeof j.visibleText === 'string' ? j.visibleText.trim() : '',
  }
}

export function describePrompt(kind: AssetKind, people: string[]): string {
  const subject = kind === 'photo' ? 'this photo' : kind === 'video' ? 'this video frame and its transcript' : 'this text'
  return [
    `Describe ${subject} so someone can find it later by describing it in their own words.`,
    `The people who may appear are: ${people.join(', ')}. Use one of these names only when you are confident; never name anyone else, and describe anyone you cannot name as "a person".`,
    'Return JSON only: {"caption": one or two plain sentences of what is shown and happening, including setting and mood,',
    '"tags": up to 15 short lowercase tags (people from the list, places, objects, activities, mood, season, time of day),',
    '"visibleText": any readable text in the image, verbatim, or ""}.',
  ].join(' ')
}
