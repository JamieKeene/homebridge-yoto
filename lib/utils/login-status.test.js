import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearLoginProblem, loginStatusPath, readLoginProblem, tokenFingerprint, writeLoginProblem } from './login-status.js'

const makeDir = () => mkdtempSync(join(tmpdir(), 'yoto-login-status-'))

test('a recorded problem is reported for the login it belongs to', async () => {
  const dir = makeDir()
  const now = new Date('2026-09-25T04:42:35Z')
  await writeLoginProblem(dir, { message: 'Yoto rejected the saved login', refreshToken: 'dead-token', now })

  assert.deepEqual(await readLoginProblem(dir, 'dead-token'), {
    message: 'Yoto rejected the saved login',
    at: '2026-09-25T04:42:35.000Z',
    tokenFingerprint: tokenFingerprint('dead-token'),
  })
})

test('a problem recorded for a replaced login is ignored', async () => {
  const dir = makeDir()
  await writeLoginProblem(dir, { message: 'expired', refreshToken: 'old-token' })

  assert.equal(await readLoginProblem(dir, 'new-token'), null)
  assert.equal(await readLoginProblem(dir, undefined), null)
})

test('the file holds a fingerprint, not the token', async () => {
  const dir = makeDir()
  await writeLoginProblem(dir, { message: 'expired', refreshToken: 'secret-refresh-token' })

  const contents = readFileSync(loginStatusPath(dir), 'utf8')
  assert.ok(!contents.includes('secret-refresh-token'))
  assert.match(contents, /"tokenFingerprint": "[0-9a-f]{16}"/)
})

test('clearing removes the problem for that login, and clearing twice is fine', async () => {
  const dir = makeDir()
  await writeLoginProblem(dir, { message: 'expired', refreshToken: 'dead-token' })

  await clearLoginProblem(dir, 'dead-token')
  await clearLoginProblem(dir, 'dead-token')
  assert.equal(await readLoginProblem(dir, 'dead-token'), null)
})

test('clearing keeps a problem recorded for another login', async () => {
  const dir = makeDir()
  await writeLoginProblem(dir, { message: 'expired', refreshToken: 'other-token' })

  await clearLoginProblem(dir, 'working-token')
  assert.ok(await readLoginProblem(dir, 'other-token'))
})

test('a missing or malformed file reads as no problem', async () => {
  const dir = makeDir()
  assert.equal(await readLoginProblem(dir, 'token'), null)

  writeFileSync(loginStatusPath(dir), 'not json')
  assert.equal(await readLoginProblem(dir, 'token'), null)

  writeFileSync(loginStatusPath(dir), JSON.stringify({ tokenFingerprint: tokenFingerprint('token') }))
  assert.equal(await readLoginProblem(dir, 'token'), null, 'a record without a message is ignored')
})
