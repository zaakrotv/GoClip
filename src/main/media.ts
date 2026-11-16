// Protocole « media:// » : permet à l'interface de lire les vidéos, images, sons
// et polices locales (avec prise en charge du déplacement dans la vidéo).
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { fontsDir } from './paths'

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf'
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } }])
}

export function mediaUrl(file: string): string {
  return `media://fichier/${encodeURIComponent(file)}`
}

export function handleMedia(): void {
  protocol.handle('media', (req) => {
    const url = new URL(req.url)
    const name = decodeURIComponent(url.pathname.slice(1))
    const file = url.host === 'police' ? join(fontsDir(), name.replace(/[\\/]/g, '')) : name
    const type = TYPES[extname(file).toLowerCase()]
    if (!type || !existsSync(file)) return new Response(null, { status: 404 })
    const size = statSync(file).size
    // Les polices sont chargées en mode CORS : sans cet en-tête, le navigateur les refuse.
    const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
      return new Response(body, { status: 206, headers: { ...common, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
    }
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream
    return new Response(body, { status: 200, headers: { ...common, 'Content-Length': String(size) } })
  })
}
