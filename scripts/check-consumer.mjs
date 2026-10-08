#!/usr/bin/env node
// Builds the app in test/consumer against the packed tarball once that app exists. It does not
// yet: this package has no UI, so the check is a stub that skips loudly until test/consumer is added.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!existsSync(fileURLToPath(new URL('../test/consumer', import.meta.url)))) {
  console.log('consumer check skipped: no test/consumer app yet')
  process.exit(0)
}
console.error('test/consumer exists but this script does not build it yet')
process.exit(1)
