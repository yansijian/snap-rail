/** Generate an Ed25519 release key pair for a publisher trust root. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = process.argv[2]
const keyId = process.argv[3]
const publisherIndex = process.argv.indexOf('--publisher')
const publisher = publisherIndex >= 0 ? process.argv[publisherIndex + 1] : undefined
if (output === undefined || keyId === undefined || output === '' || keyId === '') {
  throw new Error('usage: pnpm run plugin:generate-key -- <directory> <key-id> [--publisher <publisher>]')
}

const directory = resolve(output)
const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
})
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, `${keyId}.private.pem`), privateKey, { mode: 0o600 })
await writeFile(resolve(directory, `${keyId}.public.pem`), publicKey)
await writeFile(resolve(directory, `${keyId}.trust.json`), `${JSON.stringify({
  keys: [{ keyId, ...(publisher === undefined ? {} : { publisher }), publicKeyPem: publicKey }],
}, null, 2)}\n`)
console.log(`generated ${dirname(resolve(directory, `${keyId}.private.pem`))}`)
