// Télécharge les polices libres (OFL / Apache) utilisées pour les sous-titres
// depuis le dépôt officiel google/fonts, avec leurs licences.
// Usage : npm run fonts
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'fonts')
const BASE = 'https://raw.githubusercontent.com/google/fonts/main'

const FONTS = [
  ['ofl/poppins', 'Poppins-ExtraBold.ttf', 'OFL.txt'],
  ['ofl/anton', 'Anton-Regular.ttf', 'OFL.txt'],
  ['ofl/bebasneue', 'BebasNeue-Regular.ttf', 'OFL.txt'],
  ['apache/luckiestguy', 'LuckiestGuy-Regular.ttf', 'LICENSE.txt'],
  ['ofl/bangers', 'Bangers-Regular.ttf', 'OFL.txt'],
  ['ofl/russoone', 'RussoOne-Regular.ttf', 'OFL.txt'],
  ['apache/permanentmarker', 'PermanentMarker-Regular.ttf', 'LICENSE.txt'],
  ['ofl/titanone', 'TitanOne-Regular.ttf', 'OFL.txt'],
  ['ofl/lilitaone', 'LilitaOne-Regular.ttf', 'OFL.txt'],
  ['ofl/archivoblack', 'ArchivoBlack-Regular.ttf', 'OFL.txt'],
  ['ofl/kanit', 'Kanit-ExtraBold.ttf', 'OFL.txt'],
  ['ofl/barlowcondensed', 'BarlowCondensed-ExtraBold.ttf', 'OFL.txt']
]

/** Lit les noms (famille, nom complet) dans la table « name » d'un TTF. */
function fontNames(buf) {
  const numTables = buf.readUInt16BE(4)
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (buf.toString('latin1', rec, rec + 4) !== 'name') continue
    const off = buf.readUInt32BE(rec + 8)
    const count = buf.readUInt16BE(off + 2)
    const strOff = off + buf.readUInt16BE(off + 4)
    const names = {}
    for (let j = 0; j < count; j++) {
      const r = off + 6 + j * 12
      const platform = buf.readUInt16BE(r)
      const nameId = buf.readUInt16BE(r + 6)
      const len = buf.readUInt16BE(r + 8)
      const o = strOff + buf.readUInt16BE(r + 10)
      if (platform === 3 && [1, 2, 4, 16].includes(nameId) && !names[nameId]) {
        const b = Buffer.from(buf.subarray(o, o + len))
        b.swap16()
        names[nameId] = b.toString('utf16le')
      }
    }
    return names
  }
  return {}
}

await mkdir(join(out, 'licences'), { recursive: true })
for (const [dir, file, licence] of FONTS) {
  const target = join(out, file)
  if (!existsSync(target)) {
    const res = await fetch(`${BASE}/${dir}/${file}`)
    if (!res.ok) throw new Error(`${file} : HTTP ${res.status}`)
    await writeFile(target, Buffer.from(await res.arrayBuffer()))
    const lic = await fetch(`${BASE}/${dir}/${licence}`)
    if (lic.ok) await writeFile(join(out, 'licences', `${file.replace(/\.ttf$/, '')}-${licence}`), Buffer.from(await lic.arrayBuffer()))
  }
  const buf = await readFile(target)
  const n = fontNames(buf)
  console.log(`${file.padEnd(34)} famille="${n[1]}" style="${n[2]}" complet="${n[4]}" cell=${cellRatio(buf).toFixed(4)}`)
}

/** Valeur « cell » à mettre dans FONTS (shared/presets.ts) : (usWinAscent + usWinDescent) / unitsPerEm. */
function cellRatio(buf) {
  const offset = (tag) => {
    for (let i = 0; i < buf.readUInt16BE(4); i++) if (buf.toString('latin1', 12 + i * 16, 16 + i * 16) === tag) return buf.readUInt32BE(12 + i * 16 + 8)
    return -1
  }
  const os2 = offset('OS/2')
  return (buf.readUInt16BE(os2 + 74) + buf.readUInt16BE(os2 + 76)) / buf.readUInt16BE(offset('head') + 18)
}
