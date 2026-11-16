// Point d'entrée d'AutoClip (processus principal Electron).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, shell, Tray } from 'electron'
import { editSignature } from '../shared/presets'
import type { AutoClipApi, ClipPatch, FileKind } from '../shared/api'
import type { AppState, ChannelState, RecordingInfo, Settings } from '../shared/types'
import { analysisFile, chatFile, isAnalyzed, marksFile } from './analyze'
import { depsStatus, installDeps, modelFile, onDepsChange, probeFfmpeg, refreshDeps } from './deps'
import { applyLookToClips, cancelClipJobs, cancelJob, deleteClipFiles, enqueueAnalysis, enqueueLiveClip, enqueueRender, enqueueTranscription, finishClips, initJobs, queueState, stopAll } from './jobs'
import { handleMedia, registerMediaScheme } from './media'
import { configurePaths, dataDir } from './paths'
import { killAll } from './proc'
import { ChannelWatcher } from './recorder'
import * as store from './store'
import { parseChannel, profile, searchChannels } from './twitch'
import { checkForUpdates, initUpdater, installUpdate, updateState } from './updater'
// Version 0.3 : file des travaux pilotable, agenda de publication et conseiller.
import { clipboard } from 'electron'
import { networkInfo, type Network, type Post } from '../shared/publishing'
import { adviceFor, captionFor } from './advisor'
import { cancelAllJobs, holdJob, keepClips, pauseQueue, prioritizeJob } from './jobs'
import { deletePost, forgetClips, getPosts, getPrefs, loadPublishing, savePost, setPrefs, setTarget, startScheduler, stopScheduler } from './publish'
import { hasSecret, setSecret } from './secrets'
// Version 0.3.1 : IA gratuite qui tourne sur le PC (sans clé).
import type { AiStatus } from '../shared/publishing'
import { installLocalAi, localAiInfo, removeLocalAi, stopLocalAi } from './llm'

const aiStatus = (): AiStatus => ({ engine: getPrefs().aiEngine, hasKey: hasSecret('anthropic'), model: getPrefs().aiModel, local: localAiInfo() })

registerMediaScheme()
// Tests automatiques (AUTOCLIP_DATA) : profil et verrou d'instance unique à part, pour ne pas
// réveiller l'AutoClip installé qui tourne peut-être à côté.
if (process.env.AUTOCLIP_DATA) app.setPath('userData', process.env.AUTOCLIP_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
/** Tests automatiques : pas de notification Windows (elles s'afficheraient chez l'utilisateur). */
const silent = process.env.AUTOCLIP_SILENT === '1'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let notice: string | null = null
let blocker: number | null = null
let awake = 0
const watchers = new Map<string, ChannelWatcher>()

const resources = (): string => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'))
const iconPath = (): string => join(resources(), 'icon.png')

// ---------- État envoyé à l'interface ----------

function channelStates(): ChannelState[] {
  return store.getSettings().channels.map(
    (c) =>
      watchers.get(c.login)?.state ?? { login: c.login, status: c.paused ? 'paused' : 'offline', message: null, recordingSince: null, file: null, chat: null, marks: 0, liveClips: 0, nextCheckAt: null, lastRequest: null, voice: null }
  )
}

function appState(): AppState {
  return { channels: channelStates(), queue: queueState(), deps: depsStatus(), notice, version: app.getVersion(), update: updateState() }
}

let stateTimer: NodeJS.Timeout | null = null
function pushState(): void {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    win?.webContents.send('state', appState())
    updateTray()
  }, 120)
}

const pushClips = (): void => win?.webContents.send('clips')
const pushTemplates = (): void => win?.webContents.send('templates')
const pushPosts = (): void => win?.webContents.send('posts')

