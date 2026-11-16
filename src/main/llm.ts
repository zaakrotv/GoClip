// IA gratuite, sur le PC : llama.cpp (son programme llama-server) et un petit modèle de langage ouvert.
// - Rien à payer, pas de clé, pas de compte : tout se télécharge une fois depuis les sources
//   officielles (≈ 2 Go), puis l'IA marche sans internet et rien ne quitte le PC.
// - Sur la carte graphique quand il y en a une vraie (Vulkan : NVIDIA, AMD, Intel Arc), sinon
//   sur le processeur (plus lent, mais ça marche partout).
// - Le programme démarre à la première demande et s'arrête après quelques minutes sans demande,
//   pour rendre la mémoire.
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import type { LocalAiInfo } from '../shared/publishing'
import { download, extractZip, findFile, setDownloadProgress } from './deps'
import { depsDir, modelsDir } from './paths'
import { killTree, run } from './proc'

/**
 * Le modèle de l'IA gratuite (fichier figé sur une version précise, pour que tout le monde ait le même).
 * Qwen 3.5 4B : comparé à Ministral 3 3B et Gemma 4 E2B sur les vraies demandes d'AutoClip, c'est
 * celui qui analyse le mieux les horaires et les jeux du streamer (Gemma est 2 fois plus rapide sur
 * processeur mais reste vague, Ministral mélange l'anglais et invente).
 */
export const LOCAL_MODEL = {
  file: 'Qwen3.5-4B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
  bytes: 2_740_937_888,
  label: 'Qwen 3.5 (4B)',
  size: '2,7 Go'
}

/**
 * Le moteur, figé lui aussi sur une version essayée ici : Smart App Control (Windows 11) bloque les
 * fichiers non signés qu'il ne connaît pas encore, le temps de les analyser ; avec une version figée,
 * tout le monde a les mêmes fichiers, déjà vus. Version Vulkan : toutes les cartes graphiques, et
 * elle contient aussi le calcul sur processeur.
 */
const ENGINE = {
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12322/llama-b12322-bin-win-vulkan-x64.zip',
  zip: 'llama-b12322-bin-win-vulkan-x64.zip',
  version: 'b12322'
}

/**
 * Les « couches » Vulkan que d'autres logiciels greffent sur tous les programmes (incrustations
 * d'Overwolf, de Steam, d'OBS…) peuvent bloquer le moteur au démarrage : on les désactive pour lui seul.
 */
const ENGINE_ENV = { ...process.env, VK_LOADER_LAYERS_DISABLE: '~implicit~' }
/** Code de sortie Windows quand un fichier est refusé par le contrôle des applications (STATUS_INVALID_IMAGE_HASH). */
const BLOCKED_CODES = new Set([3221226536, -1073740760])
const BLOCKED_MESSAGE =
  'Windows (protection « Smart App Control ») a bloqué le moteur de l’IA gratuite, le temps de le vérifier. Réessaie dans quelques minutes ; en attendant, « Remplir tout seul » et « Recalculer sans IA » marchent.'

/** Contexte (en jetons) : assez pour la transcription d'un clip et une longue réponse. */
const CONTEXT = 4096
/** Mémoire de carte graphique nécessaire en plus du modèle (contexte, calculs), en Mio. */
const GPU_MARGIN_MIB = 1200
/** Arrêt du programme après ce temps sans demande. */
const IDLE_MS = 4 * 60_000
const START_TIMEOUT_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 5 * 60_000

const llamaRoot = (): string => join(depsDir(), 'llama')
const modelPath = (): string => join(modelsDir(), LOCAL_MODEL.file)
const versionFile = (): string => join(llamaRoot(), ENGINE.version)
/** Le moteur complet (carte graphique + processeur). */
const gpuExe = (): string => join(llamaRoot(), 'llama-server.exe')
/** Le même moteur sans la partie Vulkan : processeur seul, rien ne touche aux pilotes graphiques. */
const cpuExe = (): string => join(llamaRoot(), 'cpu', 'llama-server.exe')

