import { describe, it, expect } from 'vitest'
import { terms, fuse, parseDescription, describePrompt } from './core.js'

describe('terms', () => {
  it('lowercases, splits on non-letters, drops stopwords and 1-letter words, dedupes', () => {
    expect(terms('Sam laughing at the BEACH', 'beach, sunset')).toEqual(['sam', 'laughing', 'beach', 'sunset'])
  })
  it('keeps non-Latin scripts whole', () => {
    expect(terms('ሰላም friend')).toEqual(['ሰላም', 'friend'])
  })
  it('caps at 200', () => {
    expect(terms(Array.from({ length: 300 }, (_, i) => `w${i}`).join(' '))).toHaveLength(200)
  })
})

describe('fuse (reciprocal rank fusion)', () => {
  it('ranks an id found by both lists above ids found by one', () => {
    const out = fuse([['a', 'b', 'c'], ['c', 'd']])
    expect(out[0].id).toBe('c')
    expect(out.map((h) => h.id).sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('returns empty for empty input', () => { expect(fuse([[], []])).toEqual([]) })
})

describe('parseDescription', () => {
  it('reads fenced JSON', () => {
    expect(parseDescription('```json\n{"caption":"a dog","tags":["Dog"," park "],"visibleText":""}\n```'))
      .toEqual({ caption: 'a dog', tags: ['dog', 'park'], visibleText: '' })
  })
  it('throws on missing caption', () => {
    expect(() => parseDescription('{"tags":[]}')).toThrow(/caption/)
  })
})

describe('describePrompt', () => {
  it('names only the given people and forbids others', () => {
    const p = describePrompt('photo', ['Ana', 'Ben'])
    expect(p).toContain('Ana, Ben')
    expect(p).toMatch(/never name anyone else/i)
  })
})

describe('terms normalization', () => {
  it('normalizes to NFC, so decomposed and precomposed input give the same term', () => {
    expect(terms('Café')).toEqual(terms('Café'))
    expect(terms('Café')).toEqual(['café'])
  })
  it('keeps Thai and Devanagari words whole across their combining marks', () => {
    expect(terms('ที่นี่ ทะเลสวยมาก')).toEqual(['ที่นี่', 'ทะเลสวยมาก'])
    expect(terms('नमस्ते दुनिया')).toEqual(['नमस्ते', 'दुनिया'])
  })
  it('keeps CJK runs whole, since they are written without spaces', () => {
    expect(terms('東京の海')).toEqual(['東京の海'])
  })
  it('counts length in code points: one astral letter is too short, two are a word', () => {
    expect(terms('𝒜 𝒜𝒞 bc')).toEqual(['𝒜𝒞', 'bc'])
  })
})
