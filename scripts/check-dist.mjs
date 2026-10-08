#!/usr/bin/env node
// Properties of the BUILT package that no unit test can see, because the tests run the sources:
//   1. the server entry still refuses to load in a browser bundle (import 'server-only' first);
//   2. nothing outside dist/server/ mentions server-only, so the root entry is safe to import anywhere.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const bad = []

const serverEntry = join(DIST, 'server/index.js')
if (existsSync(serverEntry) && !/^import ['"]server-only['"];?/.test(readFileSync(serverEntry, 'utf8').trimStart())) {
  bad.push("dist/server/index.js does not start with import 'server-only'")
}
for (const file of walk(DIST).filter((p) => p.endsWith('.js'))) {
  const rel = relative(DIST, file)
  if (!rel.startsWith(`server${sep}`) && /server-only/.test(readFileSync(file, 'utf8'))) bad.push(`dist/${rel} mentions server-only outside the server entry`)
}
for (const b of bad) console.error(b)
if (bad.length) process.exit(1)
console.log('dist: the server entry is guarded, the root entry is plain')
