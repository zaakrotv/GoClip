import { useCallback, useEffect, useState } from 'react'
import type { AppState, Clip, Settings, Template } from '../../shared/types'
import { api } from './api'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    void api().getState().then(setState)
    return api().onState(setState)
  }, [])
  return state
}

export function useClips(): [Clip[], () => void] {
  const [clips, setClips] = useState<Clip[]>([])
  const reload = useCallback(() => void api().listClips().then(setClips), [])
  useEffect(() => {
    reload()
    return api().onClips(reload)
  }, [reload])
  return [clips, reload]
}

export function useTemplates(): [Template[], () => void] {
  const [list, setList] = useState<Template[]>([])
  const reload = useCallback(() => void api().listTemplates().then(setList), [])
  useEffect(() => {
    reload()
    return api().onTemplates(reload)
  }, [reload])
  return [list, reload]
}

export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>, (s: Settings) => void] {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api().getSettings().then(setSettings)
    // Les réglages peuvent changer ailleurs (chaînes, patte par défaut).
    return api().onState(() => void api().getSettings().then(setSettings))
  }, [])
  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api().updateSettings(patch))
  }, [])
  return [settings, update, setSettings]
}

export function useHashRoute(): [string, (r: string) => void] {
  const read = (): string => window.location.hash.replace(/^#\/?/, '') || 'chaines'
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = (): void => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((r: string) => {
    window.location.hash = `#/${r}`
  }, [])
  return [route, go]
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'à l’instant'
  const m = Math.round(s / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `il y a ${h} h`
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

export function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} Go`
  if (n > 1024 ** 2) return `${Math.round(n / 1024 ** 2)} Mo`
  return `${Math.round(n / 1024)} Ko`
}
