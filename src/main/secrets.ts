// Secrets (clé API du conseiller IA) : chiffrés avec le coffre de Windows (DPAPI, via Electron),
// jamais envoyés à l'interface.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { dataDir } from './paths'

type SecretName = 'anthropic'

const file = (): string => join(dataDir(), 'secrets.json')

function readAll(): Partial<Record<SecretName, string>> {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Partial<Record<SecretName, string>>) : {}
  } catch {
    return {}
  }
}

export function getSecret(name: SecretName): string | null {
  const enc = readAll()[name]
  if (!enc || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function hasSecret(name: SecretName): boolean {
  return getSecret(name) !== null
}

export function setSecret(name: SecretName, value: string | null): void {
  const all = readAll()
  if (value && value.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Le chiffrement de Windows n’est pas disponible : la clé ne peut pas être gardée en sécurité.')
    all[name] = safeStorage.encryptString(value.trim()).toString('base64')
  } else {
    delete all[name]
  }
  if (Object.keys(all).length === 0) rmSync(file(), { force: true })
  else writeFileSync(file(), JSON.stringify(all), 'utf8')
}
