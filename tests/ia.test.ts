// Tests de l'IA gratuite (version 0.3.1) : carte graphique, réponses, textes, téléchargement repris.
// Lancer : npm test
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download } from '../src/main/deps'
import { parseDevices, parseJsonLoose, pickDevice } from '../src/main/llm'
import { cleanAiText, finishCaption, normalizePrefs } from '../src/shared/publishing'

let passed = 0
const pending: Promise<void>[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  const done = (err?: unknown): void => {
    if (err) {
      console.log(`✗ ${name}\n   ${(err as Error).message}`)
      process.exitCode = 1
    } else {
      passed++
      console.log(`✓ ${name}`)
    }
  }
  try {
    const r = fn()
    if (r instanceof Promise) pending.push(r.then(() => done(), done))
    else done()
  } catch (e) {
    done(e)
  }
}

// ---------- Carte graphique ----------

const TWO_GPUS = [
  'ggml_vulkan: Found 2 Vulkan devices:',
  'ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2',
  'ggml_vulkan: 1 = Intel(R) Arc(TM) Graphics (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none',
  'Available devices:',
  '  Vulkan0: NVIDIA GeForce RTX 4070 Laptop GPU (8188 MiB, 7346 MiB free)',
  '  Vulkan1: Intel(R) Arc(TM) Graphics (8100 MiB, 7900 MiB free)'
].join('\n')

test('carte graphique : la vraie carte plutôt que la puce intégrée', () => {
  const list = parseDevices(TWO_GPUS)
  assert.equal(list.length, 2)
  assert.deepEqual(
    list.map((d) => [d.name, d.integrated, d.freeMiB]),
    [
      ['Vulkan0', false, 7346],
      ['Vulkan1', true, 7900]
    ]
  )
  // La puce Intel a plus de mémoire libre (partagée), mais c'est la NVIDIA qui est choisie.
  assert.equal(pickDevice(list, 3300)?.name, 'Vulkan0')
  // Pas assez de mémoire libre sur la NVIDIA (un jeu tourne) : le processeur.
  assert.equal(pickDevice(list, 7500), null)
})

test('carte graphique : sortie réelle de llama-server b12322 (sans ligne « uma »)', () => {
  // Relevé sur le PC de l'utilisateur (Core Ultra 7 155H + RTX 4070 portable) : l'Intel est la n° 0.
  const real = 'Available devices:\r\n  Vulkan0: Intel(R) Arc(TM) Graphics (8038 MiB, 7380 MiB free)\r\n  Vulkan1: NVIDIA GeForce RTX 4070 Laptop GPU (7948 MiB, 7180 MiB free)\r\n'
  const list = parseDevices(real)
  assert.deepEqual(
    list.map((d) => [d.name, d.integrated]),
    [
      ['Vulkan0', true],
      ['Vulkan1', false]
    ]
  )
  assert.equal(pickDevice(list, 2614 + 1200)?.name, 'Vulkan1')
  // Autres puces intégrées courantes, reconnues à leur nom ; les vraies cartes non.
  const names = ['AMD Radeon(TM) Graphics', 'AMD Radeon(TM) 780M', 'AMD Radeon 890M Graphics', 'AMD Radeon(TM) Vega 8 Graphics', 'Intel(R) Iris(R) Xe Graphics', 'AMD Radeon RX 7800 XT', 'Intel(R) Arc(TM) A770 Graphics', 'NVIDIA GeForce GTX 1660 SUPER']
  const parsed = parseDevices(`Available devices:\n${names.map((n, i) => `  Vulkan${i}: ${n} (8000 MiB, 7000 MiB free)`).join('\n')}\n`)
  assert.deepEqual(
    parsed.map((d) => d.integrated),
    [true, true, true, true, true, false, false, false]
  )
})

test('carte graphique : puce intégrée seule ou rien du tout → processeur', () => {
  const igpu = 'ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1\nAvailable devices:\n  Vulkan0: AMD Radeon(TM) Graphics (4096 MiB, 3900 MiB free)\n'
  assert.equal(pickDevice(parseDevices(igpu), 3300), null)
  assert.deepEqual(parseDevices('Available devices:\n'), [])
  // Sans la ligne « uma » : reconnue à son nom.
  const noUma = 'Available devices:\n  Vulkan0: Intel(R) UHD Graphics 620 (6000 MiB, 5000 MiB free)\n  Vulkan1: AMD Radeon RX 7600 (8176 MiB, 8000 MiB free)\n'
  assert.deepEqual(
    parseDevices(noUma).map((d) => d.integrated),
    [true, false]
  )
  assert.equal(pickDevice(parseDevices(noUma), 3300)?.name, 'Vulkan1')
})

// ---------- Réponses de l'IA ----------

test('réponse de l’IA : JSON lu même entouré de texte', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":[1,2]}\n```'), { a: [1, 2] })
  assert.deepEqual(parseJsonLoose('Voici : {"description":"Salut"} Bonne journée'), { description: 'Salut' })
  assert.throws(() => parseJsonLoose('pas de json'), /illisible/)
})

