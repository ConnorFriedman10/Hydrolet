// Runs every integration suite and reports a combined result.
//   npm test

import { run as timeline } from './timeline.test.mjs'
import { run as daychart } from './daychart.test.mjs'
import { run as caregiver } from './caregiver.test.mjs'
import { run as schedule } from './schedule.test.mjs'
import { run as events } from './events.test.mjs'

// Pure logic first: it is fast and needs no network, so a failure there shows
// up before the slower database suites run.
const suites = [timeline, daychart, caregiver, schedule, events]

let passed = 0
const failures = []

for (const suite of suites) {
  const r = await suite()
  passed += r.passed
  failures.push(...r.failures)
}

console.log(`\n${'='.repeat(46)}`)
console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
}

process.exit(failures.length ? 1 : 0)
