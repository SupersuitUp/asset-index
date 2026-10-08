// The one place living/ runs git. Synchronous on purpose: every step depends on the last.
import { spawnSync } from 'node:child_process'

export function tryGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

export function git(cwd, ...args) {
  const r = tryGit(cwd, ...args)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.err || r.out}`)
  return r.out
}

export const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean)

// Paths an update never takes from the parent, at any level: whatever makes a copy someone's
// own (tailor/), and the README every child rewrites. .gitattributes says the same thing for
// the case where both sides changed a file; this list covers the case it cannot, a file only
// the parent changed, which git would otherwise take silently.
export const KEPT = [/^tailor\//, /^README\.md$/]
export const isKept = (path) => KEPT.some((re) => re.test(path))
