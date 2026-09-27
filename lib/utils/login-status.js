/**
 * @fileoverview Records a Yoto login that stopped working, so the settings UI can
 * say so. The plugin runs in a child bridge and the settings UI in the Homebridge
 * UI process, so they share this small file in the Homebridge storage folder.
 */

import { createHash } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LOGIN_STATUS_FILE = 'yoto-login-status.json'

/**
 * @typedef {Object} LoginProblem
 * @property {string} message - What went wrong, for the settings UI
 * @property {string} at - When it happened (ISO 8601)
 * @property {string | null} tokenFingerprint - Fingerprint of the refresh token that failed
 */

/**
 * A short, one-way fingerprint of a refresh token. It tells which login a
 * problem belongs to without storing the token.
 * @param {unknown} refreshToken
 * @returns {string | null}
 */
export function tokenFingerprint (refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) return null
  return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)
}

/**
 * @param {string} storagePath - Homebridge storage folder
 * @returns {string}
 */
export function loginStatusPath (storagePath) {
  return join(storagePath, LOGIN_STATUS_FILE)
}

/**
 * Record that the login holding `refreshToken` no longer works.
 * @param {string} storagePath
 * @param {{ message: string, refreshToken: unknown, now?: Date }} problem
 * @returns {Promise<void>}
 */
export async function writeLoginProblem (storagePath, { message, refreshToken, now = new Date() }) {
  /** @type {LoginProblem} */
  const record = { message, at: now.toISOString(), tokenFingerprint: tokenFingerprint(refreshToken) }
  const path = loginStatusPath(storagePath)
  const tmpPath = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(tmpPath, path)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Remove the problem recorded for the login holding `refreshToken`, once that
 * login works after all. A problem recorded for another login (e.g. another
 * Yoto platform block) is kept.
 * @param {string} storagePath
 * @param {unknown} refreshToken
 * @returns {Promise<void>}
 */
export async function clearLoginProblem (storagePath, refreshToken) {
  if (!await readLoginProblem(storagePath, refreshToken)) return
  try {
    await unlink(loginStatusPath(storagePath))
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
}

/**
 * The recorded problem for the login holding `refreshToken`, if any. A problem
 * recorded for another login (e.g. one replaced by signing in again) is ignored.
 * @param {string} storagePath
 * @param {unknown} refreshToken
 * @returns {Promise<LoginProblem | null>}
 */
export async function readLoginProblem (storagePath, refreshToken) {
  const fingerprint = tokenFingerprint(refreshToken)
  if (!fingerprint) return null

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(await readFile(loginStatusPath(storagePath), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = /** @type {Record<string, unknown>} */ (parsed)
  if (record['tokenFingerprint'] !== fingerprint) return null
  if (typeof record['message'] !== 'string' || typeof record['at'] !== 'string') return null
  return { message: record['message'], at: record['at'], tokenFingerprint: fingerprint }
}