/** C'est l'heure de publier : notification qui ouvre la publication dans AutoClip. */
function remindPost(post: Post, networks: Network[], late: boolean): void {
  if (silent) return console.log('[rappel de publication]', post.id, networks.join(','), late ? '(en retard)' : '')
  if (!Notification.isSupported()) return
  const clip = store.clipById(post.clipId)
  const title = clip?.title || 'ton clip'
  const where = networks.map((n) => networkInfo(n).label).join(', ')
  const n = new Notification({
    title: late ? 'Publication en retard' : 'C’est l’heure de publier',
    body: `« ${title} » sur ${where}. Clique ici : la vidéo et le texte sont prêts.`,
    icon: iconPath()
  })
  n.on('click', () => {
    showWindow()
    win?.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(`#/publier/${post.id}`)}`).catch(() => undefined)
  })
  n.show()
}

/** Chaînes dont on regarde les lives passés pour conseiller des créneaux. */
function adviceChannels(): string[] {
  const done = store.getClips().filter((c) => c.status === 'done').map((c) => c.channel)
  const followed = store.getSettings().channels.map((c) => c.login)
  const list = [...new Set([...done, ...followed])].filter((c) => c !== 'imports')
  return list.slice(0, 4)
}

function notify(title: string, body: string): void {
  if (silent) return console.log('[notification]', title, '—', body)
  if (Notification.isSupported()) new Notification({ title, body, icon: iconPath() }).show()
}

function keepAwake(on: boolean): void {
  awake = Math.max(0, awake + (on ? 1 : -1))
  if (awake > 0 && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  if (awake === 0 && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}

// ---------- Chaînes ----------

function startWatcher(login: string, paused: boolean): void {
  watchers.get(login)?.dispose()
  watchers.set(
    login,
    new ChannelWatcher(login, paused, {
      onChange: pushState,
      keepAwake,
      onSessionEnd: (files) => {
        for (const f of files) enqueueAnalysis(f)
      },
      onLiveMoment: (file, moment) => enqueueLiveClip(file, moment)
    })
  )
}

function markMoment(): number {
  const before = store.getSettings().hotkey.before
  let n = 0
  for (const w of watchers.values()) if (w.mark(before)) n++
  return n
}

function registerHotkey(): void {
  globalShortcut.unregisterAll()
  const hk = store.getSettings().hotkey
  if (!hk.enabled || !hk.accelerator) return
  try {
    const ok = globalShortcut.register(hk.accelerator, () => {
      const n = markMoment()
      notify(n > 0 ? 'Moment gardé' : 'Aucun live en cours', n > 0 ? `Les ${hk.before} dernières secondes deviendront un clip.` : 'La touche Clip marche pendant un enregistrement.')
    })
    notice = ok ? null : `La touche ${hk.accelerator} est déjà prise par un autre programme : choisis-en une autre dans Réglages.`
  } catch {
    notice = `La touche « ${hk.accelerator} » n’est pas valide.`
  }
  pushState()
}

// ---------- Fichiers ----------

const FILTERS: Record<FileKind, Electron.FileFilter[]> = {
  video: [{ name: 'Vidéos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'ts', 'flv', 'avi', 'm4v'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  audio: [{ name: 'Sons', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac'] }],
  media: [{ name: 'Vidéo ou image', extensions: ['mp4', 'mov', 'mkv', 'webm', 'png', 'jpg', 'jpeg', 'webp'] }]
}

/** Copie un média (intro, logo, musique…) dans les données de l'appli pour qu'il ne disparaisse pas. */
function keepMedia(file: string): string {
  const dir = join(dataDir(), 'medias')
  mkdirSync(dir, { recursive: true })
  const st = statSync(file)
  const hash = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 10)
  const target = join(dir, `${hash}-${basename(file)}`)
  if (!existsSync(target)) copyFileSync(file, target)
  return target
}

function listRecordings(): RecordingInfo[] {
  const root = store.getSettings().recordingsDir
  const out: RecordingInfo[] = []
  if (!existsSync(root)) return out
  const recordingFiles = new Set([...watchers.values()].map((w) => w.state.file).filter(Boolean) as string[])
  for (const ch of readdirSync(root, { withFileTypes: true })) {
    if (!ch.isDirectory()) continue
    const dir = join(root, ch.name)
    for (const f of readdirSync(dir)) {
      if (!/\.(ts|mp4|mkv|mov|webm|flv)$/i.test(f)) continue
      const file = join(dir, f)
      try {
        const st = statSync(file)
        if (!st.isFile()) continue
        const a = isAnalyzed(file)
        out.push({ file, channel: ch.name, size: st.size, modifiedAt: st.mtimeMs, analyzed: !!a, clips: a?.clips ?? 0, recording: recordingFiles.has(file) })
      } catch {
        /* ignoré */
      }
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

// ---------- API pour l'interface ----------

function settingsChanged(before: Settings, after: Settings): void {
  if (JSON.stringify(before.hotkey) !== JSON.stringify(after.hotkey)) registerHotkey()
  if (before.openAtLogin !== after.openAtLogin) app.setLoginItemSettings({ openAtLogin: after.openAtLogin, args: ['--hidden'] })
  if (before.transcription.model !== after.transcription.model) refreshDeps(after.transcription.model)
  if (before.render.encoder !== after.render.encoder) void probeFfmpeg(after.render.encoder)
  if (after.detection.voice && !before.detection.voice) void prepareVoice()
}

/** L'écoute du mot « clip » utilise le petit modèle « base » (rapide) : il est téléchargé s'il manque. */
async function prepareVoice(): Promise<void> {
  const s = store.getSettings()
  if (existsSync(modelFile('base')) && depsStatus().whisper) return
  await installDeps({ model: 'base', gpu: s.transcription.gpu, what: ['whisper', 'model'] })
  // installDeps a vérifié le modèle « base » : on revient au modèle de la transcription.
  refreshDeps(store.getSettings().transcription.model)
  pushState()
}

const api: AutoClipApi = {
  getState: async () => appState(),
  getSettings: async () => store.getSettings(),
  updateSettings: async (patch) => {
    const before = store.getSettings()
    const after = store.updateSettings(patch)
    settingsChanged(before, after)
    pushState()
    return after
  },
  chooseFolder: async (kind) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return store.getSettings()
    return store.updateSettings(kind === 'recordings' ? { recordingsDir: r.filePaths[0] } : { readyDir: r.filePaths[0] })
  },
  chooseFile: async (kind) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: FILTERS[kind] })
    if (r.canceled || !r.filePaths[0]) return null
    return keepMedia(r.filePaths[0])
  },
  openPath: async (file) => {
    await shell.openPath(file)
  },
  showInFolder: async (file) => {
    if (existsSync(file)) shell.showItemInFolder(file)
    else await shell.openPath(file)
  },
  openReadyFolder: async (channel) => {
    const dir = channel ? join(store.getSettings().readyDir, channel) : store.getSettings().readyDir
    mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) throw new Error(`Impossible d’ouvrir le dossier : ${err}`)
  },

  searchChannels: async (query) => {
    try {
      return await searchChannels(query)
    } catch (err) {
      console.error('[recherche]', err)
      return []
    }
  },
  addChannel: async (input) => {
    const login = parseChannel(input)
    if (!login) return { ok: false, error: 'Ce n’est pas un lien ou un pseudo Twitch valide.' }
    if (store.getSettings().channels.some((c) => c.login === login)) return { ok: false, error: 'Cette chaîne est déjà suivie.' }
    let p = null
    try {
      p = await profile(login)
    } catch {
      return { ok: false, error: 'Twitch ne répond pas : vérifie ta connexion internet.' }
    }
    if (!p) return { ok: false, error: 'Cette chaîne Twitch n’existe pas.' }
    store.updateSettings({
      channels: [...store.getSettings().channels, { login, displayName: p.displayName, avatar: p.avatar, paused: false, templateId: null, addedAt: Date.now() }]
    })
    startWatcher(login, false)
    pushState()
    return { ok: true }
  },
  removeChannel: async (login) => {
    watchers.get(login)?.dispose()
    watchers.delete(login)
    store.updateSettings({ channels: store.getSettings().channels.filter((c) => c.login !== login) })
    pushState()
  },
  setChannelPaused: async (login, paused) => {
    store.updateChannel(login, { paused })
    watchers.get(login)?.setPaused(paused)
    pushState()
  },
  stopRecording: async (login) => watchers.get(login)?.stopRecording(),
  resumeRecording: async (login) => watchers.get(login)?.resumeRecording(),
  setChannelTemplate: async (login, templateId) => {
    store.updateChannel(login, { templateId })
    pushState()
  },
  markMoment: async () => markMoment(),

  listRecordings: async () => listRecordings(),
  analyzeRecording: async (file) => enqueueAnalysis(file),
  importVideo: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: FILTERS.video })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = join(store.getSettings().recordingsDir, 'imports')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, basename(r.filePaths[0]))
    if (!existsSync(target)) copyFileSync(r.filePaths[0], target)
    enqueueAnalysis(target)
    return target
  },
  deleteRecording: async (file) => {
    if ([...watchers.values()].some((w) => w.state.file === file)) throw new Error('Ce live est en cours d’enregistrement.')
    for (const f of [file, chatFile(file), marksFile(file), analysisFile(file)]) rmSync(f, { force: true })
  },

  listClips: async () => store.getClips(),
  updateClip: async (id, patch: ClipPatch) => {
    const before = store.clipById(id)
    let c = store.updateClip(id, patch)
    // Un clip terminé qu'on remodifie retourne dans « Gardés » jusqu'à ce qu'on le termine à nouveau.
    if (before && c && before.status === 'done' && patch.status === undefined && editSignature(before) !== editSignature(c)) {
      c = store.updateClip(id, { status: 'kept' })
    }
    pushClips()
    return c
  },
  setClipsStatus: async (ids, status) => {
    for (const id of ids) store.updateClip(id, { status })
    pushClips()
  },
  deleteClips: async (ids) => {
    deleteClipFiles(store.removeClips(ids), true)
    forgetClips(ids)
    pushClips()
  },
  emptyTrash: async () => {
    const ids = store.getClips().filter((c) => c.status === 'trash').map((c) => c.id)
    deleteClipFiles(store.removeClips(ids), true)
    forgetClips(ids)
    pushClips()
    return ids.length
  },
  renderClips: async (ids) => {
    for (const id of ids) enqueueRender(id, 1)
  },
  finishClips: async (ids) => finishClips(ids),
  cancelClip: async (id) => cancelClipJobs(id),
  transcribeClip: async (id) => {
    store.updateClip(id, { words: null, transcribeError: null })
    enqueueTranscription(id, 1)
    pushClips()
  },
  applyLook: async (ids, look, templateId, render) => applyLookToClips(ids, look, templateId, render),
  keepClips: async (ids, templateId) => keepClips(ids, templateId),

  listTemplates: async () => store.getTemplates(),
  createTemplate: async (name, look) => {
    const t = store.createTemplate(name, look)
    pushTemplates()
    return t
  },
  updateTemplate: async (id, patch) => {
    const t = store.updateTemplate(id, patch)
    pushTemplates()
    return t
  },
  deleteTemplate: async (id) => {
    store.deleteTemplate(id)
    pushTemplates()
    pushState()
  },
  setDefaultTemplate: async (id) => {
    const s = store.updateSettings({ defaultTemplateId: id })
    pushTemplates()
    return s
  },

  installDeps: async (what) => {
    const s = store.getSettings()
    await installDeps({ model: s.transcription.model, gpu: s.transcription.gpu, what })
    await probeFfmpeg(s.render.encoder)
    pushState()
  },
  cancelJob: async (id) => cancelJob(id),
  pauseQueue: async (on) => pauseQueue(on),
  holdJob: async (id, held) => holdJob(id, held),
  prioritizeJob: async (id) => prioritizeJob(id),
  cancelAllJobs: async () => cancelAllJobs(),

  checkForUpdates: async () => checkForUpdates(),
  installUpdate: async () =>
    installUpdate(() => {
      quitting = true
    }),

  listPosts: async () => getPosts(),
  savePost: async (input) => savePost(input),
  deletePost: async (id) => deletePost(id),
  setPostTarget: async (id, network, state, url) => {
    setTarget(id, network, state, url)
  },
  getPublishPrefs: async () => getPrefs(),
  setPublishPrefs: async (patch) => setPrefs(patch),
  getAdvice: async (mode) => adviceFor(adviceChannels(), mode),
  suggestCaption: async (clipId, ai) => {
    const clip = store.clipById(clipId)
    if (!clip) throw new Error('Ce clip n’existe plus.')
    return captionFor(clip, ai)
  },
  aiStatus: async () => aiStatus(),
  setAiKey: async (key) => {
    const k = key?.trim() ?? ''
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('Ce n’est pas une clé API Anthropic (elle commence par « sk-ant- »).')
    setSecret('anthropic', k || null)
    return aiStatus()
  },
  prepareLocalAi: async () => {
    await installLocalAi()
    return aiStatus()
  },
  removeLocalAi: async () => {
    removeLocalAi()
    return aiStatus()
  },
  copyText: async (text) => clipboard.writeText(text),
  openUrl: async (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Adresse refusée.')
    await shell.openExternal(url)
  }
}

function registerIpc(): void {
  for (const [name, fn] of Object.entries(api)) {
    ipcMain.handle(`api:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  // Glisser la vidéo d'un clip hors de la fenêtre (vers la page d'envoi d'un réseau).
  // Seules les vidéos des clips connus peuvent partir.
  ipcMain.on('start-drag', (e, file: unknown) => {
    if (typeof file !== 'string' || !existsSync(file)) return
    const known = store.getClips().some((c) => c.final === file || c.output === file)
    if (!known) return
    const icon = nativeImage.createFromPath(iconPath()).resize({ width: 48, height: 48 })
    e.sender.startDrag({ file, icon })
  })
}

// ---------- Fenêtre et icône de la barre des tâches ----------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    title: 'GoClip',
    icon: iconPath(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.once('ready-to-show', () => {
    // Lancé avec Windows : l'appli démarre discrètement dans la barre des tâches.
    if (!process.argv.includes('--hidden')) win?.show()
  })
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
    if (!store.getSettings().onboarded || store.getSettings().channels.length > 0) {
      notify('GoClip continue en arrière-plan', 'Les lives sont toujours surveillés. Clic droit sur l’icône pour quitter.')
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const page = process.env.AUTOCLIP_PAGE ? `#/${process.env.AUTOCLIP_PAGE}` : ''
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + page)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: page.slice(1) || undefined })

  // Mode capture d'écran (tests automatiques) : AUTOCLIP_CAPTURE=chemin.png
  const capture = process.env.AUTOCLIP_CAPTURE
  if (capture) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage()
        writeFileSync(capture, img.toPNG())
        quitting = true
        app.quit()
      }, Number(process.env.AUTOCLIP_CAPTURE_DELAY ?? 2500))
    })
  }
}