export function localAiInstalled(): boolean {
  return existsSync(versionFile()) && existsSync(gpuExe()) && existsSync(cpuExe()) && existsSync(modelPath())
}

/** Dossier « processeur seul » : les mêmes fichiers (liens, sans copie), sauf ggml-vulkan.dll. */
function makeCpuFolder(): void {
  const dir = join(llamaRoot(), 'cpu')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(llamaRoot())) {
    const src = join(llamaRoot(), name)
    if (name.toLowerCase() === 'ggml-vulkan.dll' || !statSync(src).isFile()) continue
    try {
      linkSync(src, join(dir, name))
    } catch {
      copyFileSync(src, join(dir, name))
    }
  }
}

// ---------- Carte graphique ----------

export interface GpuDevice {
  /** Nom pour llama.cpp (« Vulkan0 »). */
  name: string
  description: string
  totalMiB: number
  freeMiB: number
  /** Puce graphique intégrée au processeur (mémoire partagée avec le PC). */
  integrated: boolean
}

/** Lit ce qu'affiche `llama-server --list-devices` (les deux sorties, l'ordre varie selon les versions). */
export function parseDevices(output: string): GpuDevice[] {
  const uma = new Map<number, boolean>()
  for (const m of output.matchAll(/ggml_vulkan:\s*(\d+)\s*=[^\n]*?\|\s*uma:\s*(\d)/g)) uma.set(Number(m[1]), m[2] === '1')
  const out: GpuDevice[] = []
  for (const m of output.matchAll(/^\s*(Vulkan(\d+)):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/gm)) {
    const description = m[3]
    // Sans l'information « uma » (pas affichée par toutes les versions), on reconnaît les puces
    // intégrées les plus courantes à leur nom : Intel UHD / Iris / HD / Arc sans numéro, AMD Radeon
    // « Graphics » (sans RX) et les Radeon 680M, 780M, 890M…
    const guess = /^Intel\(R\) (UHD|Iris|HD Graphics)|^Intel\(R\) Arc\(TM\) Graphics$|^AMD Radeon(\(TM\))? (Vega \d+ |\d{3}M )?Graphics$|Radeon(\(TM\))? \d{3}M\b/i.test(description)
    out.push({ name: m[1], description, totalMiB: Number(m[4]), freeMiB: Number(m[5]), integrated: uma.get(Number(m[2])) ?? guess })
  }
  return out
}

/**
 * La carte graphique à utiliser : une vraie carte (pas la puce intégrée au processeur, souvent pas
 * plus rapide et parfois capricieuse) avec assez de mémoire libre ; sinon null = le processeur.
 */
export function pickDevice(devices: GpuDevice[], needMiB: number): GpuDevice | null {
  return devices.filter((d) => !d.integrated && d.freeMiB >= needMiB).sort((a, b) => b.freeMiB - a.freeMiB)[0] ?? null
}

// ---------- Réponses ----------

/** Lit le JSON renvoyé par l'IA, même entouré de texte ou de ```json … ```. */
export function parseJsonLoose(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(t)
  } catch {
    /* on cherche l'objet dans le texte */
  }
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1))
    } catch {
      /* illisible */
    }
  }
  throw new Error('L’IA a donné une réponse illisible : réessaie.')
}

// ---------- Installation ----------

let installing: Promise<void> | null = null
let lastError: string | null = null

