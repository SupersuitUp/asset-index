import type { AssetIndexHost } from './host.js'
import { search, sweep } from './indexer.js'

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function intOr(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? Math.trunc(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** GET searches (session member or agent key); POST runs a sweep (agent key only). */
export function assetSearchHandlers<M extends string>(host: AssetIndexHost<M>) {
  const fail = (err: unknown) => {
    host.log?.('asset-search failed', err)
    return json({ error: 'internal' }, 500)
  }
  return {
    async GET(req: Request): Promise<Response> {
      try {
        const who = (await host.member(req)) ?? (await host.agentMember?.(req)) ?? null
        if (!who) return json({ error: 'unauthorized' }, 401)
        const url = new URL(req.url)
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 300)
        if (!q) return json({ hits: [] })
        const limit = clamp(intOr(url.searchParams.get('limit'), 24), 1, 50)
        return json({ hits: await search(host, who, q, limit) })
      } catch (err) {
        return fail(err)
      }
    },
    async POST(req: Request): Promise<Response> {
      try {
        const who = (await host.agentMember?.(req)) ?? null
        if (!who) return json({ error: 'unauthorized' }, 401)
        let body: unknown
        try { body = await req.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
        const s = (body as { sweep?: unknown } | null)?.sweep
        if (!s || typeof s !== 'object' || Array.isArray(s)) return json({ error: 'expected { sweep: {...} }' }, 400)
        const o = s as Record<string, unknown>
        return json(await sweep(host, {
          cursor: typeof o.cursor === 'string' ? o.cursor : null,
          limit: clamp(intOr(o.limit, 25), 1, 50),
          backfill: o.backfill === true,
        }))
      } catch (err) {
        return fail(err)
      }
    },
  }
}
