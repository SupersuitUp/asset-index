#!/usr/bin/env node
// The private-words check. Fails a repository when a real person's name, address or domain
// appears in any tracked file outside tailor/.
//
// Scans every file git would commit: tracked, plus new files not ignored.
//
// Two lists, both in tailor/:
//   forbidden.sha256   one SHA-256 per line, of a word or phrase lowercased. A TEMPLATE forbids
//                      its apps' names this way, so it can refuse them without containing them.
//   private-words.txt  plain words or phrases, one per line. An APP forbids its own names in its
//                      own repository, where writing them down is no leak.
//
// README.md is kept per copy, so a copy's OWN words may appear in it; forbidden fingerprints
// may not, anywhere.
//
// Matching is by whole words (a phrase is a run of whole words), so "ben" never hits "benefit".
//
//   node living/private-words.mjs [--repo <path>]          exit 1 and list hits, 0 when clean
//   node living/private-words.mjs --add <word>... [--repo <path>]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git, lines, isKept } from './git.mjs'

const MAX_PHRASE = 4
const FORBIDDEN = 'tailor/forbidden.sha256'
const PLAIN = 'tailor/private-words.txt'

const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')
export const fingerprint = (word) => createHash('sha256').update(normalize(word)).digest('hex')

const readList = (repo, path) => (existsSync(join(repo, path)) ? lines(readFileSync(join(repo, path), 'utf8')) : [])

// Every candidate on one line: single words (camelCase also split), runs of up to MAX_PHRASE
// words, and dotted names such as domains and addresses.
function candidates(line) {
  const out = new Set()
  const words = []
  for (const m of line.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    words.push(w.toLowerCase())
    for (const part of w.split(/(?<=\p{Ll})(?=\p{Lu})/u)) out.add(part.toLowerCase())
  }
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_PHRASE && i + n <= words.length; n++) out.add(words.slice(i, i + n).join(' '))
  }
  // Names joined by hyphens or underscores (a project id like acme-c92b7), whole.
  for (const m of line.matchAll(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu)) out.add(m[0].toLowerCase())
  // Dotted names (domains), whole and every ending, so a forbidden example.org is caught
  // inside us.example.org.
  for (const m of line.matchAll(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu)) {
    const parts = m[0].toLowerCase().split('.')
    for (let i = 0; i < parts.length - 1; i++) out.add(parts.slice(i).join('.'))
  }
  return out
}

export function scan(repo = process.cwd()) {
  repo = resolve(repo)
  const forbidden = new Set(readList(repo, FORBIDDEN))
  const own = new Set(readList(repo, PLAIN).map(fingerprint))
  if (forbidden.size + own.size === 0) return []
  const hits = []
  // Tracked files AND new ones not yet committed (but not ignored ones): the check runs before
  // the commit that would add a leak, so reading only what git already tracks would pass a
  // brand-new template that has not committed its app yet. That happened, on us-template.
  for (const file of lines(git(repo, 'ls-files', '--cached', '--others', '--exclude-standard'))) {
    if (file.startsWith('tailor/')) continue
    // README.md belongs to the copy (it is kept on every update), so the copy may name itself
    // there; a name the template forbids is still refused.
    const banned = isKept(file) ? forbidden : new Set([...forbidden, ...own])
    const full = join(repo, file)
    if (!existsSync(full)) continue
    const buf = readFileSync(full)
    if (buf.subarray(0, 8192).includes(0)) continue
    buf.toString('utf8').split('\n').forEach((text, i) => {
      for (const c of candidates(text)) {
        if (banned.has(fingerprint(c))) { hits.push({ file, line: i + 1 }); return }
      }
    })
  }
  return hits
}

export function addForbidden(repo, words) {
  const path = join(resolve(repo), FORBIDDEN)
  const have = readList(repo, FORBIDDEN)
  const all = [...new Set([...have, ...words.filter((w) => normalize(w)).map(fingerprint)])].sort()
  writeFileSync(path, all.join('\n') + (all.length ? '\n' : ''))
  return all.length - have.length
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--repo')
  const repo = i >= 0 ? args.splice(i, 2)[1] : process.cwd()
  if (args[0] === '--add') {
    const added = addForbidden(repo, args.slice(1))
    console.log(`${added} fingerprint(s) added to ${FORBIDDEN}`)
  } else {
    const hits = scan(repo)
    // Never print the word: the point is that this repository does not contain it.
    for (const h of hits) console.log(`private word at ${h.file}:${h.line}`)
    if (hits.length) {
      console.error(`${hits.length} private word(s) outside tailor/. Move the value into tailor/ and read it from there.`)
      process.exit(1)
    }
    console.log('no private words outside tailor/')
  }
}
