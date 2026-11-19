// Données de l'application : réglages, pattes (modèles de montage) et clips.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_CHAT_WORD, normalizeChatWords } from '../shared/chatcommand'
import { cloneLook, defaultLook, editSignature, normalizeLook } from '../shared/presets'
import type { ChannelConfig, Clip, Look, Settings, Template } from '../shared/types'
import { readJson, writeJson } from './jsonfile'
import { libraryFile, settingsFile, templatesFile } from './paths'

let settings: Settings
let templates: Template[] = []
let clips: Clip[] = []
let clipsTimer: NodeJS.Timeout | null = null

export function defaultSettings(videosDir: string): Settings {
  return {
    recordingsDir: join(videosDir, 'AutoClip', 'Enregistrements'),
    readyDir: join(videosDir, 'AutoClip', 'Clips prêts'),
    channels: [],
    hotkey: { enabled: true, accelerator: 'F8', before: 30 },
    detection: {
      chat: true,
      volume: true,
      clipWord: true,
      hotkey: true,
      voice: false,
      sensitivity: 1,
      maxPerHour: 6,
      minLength: 15,
      maxLength: 60,
      chatUsers: 2,
      trusted: [],
      chatWords: [DEFAULT_CHAT_WORD],
      fixedLength: 0,
      after: 5
    },
    transcription: { enabled: true, language: 'fr', model: 'small', gpu: false },
    render: { auto: false, fps: 30, encoder: 'auto' },
    defaultTemplateId: null,
    deleteRecordingAfterAnalysis: false,
    openAtLogin: false,
    onboarded: false
  }
}

export function loadStore(videosDir: string): void {
  const d = defaultSettings(videosDir)
  const s = readJson<Partial<Settings>>(settingsFile(), {})
  settings = {
    ...d,
    ...s,
    hotkey: { ...d.hotkey, ...(s.hotkey ?? {}) },
    detection: {
      ...d.detection,
      ...(s.detection ?? {}),
      trusted: Array.isArray(s.detection?.trusted) ? s.detection.trusted : [],
      chatWords: normalizeChatWords(s.detection?.chatWords)
    },
    transcription: { ...d.transcription, ...(s.transcription ?? {}) },
    render: { ...d.render, ...(s.render ?? {}) },
    channels: Array.isArray(s.channels) ? s.channels : []
  }
  templates = readJson<Template[]>(templatesFile(), []).map((t) => ({ ...t, look: normalizeLook(t.look) }))
  clips = readJson<Clip[]>(libraryFile(), []).map((c) => {
    const look = normalizeLook(c.look)
    // Les réglages ajoutés au look par une nouvelle version (ex. options de l'intro en 0.3) ont la
    // valeur qui reproduit l'ancien rendu : un clip validé avant la mise à jour reste « à jour ».
    const migratedSig = c.renderSig && c.renderSig === editSignature(c) ? editSignature({ ...c, look }) : (c.renderSig ?? null)
    return {
      ...c,
      // Champs ajoutés dans les versions suivantes.
      renderSig: migratedSig,
      final: c.final ?? null,
      live: c.live ?? false,
      segment: c.segment ?? null,
      look,
      // Un rendu interrompu par la fermeture de l'application est à refaire.
      render: c.render.state === 'running' || c.render.state === 'queued' ? { state: 'idle' as const, progress: 0, error: null, at: c.render.at } : c.render
    }
  })
}

// ---------- Réglages ----------

export function getSettings(): Settings {
  return settings
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch }
  if (patch.detection) settings.detection = { ...settings.detection, chatWords: normalizeChatWords(settings.detection.chatWords) }
  writeJson(settingsFile(), settings)
  return settings
}

export function updateChannel(login: string, patch: Partial<ChannelConfig>): void {
  updateSettings({ channels: settings.channels.map((c) => (c.login === login ? { ...c, ...patch } : c)) })
}

// ---------- Pattes ----------

export function getTemplates(): Template[] {
  return templates
}

function saveTemplates(): void {
  writeJson(templatesFile(), templates)
}

export function createTemplate(name: string, look: Look): Template {
  const now = Date.now()
  const t: Template = { id: randomUUID(), name: name.trim() || 'Ma patte', look: cloneLook(look), createdAt: now, updatedAt: now }
  templates = [...templates, t]
  saveTemplates()
  return t
}

export function updateTemplate(id: string, patch: { name?: string; look?: Look }): Template | null {
  let updated: Template | null = null
  templates = templates.map((t) => {
    if (t.id !== id) return t
    updated = { ...t, ...(patch.name !== undefined ? { name: patch.name.trim() || t.name } : {}), ...(patch.look ? { look: cloneLook(patch.look) } : {}), updatedAt: Date.now() }
    return updated
  })
  saveTemplates()
  return updated
}

export function deleteTemplate(id: string): void {
  templates = templates.filter((t) => t.id !== id)
  saveTemplates()
  if (settings.defaultTemplateId === id) updateSettings({ defaultTemplateId: null })
  if (settings.channels.some((c) => c.templateId === id)) {
    updateSettings({ channels: settings.channels.map((c) => (c.templateId === id ? { ...c, templateId: null } : c)) })
  }
}

/** La patte qui s'applique aux nouveaux clips d'une chaîne. */
export function templateFor(channel: string): Template | null {
  const ch = settings.channels.find((c) => c.login === channel)
  const id = ch?.templateId ?? settings.defaultTemplateId
  return templates.find((t) => t.id === id) ?? null
}

export function lookFor(channel: string): { look: Look; templateId: string | null } {
  const t = templateFor(channel)
  return t ? { look: cloneLook(t.look), templateId: t.id } : { look: defaultLook(), templateId: null }
}

// ---------- Clips ----------

export function getClips(): Clip[] {
  return clips
}

export function clipById(id: string): Clip | undefined {
  return clips.find((c) => c.id === id)
}

export function saveClipsSoon(): void {
  if (clipsTimer) return
  clipsTimer = setTimeout(() => {
    clipsTimer = null
    writeJson(libraryFile(), clips)
  }, 400)
}

export function flushClips(): void {
  if (clipsTimer) clearTimeout(clipsTimer)
  clipsTimer = null
  writeJson(libraryFile(), clips)
}

export function addClips(list: Clip[]): void {
  clips = [...clips, ...list]
  saveClipsSoon()
}

export function updateClip(id: string, patch: Partial<Clip>): Clip | null {
  let updated: Clip | null = null
  clips = clips.map((c) => {
    if (c.id !== id) return c
    updated = { ...c, ...patch }
    return updated
  })
  saveClipsSoon()
  return updated
}

export function removeClips(ids: string[]): Clip[] {
  const removed = clips.filter((c) => ids.includes(c.id))
  clips = clips.filter((c) => !ids.includes(c.id))
  saveClipsSoon()
  return removed
}