function showWindow(): void {
  if (!win) createWindow()
  win?.show()
  win?.focus()
}

function updateTray(): void {
  if (!tray) return
  const rec = channelStates().filter((c) => c.status === 'recording').length
  tray.setToolTip(rec > 0 ? `GoClip — ${rec} live${rec > 1 ? 's' : ''} en enregistrement` : 'GoClip')
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir GoClip', click: showWindow },
      { label: 'Garder ce moment (touche Clip)', click: () => markMoment() },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
  updateTray()
}

// ---------- Démarrage ----------

app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  configurePaths({ data: process.env.AUTOCLIP_DATA ?? app.getPath('userData'), resources: resources() })
  store.loadStore(app.getPath('videos'))
  loadPublishing()
  handleMedia()
  registerIpc()
  initJobs({ onQueue: pushState, onClips: pushClips, notify })
  if (!process.env.AUTOCLIP_CAPTURE) startScheduler({ onChange: pushPosts, remind: remindPost })
  onDepsChange(pushState)
  if (!process.env.AUTOCLIP_CAPTURE) initUpdater(pushState)
  refreshDeps(store.getSettings().transcription.model)
  createWindow()
  if (!process.env.AUTOCLIP_CAPTURE) createTray()
  registerHotkey()
  const s = store.getSettings()
  const d = depsStatus()
  if (!process.env.AUTOCLIP_CAPTURE && (!d.streamlink || !d.ffmpeg || !d.whisper || !d.model || !d.vad)) {
    // Premier lancement : les outils manquants se téléchargent tout seuls.
    void installDeps({ model: s.transcription.model, gpu: s.transcription.gpu, what: ['streamlink', 'whisper', 'model'] })
      .then(() => probeFfmpeg(s.render.encoder))
      .then(() => (store.getSettings().detection.voice ? prepareVoice() : undefined))
  } else {
    void probeFfmpeg(s.render.encoder)
    if (!process.env.AUTOCLIP_CAPTURE && s.detection.voice) void prepareVoice()
  }
  for (const c of store.getSettings().channels) startWatcher(c.login, c.paused)
  // Lives enregistrés mais pas encore analysés (appli fermée pendant le traitement).
  if (!process.env.AUTOCLIP_CAPTURE) {
    for (const r of listRecordings()) if (!r.analyzed && !r.recording && existsSync(chatFile(r.file)) && extname(r.file) === '.ts') enqueueAnalysis(r.file)
  }
})

app.on('window-all-closed', () => {
  /* l'application reste dans la barre des tâches */
})

app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  stopScheduler()
  stopAll()
  for (const w of watchers.values()) w.dispose()
  stopLocalAi()
  killAll()
  store.flushClips()
})
