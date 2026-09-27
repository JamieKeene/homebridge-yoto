/** @import { PlatformAccessory, API } from 'homebridge' */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as hap from '@homebridge/hap-nodejs'
import { markAccessoryUnreachable } from './unreachable.js'

const { Service, Characteristic, HAPStatus } = hap

/**
 * The status a read fails with (HAP turns a thrown HapStatusError into its status code)
 * @param {hap.Characteristic} characteristic
 * @returns {Promise<unknown>}
 */
async function readError (characteristic) {
  try {
    await characteristic.handleGetRequest()
  } catch (error) {
    return error
  }
  return undefined
}

function makeAccessory () {
  const accessory = new hap.Accessory('Shep\'s Yoto', hap.uuid.generate('unreachable-test'))
  const playback = accessory.addService(Service.Switch, 'Playback', 'playback')
  playback.getCharacteristic(Characteristic.On).onGet(() => true).onSet(() => {})
  const input = accessory.addService(Service.InputSource, 'The Gruffalo', 'input')
  input.setCharacteristic(Characteristic.ConfiguredName, 'The Gruffalo')
  return { accessory, playback, input }
}

/** @param {hap.Accessory} accessory */
function asPlatformAccessory (accessory) {
  return /** @type {PlatformAccessory} */ (/** @type {unknown} */ ({ services: accessory.services }))
}

const apiHap = /** @type {API['hap']} */ (/** @type {unknown} */ (hap))

test('reads and writes fail with a communication error', async () => {
  const { accessory, playback } = makeAccessory()
  markAccessoryUnreachable(asPlatformAccessory(accessory), apiHap)

  const on = playback.getCharacteristic(Characteristic.On)
  assert.equal(await readError(on), HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  await assert.rejects(on.handleSetRequest(false), (/** @type {unknown} */ status) =>
    status === HAPStatus.SERVICE_COMMUNICATION_FAILURE)
})

test('characteristics without handlers stop reporting their cached value too', async () => {
  const { accessory, input } = makeAccessory()
  markAccessoryUnreachable(asPlatformAccessory(accessory), apiHap)

  assert.equal(await readError(input.getCharacteristic(Characteristic.IsConfigured)), HAPStatus.SERVICE_COMMUNICATION_FAILURE)
})

test('names and accessory information stay readable', async () => {
  const { accessory, playback, input } = makeAccessory()
  markAccessoryUnreachable(asPlatformAccessory(accessory), apiHap)

  assert.equal(await playback.getCharacteristic(Characteristic.Name).handleGetRequest(), 'Playback')
  assert.equal(await input.getCharacteristic(Characteristic.ConfiguredName).handleGetRequest(), 'The Gruffalo')
  const info = accessory.getService(Service.AccessoryInformation)
  assert.equal(await info?.getCharacteristic(Characteristic.Name).handleGetRequest(), 'Shep\'s Yoto')
  assert.equal(await readError(/** @type {hap.Characteristic} */ (info?.getCharacteristic(Characteristic.Manufacturer))), undefined)
})
