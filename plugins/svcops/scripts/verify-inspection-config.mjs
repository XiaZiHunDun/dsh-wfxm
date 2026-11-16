import {
  DEFAULT_THRESHOLDS,
  parseExpectedPorts,
  parseThresholds,
  readInspectionConfig,
} from '../lib/index.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const warnings = () => []

await check('expected ports accept commas, spaces and tabs', () => {
  const seen = warnings()
  const ports = parseExpectedPorts('8080, 443\t80 8443', seen)
  return ports.join(',') === '80,443,8080,8443' && seen.length === 0
})

await check('expected ports are de-duplicated and sorted', () => {
  const seen = warnings()
  const ports = parseExpectedPorts('9000,80,9000,80', seen)
  return ports.join(',') === '80,9000' && seen.length === 0
})

await check('invalid expected ports are skipped with a warning', () => {
  const seen = warnings()
  const ports = parseExpectedPorts('80,abc,0,65536,-1,443', seen)
  return ports.join(',') === '80,443' && seen.length === 4
})

await check('empty expected ports mean "report only"', () => {
  const seen = warnings()
  return parseExpectedPorts(undefined, seen).length === 0
    && parseExpectedPorts('  ', seen).length === 0
    && seen.length === 0
})

await check('valid threshold JSON overrides the defaults', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"diskWarnPct":70,"diskFailPct":90,"logWindowMinutes":30}', seen)
  return thresholds.diskWarnPct === 70
    && thresholds.diskFailPct === 90
    && thresholds.logWindowMinutes === 30
    && thresholds.memWarnAvailPct === DEFAULT_THRESHOLDS.memWarnAvailPct
    && seen.length === 0
})

await check('invalid JSON falls back to defaults with a warning', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{not json', seen)
  return thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct
    && seen.length === 1
    && seen[0].includes('not valid JSON')
})

await check('non-object JSON falls back to defaults', () => {
  const seen = warnings()
  const thresholds = parseThresholds('[1,2]', seen)
  return thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct && seen.length === 1
})

await check('unknown keys are ignored with a warning', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"nope":1}', seen)
  return thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct
    && seen.length === 1
    && seen[0].includes('unknown threshold')
})

await check('non-finite and out-of-range values are ignored', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"diskWarnPct":"80","diskFailPct":120,"loadWarnPerCore":null}', seen)
  return thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct
    && thresholds.diskFailPct === DEFAULT_THRESHOLDS.diskFailPct
    && thresholds.loadWarnPerCore === DEFAULT_THRESHOLDS.loadWarnPerCore
    && seen.length === 3
})

await check('disk warn >= fail reverts the pair to defaults', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"diskWarnPct":95,"diskFailPct":90}', seen)
  return thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct
    && thresholds.diskFailPct === DEFAULT_THRESHOLDS.diskFailPct
    && seen.some((line) => line.includes('diskWarnPct must be below'))
})

await check('memory warn <= fail reverts the pair to defaults', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"memWarnAvailPct":5,"memFailAvailPct":10}', seen)
  return thresholds.memWarnAvailPct === DEFAULT_THRESHOLDS.memWarnAvailPct
    && thresholds.memFailAvailPct === DEFAULT_THRESHOLDS.memFailAvailPct
    && seen.some((line) => line.includes('memWarnAvailPct must stay above'))
})

await check('log window below 1 minute is rejected', () => {
  const seen = warnings()
  const thresholds = parseThresholds('{"logWindowMinutes":0}', seen)
  return thresholds.logWindowMinutes === DEFAULT_THRESHOLDS.logWindowMinutes && seen.length === 1
})

await check('readInspectionConfig reads both env vars', () => {
  const config = readInspectionConfig({
    DSH_WFXM_EXPECTED_PORTS: '8080,443',
    DSH_WFXM_INSPECT_THRESHOLDS: '{"diskWarnPct":70}',
  })
  return config.expectedPorts.join(',') === '443,8080'
    && config.thresholds.diskWarnPct === 70
    && config.warnings.length === 0
})

await check('empty environment keeps the documented defaults', () => {
  const config = readInspectionConfig({})
  return config.expectedPorts.length === 0
    && config.thresholds.diskWarnPct === DEFAULT_THRESHOLDS.diskWarnPct
    && config.thresholds.diskFailPct === DEFAULT_THRESHOLDS.diskFailPct
    && config.warnings.length === 0
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
