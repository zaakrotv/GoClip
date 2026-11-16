// Contrat entre l'interface et le processus principal (exposé sous window.api).
import type { Advice, AiStatus, Network, Post, PostInput, PublishPrefs, TargetState } from './publishing'
import type { AppState, ChannelSuggestion, Clip, ClipStatus, Look, RecordingInfo, Settings, Template } from './types'

export type ClipPatch = Partial<Pick<Clip, 'title' | 'start' | 'end' | 'look' | 'words' | 'status' | 'templateId'>>
export type DepName = 'streamlink' | 'whisper' | 'model'
export type FileKind = 'video' | 'image' | 'audio' | 'media'

export interface AutoClipApi {
  getState(): Promise<AppState>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  chooseFolder(kind: 'recordings' | 'ready'): Promise<Settings>
  chooseFile(kind: FileKind): Promise<string | null>
  openPath(file: string): Promise<void>
  showInFolder(file: string): Promise<void>
  /** Ouvre « Clips prêts » (ou son sous-dossier pour une chaîne), en le créant s'il n'existe pas. */
  openReadyFolder(channel: string | null): Promise<void>

  searchChannels(query: string): Promise<ChannelSuggestion[]>
  addChannel(input: string): Promise<{ ok: boolean; error?: string }>
  removeChannel(login: string): Promise<void>
  setChannelPaused(login: string, paused: boolean): Promise<void>
  stopRecording(login: string): Promise<void>
  resumeRecording(login: string): Promise<void>
  setChannelTemplate(login: string, templateId: string | null): Promise<void>
  markMoment(): Promise<number>

  listRecordings(): Promise<RecordingInfo[]>
  analyzeRecording(file: string): Promise<void>
  importVideo(): Promise<string | null>
  deleteRecording(file: string): Promise<void>

  listClips(): Promise<Clip[]>
  updateClip(id: string, patch: ClipPatch): Promise<Clip | null>
  setClipsStatus(ids: string[], status: ClipStatus): Promise<void>
  deleteClips(ids: string[]): Promise<void>
  emptyTrash(): Promise<number>
  renderClips(ids: string[]): Promise<void>
  /** « Terminé » : le clip passe dans Rendus (avec un rendu à jour) et sa vidéo dans « Clips prêts ». */
  finishClips(ids: string[]): Promise<void>
  cancelClip(id: string): Promise<void>
  transcribeClip(id: string): Promise<void>
  applyLook(ids: string[], look: Look, templateId: string | null, render: boolean): Promise<number>
  /** « Garder » : avec `templateId`, le clip prend aussi cette patte. */
  keepClips(ids: string[], templateId?: string | null): Promise<void>

  listTemplates(): Promise<Template[]>
  createTemplate(name: string, look: Look): Promise<Template>
  updateTemplate(id: string, patch: { name?: string; look?: Look }): Promise<Template | null>
  deleteTemplate(id: string): Promise<void>
  setDefaultTemplate(id: string | null): Promise<Settings>

  installDeps(what: DepName[]): Promise<void>
  cancelJob(id: string): Promise<void>
  /** Met en pause (ou relance) toute la file : le travail en cours est suspendu, rien d'autre ne démarre. */
  pauseQueue(paused: boolean): Promise<void>
  /** Met de côté un travail en attente (il ne démarre pas tant qu'on ne le relance pas). */
  holdJob(id: string, held: boolean): Promise<void>
  /** Fait passer un travail en attente en premier. */
  prioritizeJob(id: string): Promise<void>
  cancelAllJobs(): Promise<void>

  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>

  // ---------- Publication sur les réseaux ----------
  listPosts(): Promise<Post[]>
  savePost(input: PostInput): Promise<Post>
  deletePost(id: string): Promise<void>
  setPostTarget(id: string, network: Network, state: TargetState, url: string | null): Promise<void>
  getPublishPrefs(): Promise<PublishPrefs>
  setPublishPrefs(patch: Partial<PublishPrefs>): Promise<PublishPrefs>
  /** auto = dernier conseil de l'IA s'il a moins d'une semaine, sinon calcul sans IA. */
  getAdvice(mode: 'auto' | 'local' | 'ai'): Promise<Advice>
  suggestCaption(clipId: string, ai: boolean): Promise<{ caption: string; hashtags: string }>
  aiStatus(): Promise<AiStatus>
  setAiKey(key: string | null): Promise<AiStatus>
  /** Télécharge l'IA gratuite maintenant (sinon elle se télécharge au premier clic ✨). */
  prepareLocalAi(): Promise<AiStatus>
  /** Supprime l'IA gratuite du PC (libère ≈ 2 Go). */
  removeLocalAi(): Promise<AiStatus>
  copyText(text: string): Promise<void>
  openUrl(url: string): Promise<void>
}

/** Noms des méthodes appelées par IPC (tout sauf les abonnements). */
export const API_METHODS: (keyof AutoClipApi)[] = [
  'getState', 'getSettings', 'updateSettings', 'chooseFolder', 'chooseFile', 'openPath', 'showInFolder', 'openReadyFolder',
  'searchChannels', 'addChannel', 'removeChannel', 'setChannelPaused', 'stopRecording', 'resumeRecording', 'setChannelTemplate', 'markMoment',
  'listRecordings', 'analyzeRecording', 'importVideo', 'deleteRecording',
  'listClips', 'updateClip', 'setClipsStatus', 'deleteClips', 'emptyTrash', 'renderClips', 'finishClips', 'cancelClip', 'transcribeClip', 'applyLook', 'keepClips',
  'listTemplates', 'createTemplate', 'updateTemplate', 'deleteTemplate', 'setDefaultTemplate',
  'installDeps', 'cancelJob', 'pauseQueue', 'holdJob', 'prioritizeJob', 'cancelAllJobs', 'checkForUpdates', 'installUpdate',
  'listPosts', 'savePost', 'deletePost', 'setPostTarget', 'getPublishPrefs', 'setPublishPrefs', 'getAdvice', 'suggestCaption', 'aiStatus', 'setAiKey', 'prepareLocalAi', 'removeLocalAi', 'copyText', 'openUrl'
]

export interface AutoClipEvents {
  onState(cb: (s: AppState) => void): () => void
  onClips(cb: () => void): () => void
  onTemplates(cb: () => void): () => void
  onPosts(cb: () => void): () => void
  /** Glisser la vidéo d'un clip hors d'AutoClip (vers la page d'envoi d'un réseau, un dossier…). */
  startDrag(file: string): void
}

export type WindowApi = AutoClipApi & AutoClipEvents
