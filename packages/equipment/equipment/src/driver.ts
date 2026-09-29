/** Pure type contract for equipment driver providers.
 *
 * This subpath contains no equipment implementation or storage imports. A
 * driver repository can depend on it for registration types while its Host
 * face resolves the real `@snap-rail/equipment` provider at runtime.
 *
 * @module @snap-rail/equipment/driver
 */

export type {
  DialectConfig,
  DriverConnection,
  DriverDevice,
  DriverHandle,
  DriverPoint,
  DriverRegistration,
  DriverSchemas,
  WriteHandler,
} from './index.ts'
