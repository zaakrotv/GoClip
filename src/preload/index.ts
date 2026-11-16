// Pont sécurisé entre l'interface (React) et le processus principal.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, type WindowApi } from '../shared/api'
import type { AppState } from '../shared/types'

const api: Record<string, unknown> = {}
for (const name of API_METHODS) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args)
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

api.onState = (cb: (s: AppState) => void) => subscribe('state', cb)
api.onClips = (cb: () => void) => subscribe('clips', cb)
api.onTemplates = (cb: () => void) => subscribe('templates', cb)
api.onPosts = (cb: () => void) => subscribe('posts', cb)
// Le glisser-déposer d'un fichier hors de la fenêtre doit partir pendant l'événement « dragstart ».
api.startDrag = (file: string) => ipcRenderer.send('start-drag', file)

contextBridge.exposeInMainWorld('api', api as unknown as WindowApi)
