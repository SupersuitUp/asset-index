#!/usr/bin/env node
// annotated-links builds a Next.js app in test/consumer against the packed tarball. This package has
// no UI and no consumer app yet, so there is nothing to build; the check passes loudly until one exists.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!existsSync(fileURLToPath(new URL('../test/consumer', import.meta.url)))) {
  console.log('consumer check skipped: no test/consumer app yet')
  process.exit(0)
}
console.error('test/consumer exists but this script does not build it yet')
process.exit(1)