/** Télécharge le moteur et le modèle s'ils manquent (une seule fois). La progression s'affiche dans le bandeau. */
export function installLocalAi(): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    lastError = null
    try {
      if (!existsSync(versionFile()) || !existsSync(gpuExe()) || !existsSync(cpuExe())) {
        stopLocalAi()
        const zip = join(depsDir(), ENGINE.zip)
        await download(ENGINE.url, zip, 'IA gratuite : moteur')
        rmSync(llamaRoot(), { recursive: true, force: true })
        setDownloadProgress({ name: 'IA gratuite : décompression', done: 0, total: 0 })
        await extractZip(zip, llamaRoot())
        rmSync(zip, { force: true })
        // Rangé dans un sous-dossier dans certaines versions : on le remonte.
        const found = findFile(llamaRoot(), 'llama-server.exe', 2)
        if (!found) throw new Error('Le moteur de l’IA est introuvable après le téléchargement.')
        if (dirname(found) !== llamaRoot()) {
          for (const name of readdirSync(dirname(found))) copyFileSync(join(dirname(found), name), join(llamaRoot(), name))
        }
        makeCpuFolder()
        writeFileSync(versionFile(), ENGINE.url)
      }
      if (!existsSync(modelPath())) {
        await download(LOCAL_MODEL.url, modelPath(), `IA gratuite : modèle (${LOCAL_MODEL.size}, une seule fois)`)
        if (statSync(modelPath()).size !== LOCAL_MODEL.bytes) {
          rmSync(modelPath(), { force: true })
          throw new Error('Le modèle de l’IA est arrivé abîmé : réessaie.')
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      setDownloadProgress(null)
      installing = null
    }
  })()
  return installing
}

/** Supprime l'IA gratuite du PC (libère la place ; elle se retélécharge au prochain clic ✨). */
export function removeLocalAi(): void {
  stopLocalAi()
  rmSync(llamaRoot(), { recursive: true, force: true })
  rmSync(modelPath(), { force: true })
  rmSync(`${modelPath()}.part`, { force: true })
  lastError = null
}

// ---------- Programme llama-server ----------

interface Server {
  child: ChildProcess
  port: number
  gpu: GpuDevice | null
}

let server: Server | null = null
let starting: Promise<Server> | null = null
/** La carte graphique a posé problème pendant cette session : on reste sur le processeur. */
let gpuBroken = false
let idleTimer: NodeJS.Timeout | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

const lastLines = (log: string): string =>
  log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
    .slice(0, 300)

/** Le moteur refusé par Windows (programme ou fichier bloqué par le contrôle des applications) ? */
const blockedByWindows = (code: number | null, err: (Error & { code?: string }) | null): boolean =>
  (code !== null && BLOCKED_CODES.has(code)) || (!!err && ['EACCES', 'EPERM', 'UNKNOWN'].includes(err.code ?? ''))

/** Sur processeur : pas tous les cœurs, pour laisser de la place au live et au jeu. */
const cpuThreads = (): number => Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

