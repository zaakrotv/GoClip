// Types partagés entre le processus principal (Electron) et l'interface (React).

/** Rectangle normalisé (0..1) dans l'image source 16:9. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Mises en page du rendu :
 * - blur        : jeu centré sur un fond flou (vertical)
 * - camera-game : caméra en haut (ou en bas) + jeu (vertical)
 * - camera      : caméra plein cadre (vertical)
 * - game        : jeu recadré plein cadre (vertical)
 * - horizontal  : image d'origine 16:9 (YouTube)
 */
export type LayoutId = 'blur' | 'camera-game' | 'camera' | 'game' | 'horizontal'

export interface Framing {
  layout: LayoutId
  camera: Box
  game: Box
  /** Hauteur (px sur 1920) de la zone caméra en mise en page caméra + jeu. */
  split: number
  cameraOnTop: boolean
}

export interface SubtitleStyle {
  enabled: boolean
  preset: string
  font: string
  /** Taille de police en px (sortie 1080 de large). */
  size: number
  /** Couleur du mot prononcé. */
  color: string
  /** Couleur des autres mots. */
  base: string
  outline: number
  outlineColor: string
  shadow: number
  uppercase: boolean
  /** Nombre de mots affichés ensemble. */
  words: number
  /** Agrandissement du mot prononcé (1 = aucun). */
  pop: number
  /** Les mots déjà prononcés restent colorés. */
  karaoke: boolean
  /** Position horizontale du centre des sous-titres (0 = gauche, 1 = droite). */
  x: number
  /** Position verticale du centre des sous-titres (0 = haut, 1 = bas). */
  y: number
}

export interface TitleStyle {
  enabled: boolean
  font: string
  size: number
  color: string
  background: string
  band: boolean
  /** Position du centre du titre (0..1). */
  x: number
  y: number
  /** Durée d'affichage en secondes (0 = tout le clip). */
  duration: number
}

export interface MediaSlot {
  enabled: boolean
  file: string | null
}

/**
 * pause : le clip attend la fin de l'intro (sa première image reste figée derrière) ;
 * play  : le clip démarre tout de suite, sous l'intro.
 * (Pour l'outro : pause = la dernière image reste figée, play = l'outro passe sur la fin du clip.)
 */
export type IntroMode = 'pause' | 'play'

export interface IntroStyle extends MediaSlot {
  mode: IntroMode
  /** Flou de l'image du clip derrière l'intro : 0 = net, 100 = très flou. */
  blur: number
  /** Durée du fondu (s) entre l'intro et le clip (0 = coupe franche). */
  fade: number
}

export interface LogoStyle extends MediaSlot {
  /** Position du centre (0..1). */
  x: number
  y: number
  /** Largeur relative à la largeur de la vidéo (0..1). */
  width: number
  opacity: number
}

export interface MusicStyle extends MediaSlot {
  volume: number
}

/** Le « look » d'un montage : c'est ce qu'une patte (modèle) mémorise. */
export interface Look {
  framing: Framing
  subtitles: SubtitleStyle
  title: TitleStyle
  intro: IntroStyle
  outro: IntroStyle
  logo: LogoStyle
  music: MusicStyle
  sourceVolume: number
}

export interface Template {
  id: string
  name: string
  look: Look
  createdAt: number
  updatedAt: number
}

export interface Word {
  text: string
  /** Secondes, relatives au début du fichier source du clip. */
  start: number
  end: number
}

/**
 * new  = À trier (trouvé automatiquement)
 * kept = Gardé : en cours de montage, on peut valider et remodifier autant de fois qu'on veut
 * done = Rendu : terminé, prêt à publier (copié dans « Clips prêts »)
 */
export type ClipStatus = 'new' | 'kept' | 'done' | 'trash'
export type Reason = 'chat' | 'volume' | 'clip-word' | 'hotkey' | 'manual' | 'voice'
export type RenderState = 'idle' | 'queued' | 'running' | 'done' | 'error'

export interface Clip {
  id: string
  channel: string
  recording: string | null
  /** Horodatage (ms) du moment fort. */
  momentAt: number
  /** Fichier source 16:9 extrait du live (avec des marges avant/après). */
  source: string
  sourceDuration: number
  /** Début / fin du clip dans le fichier source (s). */
  start: number
  end: number
  peak: number
  score: number
  level: 'sure' | 'review'
  reasons: Reason[]
  chatWord: string | null
  status: ClipStatus
  createdAt: number
  thumbnail: string | null
  title: string
  /** null = pas encore transcrit. */
  words: Word[] | null
  transcribeError: string | null
  look: Look
  templateId: string | null
  /** Dernier rendu (fichier de travail, ou fichier de « Clips prêts » une fois terminé). */
  output: string | null
  /** Empreinte du montage au moment du dernier rendu (pour savoir s'il est à jour). */
  renderSig: string | null
  /** Fichier publié dans « Clips prêts » quand le clip est terminé. */
  final: string | null
  /** Créé pendant le live (touche Clip, « clip » dans le tchat) : gardé lors d'une nouvelle analyse. */
  live: boolean
  /** Position du moment dans l'enregistrement (s), pour éviter les doublons. */
  segment: { start: number; end: number } | null
  render:{ state: RenderState; progress: number; error: string | null; at: number | null }
}

