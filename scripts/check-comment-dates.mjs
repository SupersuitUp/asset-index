#!/usr/bin/env node
// Fails when a comment in src/ carries a calendar date (YYYY-MM-DD). A date in a comment is a
// diary entry about the app the code came from: it tells a reader of a public package nothing
// they can use, and it dates itself. Date VALUES in code (test data, string literals) are fine;
// only comments are read.
//
//   node scripts/check-comment-dates.mjs [--root <dir>]     exit 1 and list hits, 0 when clean
//
// Comments are found with the TypeScript parser, so a `//` inside a string or a URL is not a
// comment and a comment in JSX or after a statement is.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const DATE = /\d{4}-\d{2}-\d{2}/
const argRoot = process.argv.indexOf('--root')
const ROOT = argRoot > 0 ? resolve(process.argv[argRoot + 1]) : fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })

function commentsOf(file, text) {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const seen = new Map()
  const note = (ranges) => { for (const r of ranges ?? []) seen.set(r.pos, r) }
  const visit = (node) => {
    note(ts.getLeadingCommentRanges(text, node.getFullStart()))
    note(ts.getTrailingCommentRanges(text, node.getEnd()))
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return [...seen.values()]
}

const hits = []
for (const file of walk(SRC).filter((p) => /\.tsx?$/.test(p))) {
  const text = readFileSync(file, 'utf8')
  for (const c of commentsOf(file, text)) {
    const body = text.slice(c.pos, c.end)
    body.split('\n').forEach((line, i) => {
      if (!DATE.test(line)) return
      const lineNo = text.slice(0, c.pos).split('\n').length + i
      hits.push(`comment with a date at ${relative(ROOT, file)}:${lineNo}`)
    })
  }
}
for (const h of hits) console.error(h)
if (hits.length) process.exit(1)
console.log('no dates in comments under src/')
