import assert from 'node:assert/strict'
import {
  REDACT_MARKER,
  redactDeep,
  redactError,
  redactText,
} from '../lib/index.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

// 测试用假凭据一律在运行时拼接：源码里不出现完整形态，避免 GitHub secret
// scanning 把夹具当成真实令牌拦下推送（形状仍与真实令牌一致，脱敏逻辑照测）。
const SECRETS = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dB_M7b3BS7BdT7Yk8i1X2w4Q5v6N7p8R9s0T1u2V3w4',
  github: 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  githubPat: 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  slack: 'xoxb-' + '123456789012-abcdefghijklmnop',
  openai: 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  key: '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----',
  url: 'postgres://app:hunter2@db.internal:5432/ops',
}

check('AWS access key is masked with prefix and length', () => {
  const { value, hits } = redactText(`key=${SECRETS.aws}`)
  assert.equal(value, 'key=AKIA…[redacted:aws-access-key:20]')
  assert.deepEqual(hits, [{ kind: 'aws-access-key', length: 20 }])
})

check('JWT is masked', () => {
  const { value, hits } = redactText(`Authorization: ${SECRETS.jwt}`)
  assert.ok(value.includes(`${REDACT_MARKER}jwt:`))
  assert.ok(!value.includes(SECRETS.jwt))
  assert.equal(hits[0].kind, 'jwt')
})

check('GitHub token and fine-grained PAT are masked', () => {
  const a = redactText(SECRETS.github).value
  const b = redactText(SECRETS.githubPat).value
  assert.ok(a.includes('[redacted:github-token:') && !a.includes(SECRETS.github))
  assert.ok(b.includes('[redacted:github-token:') && !b.includes(SECRETS.githubPat))
})

check('Slack token is masked', () => {
  const { value } = redactText(`slack=${SECRETS.slack}`)
  assert.ok(value.includes('[redacted:slack-token:') && !value.includes(SECRETS.slack))
})

check('sk- API key is masked', () => {
  const { value, hits } = redactText(`OPENAI_API_KEY=${SECRETS.openai}`)
  assert.ok(value.includes('[redacted:api-key:') && !value.includes(SECRETS.openai))
  // The assigned-secret rule must not re-mask an already masked value.
  assert.equal(hits.length, 1)
})

check('private key block is masked whole, without prefix', () => {
  const { value, hits } = redactText(`before\n${SECRETS.key}\nafter`)
  assert.ok(value.startsWith('before\n…[redacted:private-key:'))
  assert.ok(value.endsWith(']\nafter'))
  assert.ok(!value.includes('MIIEowIBAAKCAQEA'))
  assert.equal(hits[0].kind, 'private-key')
})

check('password inside a connection string is masked, host kept', () => {
  const { value } = redactText(SECRETS.url)
  assert.equal(value, 'postgres://app:…[redacted:url-password:7]@db.internal:5432/ops')
})

check('assigned secret keeps the name, separator and quotes', () => {
  const { value } = redactText('{"db_password": "hunter2", "user": "app"}')
  assert.equal(value, '{"db_password": "…[redacted:assigned-secret:7]", "user": "app"}')
})

check('bearer header keeps the scheme', () => {
  const { value } = redactText(`curl -H 'Authorization: Bearer abcdefghijklmnop123'`)
  assert.ok(value.includes('Bearer abcd…[redacted:bearer:19]'))
  assert.ok(!value.includes('abcdefghijklmnop123'))
})

check('short secrets keep no prefix', () => {
  const { value } = redactText('password=abc')
  assert.equal(value, 'password=…[redacted:assigned-secret:3]')
})

check('normal prose is untouched (no false positive)', () => {
  const input = 'please reset your password later, then restart the unit'
  const { value, hits } = redactText(input)
  assert.equal(value, input)
  assert.deepEqual(hits, [])
})

check('plain URLs without credentials are untouched', () => {
  const input = 'see https://example.com/docs?page=2 for details'
  assert.equal(redactText(input).value, input)
})

check('redaction is idempotent', () => {
  const inputs = [
    SECRETS.url,
    `OPENAI_API_KEY=${SECRETS.openai}`,
    `Authorization: Bearer ${SECRETS.jwt}`,
    'DB_PASSWORD="hunter2"',
  ]
  for (const input of inputs) {
    const once = redactText(input).value
    assert.equal(redactText(once).value, once)
  }
})

check('deep walk preserves shape and non-string leaves', () => {
  const input = { retries: 3, ok: true, at: null, nested: { list: ['clean', SECRETS.aws] } }
  const { value, hits } = redactDeep(input)
  assert.equal(value.retries, 3)
  assert.equal(value.ok, true)
  assert.equal(value.at, null)
  assert.equal(value.nested.list[0], 'clean')
  assert.ok(value.nested.list[1].includes('[redacted:aws-access-key:'))
  assert.equal(hits.length, 1)
})

check('deep walk tolerates cycles', () => {
  const node = { name: 'root' }
  node.self = node
  const { value } = redactDeep(node)
  assert.equal(value.name, 'root')
  assert.equal(value.self, node)
})

// --- four mount points (D19-2) ---

check('mount 1 / log: message body is masked', () => {
  const { value } = redactDeep({ level: 50, msg: `connect ${SECRETS.url}` })
  assert.ok(value.msg.includes('[redacted:url-password:'))
})

check('mount 1 / log: error message and stack are masked', () => {
  const error = new Error(`failed with ${SECRETS.aws}`)
  error.stack = `Error: failed with ${SECRETS.aws}\n    at run (cli.js:1:1)`
  const { value, hits } = redactError(error)
  assert.ok(!value.message.includes(SECRETS.aws))
  assert.ok(!String(value.stack).includes(SECRETS.aws))
  assert.equal(hits.length, 2)
})

check('mount 2 / audit: command text is masked before insert', () => {
  const { value } = redactDeep({
    action: 'execute',
    argv: ['sh', '-c', `export AWS_ACCESS_KEY_ID=${SECRETS.aws}`],
    exitCode: 1,
  })
  assert.ok(value.argv[2].includes('[redacted:aws-access-key:'))
  assert.equal(value.exitCode, 1)
})

check('mount 3 / outbound: reply text is masked', () => {
  const { value } = redactText(`你的 key 是 ${SECRETS.openai}，请妥善保存`)
  assert.ok(value.includes('[redacted:api-key:'))
  assert.ok(value.startsWith('你的 key 是 '))
})

check('mount 4 / memory: fact value is masked', () => {
  const fact = { subject: 'ops-db', predicate: 'dsn', value: SECRETS.url }
  const { value } = redactDeep(fact)
  assert.equal(value.subject, 'ops-db')
  assert.ok(value.value.includes('[redacted:url-password:'))
})

check('hits never carry the original secret', () => {
  const { hits } = redactText(`${SECRETS.url} ${SECRETS.aws}`)
  const serialized = JSON.stringify(hits)
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!serialized.includes(secret))
  }
  assert.equal(hits.length, 2)
})

console.log(`\nredact: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
