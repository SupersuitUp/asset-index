export const TITLE_MAX = 120
export const SNIPPET_MAX = 160
/** The most of present's `text` ever read; anything past it is never matched or shown. */
export const TEXT_MAX = 20_000
const LEAD = 50

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/** [start, end) offsets, in JS string indices, of every word in `s` that begins with a query term. Sorted, never overlapping, and never HTML. */
export function matchRanges(s: string, queryTerms: string[]): [number, number][] {
  if (!queryTerms.length) return []
  const out: [number, number][] = []
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase().normalize('NFC')
    if (queryTerms.some((t) => w.startsWith(t))) out.push([m.index!, m.index! + m[0].length])
  }
  return out
}

/** Cuts a string at `max` code units without splitting a surrogate pair. */
const safeEnd = (s: string, end: number) => (end > 0 && end < s.length && /[\uDC00-\uDFFF]/.test(s[end]) ? end - 1 : end)

/** At most TEXT_MAX code units (never half a surrogate pair), then NFC, so every range is computed on the string returned. */
const prepare = (raw: string) => raw.slice(0, safeEnd(raw, TEXT_MAX)).normalize('NFC')

export function buildTitle(raw: string, queryTerms: string[]): { title: string; matches: [number, number][] } | null {
  const t = prepare(raw).trim()
  if (!t) return null
  const title = t.length > TITLE_MAX ? `${t.slice(0, safeEnd(t, TITLE_MAX - 1)).trimEnd()}…` : t
  return { title, matches: matchRanges(title, queryTerms) }
}

/**
 * A window of about SNIPPET_MAX characters around the first query-term match in `text`, starting at
 * a word boundary, with "…" at whichever ends were cut. With no match, the first SNIPPET_MAX
 * characters. Offsets are computed on the returned string, so they are always valid for it.
 */
export function buildSnippet(raw: string, queryTerms: string[]): { snippet: string; matches: [number, number][] } | null {
  const text = collapse(prepare(raw))
  if (!text) return null
  let snippet = text
  if (text.length > SNIPPET_MAX) {
    const first = matchRanges(text, queryTerms)[0]
    let start = 0
    if (first && first[0] > LEAD) {
      start = first[0] - LEAD
      const sp = text.indexOf(' ', start)
      start = sp !== -1 && sp < first[0] ? sp + 1 : first[0]
    }
    const lead = start > 0 ? 1 : 0
    let end = start + SNIPPET_MAX - lead
    if (end >= text.length) end = text.length
    else {
      end = safeEnd(text, end - 1)
      const sp = text.lastIndexOf(' ', end)
      const floor = first ? first[1] : start
      if (sp > floor && sp > start) end = sp
    }
    snippet = `${lead ? '…' : ''}${text.slice(start, end).trimEnd()}${end < text.length ? '…' : ''}`
  }
  return { snippet, matches: matchRanges(snippet, queryTerms) }
}
