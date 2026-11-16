// Mises à jour automatiques : l'application vérifie les nouvelles versions publiées
// (GitHub Releases, voir electron-builder.yml), les télécharge et les installe au redémarrage.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

const EVERY = 4 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle', version: null, progress: 0, error: null }
let listener: () => void = () => {}

export const updateState = (): UpdateState => state

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  listener()
}

/** Les mises à jour ne marchent que dans l'appli installée, avec une adresse de publication réglée. */
function configured(): boolean {
  if (process.env.AUTOCLIP_UPDATE_URL) return true
  if (!app.isPackaged) return false
  const file = join(process.resourcesPath, 'app-update.yml')
  return existsSync(file) && !/CHANGE-MOI/.test(readFileSync(file, 'utf8'))
}

export function initUpdater(onChange: () => void): void {
  listener = onChange
  if (!configured()) {
    set({ status: 'unconfigured' })
    return
  }
  // Adresse de test (serveur local) : AUTOCLIP_UPDATE_URL=http://127.0.0.1:8123
  if (process.env.AUTOCLIP_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.AUTOCLIP_UPDATE_URL })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, progress: 0 }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, progress: 1 }))
  autoUpdater.on('error', (err) => {
    console.error('[mise à jour]', err)
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  })
  setTimeout(checkForUpdates, 15_000)
  setInterval(checkForUpdates, EVERY)
}

export function checkForUpdates(): void {
  if (state.status === 'unconfigured' || state.status === 'downloading' || state.status === 'ready') return
  autoUpdater.checkForUpdates().catch((err: unknown) => set({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
}

/** Installe la mise à jour téléchargée et relance l'application. */
export function installUpdate(beforeQuit: () => void): void {
  if (state.status !== 'ready') return
  beforeQuit()
  autoUpdater.quitAndInstall(true, true)
}