async function launch(gpu: GpuDevice | null): Promise<Server> {
  const exe = gpu ? gpuExe() : cpuExe()
  const port = await freePort()
  const args = ['-m', modelPath(), '--host', '127.0.0.1', '--port', String(port), '-c', String(CONTEXT), '-np', '1', ...(gpu ? ['--device', gpu.name, '-ngl', '99'] : ['-ngl', '0', '-t', String(cpuThreads())])]
  const child = spawn(exe, args, { cwd: dirname(exe), env: ENGINE_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const keep = (d: Buffer): void => {
    log = (log + d.toString('utf8')).slice(-6000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  let spawnError: (Error & { code?: string }) | null = null
  child.on('error', (err) => {
    spawnError = err
    log += `\n${String(err)}`
  })
  const srv: Server = { child, port, gpu }
  child.once('exit', () => {
    if (server === srv) server = null
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || spawnError) {
      if (blockedByWindows(child.exitCode, spawnError)) throw new Error(BLOCKED_MESSAGE)
      throw new Error(`L’IA n’a pas pu démarrer${lastLines(log) ? ` : ${lastLines(log)}` : '.'}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return srv
    } catch {
      /* pas encore prête */
    }
    await sleep(400)
  }
  killTree(child.pid)
  throw new Error('L’IA met trop de temps à démarrer.')
}

let cleaned = false

/**
 * Moteurs restés ouverts après un arrêt brutal d'AutoClip (plantage, Gestionnaire des tâches) : ils
 * garderaient 2 à 3 Go de mémoire. On arrête ceux de notre dossier (pas les autres llama-server du PC).
 */
async function killStaleServers(): Promise<void> {
  if (cleaned || process.platform !== 'win32') return
  cleaned = true
  const root = llamaRoot().toLowerCase()
  const script = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20_000 })
  for (const line of r.stdout.split(/\r?\n/)) {
    const [pid, path] = line.trim().split('|')
    if (pid && path && path.toLowerCase().startsWith(root) && Number(pid) !== server?.child.pid) killTree(Number(pid))
  }
}

async function startServer(): Promise<Server> {
  if (!localAiInstalled()) throw new Error('L’IA gratuite n’est pas encore téléchargée.')
  await killStaleServers().catch(() => undefined)
  let gpu: GpuDevice | null = null
  if (!gpuBroken) {
    const r = await run(gpuExe(), ['--list-devices'], { cwd: llamaRoot(), timeoutMs: 30_000, env: ENGINE_ENV })
    if (r.aborted || r.code !== 0) {
      // Pilote graphique qui bloque ou refusé : on n'y retouche plus pendant cette session.
      console.error('[ia] liste des cartes graphiques impossible :', r.code, lastLines(r.stderr))
      gpuBroken = true
    } else {
      gpu = pickDevice(parseDevices(`${r.stdout}\n${r.stderr}`), Math.ceil(LOCAL_MODEL.bytes / 1024 ** 2) + GPU_MARGIN_MIB)
    }
  }
  if (gpu) {
    try {
      return await launch(gpu)
    } catch (err) {
      console.error('[ia] carte graphique refusée, passage au processeur :', err)
      gpuBroken = true
    }
  }
  return launch(null)
}

async function ensureServer(): Promise<Server> {
  if (server && server.child.exitCode === null) return server
  starting ??= startServer().finally(() => {
    starting = null
  })
  server = await starting
  return server
}

export function stopLocalAi(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (server) killTree(server.child.pid)
  server = null
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(stopLocalAi, IDLE_MS)
}

// ---------- Demandes ----------

/** Une demande à la fois (le programme n'a qu'une place). */
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => undefined)
  return p
}

export interface LocalAsk {
  system: string
  prompt: string
  /** Forme de la réponse (JSON Schema) : l'IA ne peut pas en sortir. */
  schema: Record<string, unknown>
  maxTokens: number
  temperature: number
}

async function post(srv: Server, q: LocalAsk): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [
        { role: 'system', content: q.system },
        { role: 'user', content: q.prompt }
      ],
      max_tokens: q.maxTokens,
      temperature: q.temperature,
      // Qwen 3.5 sait « réfléchir » longuement avant de répondre : inutile pour ces demandes courtes.
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'reponse', strict: true, schema: q.schema } }
    })
  })
  if (!res.ok) throw new Error(`L’IA a répondu par une erreur (${res.status}) : ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
  const choice = json.choices?.[0]
  if (choice?.finish_reason === 'length') throw new Error('La réponse de l’IA était trop longue : réessaie.')
  return parseJsonLoose(choice?.message?.content ?? '')
}

/**
 * Pose une question à l'IA gratuite et renvoie sa réponse (objet JSON). Télécharge l'IA d'abord
 * si besoin. Si la carte graphique lâche en cours de route, on recommence sur le processeur.
 */
export function askLocalAi(q: LocalAsk): Promise<unknown> {
  return exclusive(async () => {
    if (!localAiInstalled()) await installLocalAi()
    if (idleTimer) clearTimeout(idleTimer)
    try {
      const srv = await ensureServer()
      try {
        return await post(srv, q)
      } catch (err) {
        // Programme planté pendant la demande (pilote graphique…) : nouvel essai sur le processeur.
        if (!srv.gpu) throw err
        await sleep(500)
        if (srv.child.exitCode === null) throw err
        console.error('[ia] arrêt pendant la demande, nouvel essai sur le processeur :', err)
        gpuBroken = true
        server = null
        return await post(await ensureServer(), q)
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      armIdle()
    }
  })
}

export function localAiInfo(): LocalAiInfo {
  return {
    installed: localAiInstalled(),
    installing: installing !== null,
    device: server ? (server.gpu?.description ?? 'processeur') : null,
    error: lastError,
    label: LOCAL_MODEL.label,
    size: LOCAL_MODEL.size
  }
}
