import 'server-only'
import { GoogleGenAI } from '@google/genai'
import { DEFAULT_DESCRIBE_MODEL, DEFAULT_EMBED_MODEL, EMBED_DIMENSIONS } from '../types.js'

export interface Model {
  describe(prompt: string, input: { image?: { bytes: Buffer; contentType: string }; text?: string }): Promise<string>
  embed(text: string, task: 'document' | 'query'): Promise<number[]>
}

export function geminiModel(apiKey: () => string, opts: { describeModel?: string; embedModel?: string } = {}): Model {
  const describeModel = opts.describeModel ?? process.env.ASSET_INDEX_DESCRIBE_MODEL ?? DEFAULT_DESCRIBE_MODEL
  const embedModel = opts.embedModel ?? process.env.ASSET_INDEX_EMBED_MODEL ?? DEFAULT_EMBED_MODEL
  let client: GoogleGenAI | null = null
  const ai = () => (client ??= new GoogleGenAI({ apiKey: apiKey() }))
  return {
    async describe(prompt, { image, text }) {
      const res = await ai().models.generateContent({
        model: describeModel,
        contents: [{
          role: 'user',
          parts: [
            ...(image ? [{ inlineData: { mimeType: image.contentType, data: image.bytes.toString('base64') } }] : []),
            { text: prompt + (text ? '\n\nTEXT:\n' + text.slice(0, 20000) : '') },
          ],
        }],
        config: { temperature: 0, responseMimeType: 'application/json' },
      })
      return res.text ?? ''
    },
    async embed(text, task) {
      const res = await ai().models.embedContent({
        model: embedModel,
        contents: text.slice(0, 8000),
        config: { outputDimensionality: EMBED_DIMENSIONS, taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' },
      })
      const values = res.embeddings?.[0]?.values
      if (!values || values.length !== EMBED_DIMENSIONS) {
        throw new Error(`${embedModel} returned ${values ? values.length : 'no'} dimensions, expected ${EMBED_DIMENSIONS}`)
      }
      return values
    },
  }
}