test('textes de l’IA : nettoyés et coupés en fin de phrase', () => {
  assert.equal(cleanAiText('  Bonjour   toi \n\n\n\nSalut  ', 100), 'Bonjour toi\n\nSalut')
  assert.equal(cleanAiText('Première phrase assez longue. Deuxième phrase qui dépasse la limite.', 40), 'Première phrase assez longue.')
  assert.equal(cleanAiText(null, 10), '')
  assert.ok(cleanAiText('motmotmot '.repeat(30), 50).length <= 51)
})

test('description de l’IA : hashtags rangés, ligne du live ajoutée', () => {
  const r = finishCaption({ description: 'Le clutch de l’année sur Valorant 😱\n#valorant #clutch', hashtags: ['valorant', '#FPS', 'gaming fr'], channel: 'zaakro', defaults: '#twitch #clip' })
  assert.equal(r.caption, 'Le clutch de l’année sur Valorant 😱\n\nEn live sur twitch.tv/zaakro')
  assert.equal(r.hashtags, '#valorant #FPS #gaming #fr #clutch #twitch #clip')
  // Hashtags collés à la fin de la phrase (vu avec Qwen 3.5) : rangés aussi.
  const inline = finishCaption({ description: 'Snipe mortel dans Fortnite ! 😱🔥 Les gars, c’est TOP 1 ! #fortnite #stream #twitch', hashtags: ['fortnite', 'top1'], channel: 'zaakro', defaults: '' })
  assert.equal(inline.caption, 'Snipe mortel dans Fortnite ! 😱🔥 Les gars, c’est TOP 1 !\n\nEn live sur twitch.tv/zaakro')
  assert.equal(inline.hashtags, '#fortnite #top1 #stream #twitch')
  // Lien Twitch déjà présent, vidéo importée : rien d'ajouté.
  assert.equal(finishCaption({ description: 'Viens sur twitch.tv/zaakro ce soir', hashtags: [], channel: 'zaakro', defaults: '' }).caption, 'Viens sur twitch.tv/zaakro ce soir')
  assert.equal(finishCaption({ description: 'Quel moment', hashtags: 'clip', channel: 'imports', defaults: '' }).caption, 'Quel moment')
})

test('réglage de l’IA : gratuite par défaut', () => {
  assert.equal(normalizePrefs({}).aiEngine, 'local')
  assert.equal(normalizePrefs({ aiEngine: 'claude' }).aiEngine, 'claude')
  assert.equal(normalizePrefs({ aiEngine: 'autre' }).aiEngine, 'local')
  // Anciens réglages (0.3.0) : le reste est gardé.
  const old = normalizePrefs({ networks: ['tiktok'], perDay: 3, hashtags: '#a', aiModel: 'claude-sonnet-5-5' })
  assert.deepEqual([old.networks, old.perDay, old.aiModel, old.aiEngine], [['tiktok'], 3, 'claude-sonnet-5-5', 'local'])
})

// ---------- Téléchargement repris ----------

test('téléchargement coupé : il reprend où il s’était arrêté', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoclip-dl-'))
  const body = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251))
  const ranges: (string | undefined)[] = []
  let honorRange = true
  const server = createServer((req, res) => {
    ranges.push(req.headers.range)
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (m && honorRange) {
      const from = Number(m[1])
      if (from >= body.length) {
        res.writeHead(416)
        return res.end()
      }
      res.writeHead(206, { 'Content-Length': String(body.length - from), 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` })
      return res.end(body.subarray(from))
    }
    res.writeHead(200, { 'Content-Length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/modele.gguf`
  try {
    // 1. Une moitié déjà là : on demande la suite et on l'ajoute.
    const dest = join(dir, 'a.gguf')
    writeFileSync(`${dest}.part`, body.subarray(0, 120_000))
    await download(url, dest, 'essai')
    assert.equal(ranges.at(-1), 'bytes=120000-')
    assert.ok(readFileSync(dest).equals(body))
    assert.equal(existsSync(`${dest}.part`), false)
    // 2. Le serveur ignore la reprise : le fichier est réécrit en entier, pas collé au bout.
    honorRange = false
    const dest2 = join(dir, 'b.gguf')
    writeFileSync(`${dest2}.part`, body.subarray(0, 50_000))
    await download(url, dest2, 'essai')
    assert.ok(readFileSync(dest2).equals(body))
    // 3. Morceau déjà complet (416) : on repart de zéro.
    honorRange = true
    const dest3 = join(dir, 'c.gguf')
    writeFileSync(`${dest3}.part`, body)
    await download(url, dest3, 'essai')
    assert.deepEqual(ranges.slice(-2), [`bytes=${body.length}-`, undefined])
    assert.ok(readFileSync(dest3).equals(body))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

void Promise.all(pending).then(() => {
  console.log(`\n${passed} test(s) réussi(s)${process.exitCode ? ', des échecs ci-dessus' : ''}.`)
})
