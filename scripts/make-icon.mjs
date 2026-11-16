// Dessine l'icône de GoClip (PNG 512x512) sans aucune dépendance.
// Usage : node scripts/make-icon.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const S = 512
const px = Buffer.alloc(S * S * 4)

const mix = (a, b, t) => a + (b - a) * t
function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return
  const i = (y * S + x) * 4
  const da = px[i + 3] / 255
  const oa = a + da * (1 - a)
  px[i] = Math.round((r * a + px[i] * da * (1 - a)) / oa)
  px[i + 1] = Math.round((g * a + px[i + 1] * da * (1 - a)) / oa)
  px[i + 2] = Math.round((b * a + px[i + 2] * da * (1 - a)) / oa)
  px[i + 3] = Math.round(oa * 255)
}

// Coverage anti-aliasée d'une forme définie par une distance signée (soft > 1 : bord flou, pour l'ombre).
function shape(sdf, color, soft = 1) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = sdf(x + 0.5, y + 0.5)
      const cov = Math.min(1, Math.max(0, 0.5 - d / soft))
      if (cov > 0) {
        const [r, g, b, a] = typeof color === 'function' ? color(x, y) : color
        blend(x, y, r, g, b, a * cov)
      }
    }
  }
}

const roundRect = (x0, y0, x1, y1, rad) => (x, y) => {
  const cx = Math.max(x0 + rad, Math.min(x1 - rad, x))
  const cy = Math.max(y0 + rad, Math.min(y1 - rad, y))
  return Math.hypot(x - cx, y - cy) - rad
}
function triangle(ax, ay, bx, by, cx, cy) {
  const edges = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay]
  ]
  return (x, y) => {
    // Dedans = du même côté des trois bords, quel que soit le sens des sommets.
    let pos = 0
    let neg = 0
    let best = Infinity
    for (const [x0, y0, x1, y1] of edges) {
      const ex = x1 - x0
      const ey = y1 - y0
      const len = Math.hypot(ex, ey)
      const side = (ex * (y - y0) - ey * (x - x0)) / len
      if (side > 0) pos++
      else if (side < 0) neg++
      const t = Math.max(0, Math.min(1, ((x - x0) * ex + (y - y0) * ey) / (len * len)))
      best = Math.min(best, Math.hypot(x - (x0 + t * ex), y - (y0 + t * ey)))
    }
    return pos === 0 || neg === 0 ? -best : best
  }
}

// Fond : carré arrondi dégradé orange → rose.
shape(roundRect(16, 16, 496, 496, 112), (x, y) => {
  const t = (x + y) / (2 * S)
  return [mix(255, 236, t), mix(159, 22, t), mix(28, 110, t), 1]
})
// Le « Go » : bouton lecture aux coins arrondis, lancé à toute vitesse (trois traits derrière).
const play = triangle(258, 180, 258, 332, 390, 256)
const lines = [roundRect(130, 190, 208, 222, 16), roundRect(94, 240, 208, 272, 16), roundRect(130, 290, 208, 322, 16)]
const mark = (x, y) => Math.min(play(x, y) - 30, ...lines.map((l) => l(x, y)))
// Ombre douce sous le dessin, puis le dessin en blanc.
shape((x, y) => mark(x, y - 10), [90, 0, 40, 0.28], 22)
shape(mark, [255, 255, 255, 1])

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png)
console.log('resources/icon.png', png.length, 'octets')
