// Lancement de programmes externes (ffmpeg, streamlink, whisper).
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/**
 * Les programmes lancés par un même travail de la file (rendu, transcription, analyse) :
 * on peut les suspendre (pause), les relancer ou les arrêter ensemble.
 */
export class ProcGroup {
  readonly pids = new Set<number>()
  private suspendedAt: number | null = null
  private pausedTotal = 0
  private waiters: (() => void)[] = []

  get suspended(): boolean {
    return this.suspendedAt !== null
  }

  /** Temps passé en pause (ms) : il ne compte pas dans les délais d'expiration. */
  pausedMs(): number {
    return this.pausedTotal + (this.suspendedAt !== null ? Date.now() - this.suspendedAt : 0)
  }

  async suspend(): Promise<void> {
    if (this.suspendedAt !== null) return
    this.suspendedAt = Date.now()
    await setSuspended([...this.pids], true)
  }

  async resume(): Promise<void> {
    if (this.suspendedAt === null) return
    this.pausedTotal += Date.now() - this.suspendedAt
    this.suspendedAt = null
    await setSuspended([...this.pids], false)
    for (const w of this.waiters.splice(0)) w()
  }

  /** Travail annulé pendant une pause : plus rien n'attend (les programmes sont arrêtés à part). */
  release(): void {
    this.suspendedAt = null
    for (const w of this.waiters.splice(0)) w()
  }

  /** Attend la fin de la pause avant de lancer un nouveau programme. */
  waitResume(): Promise<void> {
    return this.suspendedAt === null ? Promise.resolve() : new Promise((r) => this.waiters.push(r))
  }
}

/** Groupe du travail en cours, transmis automatiquement à tout ce qu'il lance. */
export const procContext = new AsyncLocalStorage<ProcGroup>()

/** Rattache un programme lancé à la main (spawn) au travail en cours. */
export function trackChild(child: ChildProcess): void {
  const group = procContext.getStore()
  const pid = child.pid
  if (!group || !pid) return
  group.pids.add(pid)
  if (group.suspended) void setSuspended([pid], true)
  child.once('close', () => group.pids.delete(pid))
}

/**
 * Suspend ou relance des processus. Windows n'a pas de commande pour ça : on appelle
 * NtSuspendProcess / NtResumeProcess de ntdll.dll depuis PowerShell.
 */
export function setSuspended(pids: number[], on: boolean): Promise<void> {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0)
  if (list.length === 0) return Promise.resolve()
  if (process.platform !== 'win32') {
    for (const pid of list) {
      try {
        process.kill(pid, on ? 'SIGSTOP' : 'SIGCONT')
      } catch {
        /* déjà arrêté */
      }
    }
    return Promise.resolve()
  }
  const fn = on ? 'NtSuspendProcess' : 'NtResumeProcess'
  const script = [
    `$t = Add-Type -MemberDefinition '[DllImport("ntdll.dll")] public static extern int ${fn}(IntPtr h);' -Name 'P${fn}' -Namespace AutoClip -PassThru`,
    `foreach ($id in @(${list.join(',')})) { try { $p = [Diagnostics.Process]::GetProcessById($id); [void]$t::${fn}($p.Handle) } catch {} }`
  ].join('\n')
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' })
    } catch {
      return resolve()
    }
    const timer = setTimeout(() => killTree(child.pid), 30_000)
    child.on('error', () => undefined)
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
}

export interface RunOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Texte envoyé sur l'entrée standard. */
  input?: string
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Garder au plus N caractères de sortie (évite de saturer la mémoire). */
  keep?: number
  env?: NodeJS.ProcessEnv
}

const running = new Set<ReturnType<typeof spawn>>()

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  // Travail en pause : le programme suivant attend la reprise avant de démarrer.
  const group = procContext.getStore()
  if (group) await group.waitResume()
  if (opts.signal?.aborted) return { code: null, stdout: '', stderr: '', aborted: true }
  return spawnAndWait(cmd, args, opts, group)
}

function spawnAndWait(cmd: string, args: string[], opts: RunOptions, group: ProcGroup | undefined): Promise<RunResult> {
  return new Promise((resolve) => {
    const keep = opts.keep ?? 200_000
    let stdout = ''
    let stderr = ''
    let aborted = false
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, windowsHide: true, env: opts.env ?? process.env }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, spawnOpts)
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), aborted: false })
      return
    }
    running.add(child)
    trackChild(child)
    const kill = (): void => {
      aborted = true
      killTree(child.pid)
    }
    // Délai d'expiration sans compter le temps passé en pause.
    let timer: NodeJS.Timeout | null = null
    if (opts.timeoutMs) {
      const limit = opts.timeoutMs
      const startedAt = Date.now()
      const paused0 = group?.pausedMs() ?? 0
      const check = (): void => {
        const elapsed = Date.now() - startedAt - ((group?.pausedMs() ?? 0) - paused0)
        if (elapsed >= limit) kill()
        else timer = setTimeout(check, Math.max(1000, limit - elapsed))
      }
      timer = setTimeout(check, limit)
    }
    if (opts.signal) {
      if (opts.signal.aborted) kill()
      else opts.signal.addEventListener('abort', kill, { once: true })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      stdout = (stdout + d).slice(-keep)
      opts.onStdout?.(d)
    })
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-keep)
      opts.onStderr?.(d)
    })
    child.on('error', (err) => {
      stderr += `\n${String(err)}`
    })
    child.on('close', (code) => {
      running.delete(child)
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', kill)
      resolve({ code, stdout, stderr, aborted })
    })
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    } else {
      child.stdin?.end()
    }
  })
}

/** Arrête un processus et ses enfants (Windows : taskkill /T). */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* déjà arrêté */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* déjà arrêté */
    }
  }
}

export function killAll(): void {
  for (const child of running) killTree(child.pid)
}