export interface ChannelConfig {
  login: string
  displayName: string | null
  avatar: string | null
  paused: boolean
  templateId: string | null
  addedAt: number
}

export interface DetectionSettings {
  chat: boolean
  volume: boolean
  clipWord: boolean
  hotkey: boolean
  /** Le streamer dit « clip » à voix haute (Whisper écoute le live pendant l'enregistrement). */
  voice: boolean
  /** 0.5 = peu de clips, 2 = beaucoup de clips. */
  sensitivity: number
  maxPerHour: number
  minLength: number
  maxLength: number
  /**
   * Nombre de personnes différentes qui doivent écrire « clip » en 30 s.
   * Le streamer, les modos, les VIP et les pseudos de confiance comptent tout de suite.
   */
  chatUsers: number
  /** Pseudos Twitch dont un seul « clip » suffit (en minuscules). */
  trusted: string[]
  /**
   * Mots du tchat qui demandent un clip (« clip » par défaut, avec ses variantes clippe, clips…).
   * « mot : titre » donne aussi le titre du clip.
   */
  chatWords: string[]
  /** Durée fixe des clips en secondes ; 0 = automatique (entre minLength et maxLength). */
  fixedLength: number
  /** Secondes gardées après le moment signalé (touche Clip, « clip » écrit ou dit). */
  after: number
}

export type WhisperModel = 'base' | 'small' | 'large-v3-turbo'

export interface Settings {
  recordingsDir: string
  readyDir: string
  quality: string
  channels: ChannelConfig[]
  hotkey: { enabled: boolean; accelerator: string; before: number }
  detection: DetectionSettings
  transcription: { enabled: boolean; language: string; model: WhisperModel; gpu: boolean }
  render: { auto: boolean; fps: 30 | 60; encoder: 'auto' | 'libx264' }
  defaultTemplateId: string | null
  deleteRecordingAfterAnalysis: boolean
  openAtLogin: boolean
  onboarded: boolean
}

export type ChannelStatus = 'offline' | 'checking' | 'live' | 'recording' | 'reconnecting' | 'paused' | 'error'

export interface ChannelState {
  login: string
  status: ChannelStatus
  message: string | null
  recordingSince: number | null
  file: string | null
  chat: { connected: boolean; messages: number; requests: number } | null
  marks: number
  /** Clips déjà créés pendant ce live. */
  liveClips: number
  nextCheckAt: number | null
  /** Dernier « clip » écrit dans le tchat, et ce qu'AutoClip en a fait. */
  lastRequest: ChatRequestInfo | null
  /** Écoute du mot « clip » dit par le streamer (null = désactivée). */
  voice: VoiceState | null
}

export interface ChatRequestInfo {
  user: string
  at: number
  /** Le mot écrit (« clip », « clippez »…) et le titre donné avec « : », s'il y en a un. */
  word: string
  title: string | null
  /** clip = clip lancé ; waiting = il faut d'autres personnes ; already = ce moment a déjà son clip. */
  outcome: 'clip' | 'waiting' | 'already'
  /** Personnes différentes qui l'ont écrit dans les 30 dernières secondes. */
  count: number
  needed: number
}

export interface VoiceState {
  /** L'écoute tourne (Whisper prêt et enregistrement en cours). */
  active: boolean
  /** Dernière fois que « clip » a été entendu (ms). */
  heardAt: number | null
  /** Ce qui a été entendu à ce moment-là. */
  heard: string | null
  error: string | null
}

export interface ChannelSuggestion {
  login: string
  displayName: string
  avatar: string | null
  live: boolean
  viewers: number | null
  followers: number | null
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error' | 'unconfigured'
  version: string | null
  progress: number
  error: string | null
}

export type JobKind = 'analyze' | 'render' | 'transcribe' | 'download' | 'live-clip'

export interface Job {
  id: string
  kind: JobKind
  label: string
  progress: number
  step: string
  clipId: string | null
  file: string | null
  /** Mis de côté : ne démarre pas tant qu'on ne le relance pas. */
  held: boolean
}

export interface QueueState {
  running: Job | null
  pending: Job[]
  /** File en pause : le travail en cours est suspendu et rien d'autre ne démarre. */
  paused: boolean
  /** Travaux rapides qui passent à côté de la file (découpe des clips pendant le live). */
  side: Job[]
}

export interface DepsStatus {
  streamlink: boolean
  ffmpeg: boolean
  whisper: boolean
  model: boolean
  vad: boolean
  ass: boolean | null
  encoder: string | null
  download: { name: string; done: number; total: number } | null
  error: string | null
}

export interface RecordingInfo {
  file: string
  channel: string
  size: number
  modifiedAt: number
  analyzed: boolean
  clips: number
  recording: boolean
}

export interface AppState {
  channels: ChannelState[]
  queue: QueueState
  deps: DepsStatus
  notice: string | null
  version: string
  update: UpdateState
}
