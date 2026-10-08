import { it, expect } from 'vitest'
import { geminiModel } from './model.js'
import { parseDescription } from '../core.js'
import { EMBED_DIMENSIONS } from '../types.js'

const live = process.env.ASSET_INDEX_LIVE === '1'
const model = () => geminiModel(() => process.env.GEMINI_API_KEY ?? '')

it.skipIf(!live)('embeds to the declared dimensions', async () => {
  const v = await model().embed('a beach at sunset', 'document')
  expect(v).toHaveLength(EMBED_DIMENSIONS)
}, 30000)
it.skipIf(!live)('describes text as parseable JSON', async () => {
  const raw = await model().describe('Describe this text. Return JSON only: {"caption": string, "tags": string[], "visibleText": string}', { text: 'We walked along the beach at sunset.' })
  expect(parseDescription(raw).caption).toBeTruthy()
}, 60000)
