/** @import { API, PlatformAccessory } from 'homebridge' */

/**
 * Make HomeKit show an accessory as "Not Responding". Every read and write fails
 * with a communication error, instead of the tiles showing the last known state
 * and silently ignoring taps.
 *
 * This replaces the handlers for good. Nothing needs them back: a new sign-in only
 * takes effect when the child bridge restarts, which sets them up again.
 * @param {PlatformAccessory} accessory
 * @param {API['hap']} hap
 */
export function markAccessoryUnreachable (accessory, hap) {
  const { Service, Characteristic, HapStatusError, HAPStatus, Perms } = hap
  const skippedServices = new Set([Service.AccessoryInformation.UUID, Service.ProtocolInformation.UUID])
  // Keep names readable so the Home app still shows which tile is which
  const skippedCharacteristics = new Set([Characteristic.Name.UUID, Characteristic.ConfiguredName.UUID])
  const fail = () => {
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  }

  for (const service of accessory.services) {
    if (skippedServices.has(service.UUID)) continue
    for (const characteristic of service.characteristics) {
      if (skippedCharacteristics.has(characteristic.UUID)) continue
      const { perms } = characteristic.props
      if (perms.includes(Perms.PAIRED_READ)) characteristic.onGet(fail)
      if (perms.includes(Perms.PAIRED_WRITE)) characteristic.onSet(fail)
    }
  }
}
