// Tests de la logique pure (aucun programme externe, aucun téléchargement).
// Lancer : npm test
import assert from 'node:assert/strict'
import { sameMoment } from '../src/main/analyze'
import { chatWeight, clipWord, detectMoments, isTrusted, markedWindow, parseChatLog } from '../src/main/detect'
import { parseProbe } from '../src/main/ffmpeg'
import { assColor, assTime, buildAss } from '../src/main/subtitles'
import { wordsFromSegments } from '../src/main/transcribe'
import { parseChannel } from '../src/main/twitch'
import { findClipWord, heardClip, tsSync } from '../src/main/voice'
import { cleanChatTitle, normalizeChatWords, parseClipCommand, pickChatTitle } from '../src/shared/chatcommand'
import { computeRegions, coverCrop, defaultLook, editSignature, groupWords, LAYOUTS } from '../src/shared/presets'
import type { DetectionSettings } from '../src/shared/types'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}\n   ${(e as Error).message}`)
    process.exitCode = 1
  }
}

test('parseChannel accepte liens et pseudos', () => {
  assert.equal(parseChannel('https://www.twitch.tv/Gotaga'), 'gotaga')
  assert.equal(parseChannel('twitch.tv/zerator/'), 'zerator')
  assert.equal(parseChannel('  kameto '), 'kameto')
  assert.equal(parseChannel('https://www.twitch.tv/squeezie?sr=a'), 'squeezie')
  assert.equal(parseChannel('ab'), null)
  assert.equal(parseChannel('https://www.twitch.tv/videos'), null)
})

test('mots du tchat', () => {
  assert.equal(clipWord('CLIP ça'), 'CLIP')
  assert.equal(clipWord('clippez ça svp'), 'clippez')
  assert.equal(clipWord('cliiip'), null)
  assert.equal(clipWord('il faut clipper'), 'clipper')
  assert.equal(clipWord('eclipse totale'), null)
  assert.ok(chatWeight('MDRRR') > chatWeight('salut'))
})

test('journal du tchat aligné sur la vidéo', () => {
  const t0 = 1_000_000
  const log = [
    JSON.stringify({ type: 'msg', at: t0 - 5000, user: 'a', text: 'avant la vidéo' }),
    JSON.stringify({ type: 'video', at: t0 }),
    JSON.stringify({ type: 'msg', at: t0 + 2500, user: 'a', text: 'salut' }),
    JSON.stringify({ type: 'msg', at: t0 + 2900, user: 'b', text: 'clip !!', mod: true }),
    'ligne abîmée {'
  ].join('\n')
  const r = parseChatLog(log)!
  assert.equal(r.weights[2], 3)
  assert.equal(r.requests.length, 1)
  assert.equal(r.requests[0].mod, true)
})

const settings: DetectionSettings = {
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
  chatWords: ['clip'],
  fixedLength: 0,
  after: 5
}
function synth(n: number): { loudness: number[]; chat: number[] } {
  return {
    loudness: Array.from({ length: n }, (_, i) => -38 + Math.sin(i / 7) * 3 + ((i * 7919) % 5) * 0.4),
    chat: Array.from({ length: n }, (_, i) => ((i * 31) % 4 === 0 ? 1 : 0))
  }
}

test('un cri est détecté', () => {
  const { loudness, chat } = synth(1800)
  for (let i = 600; i < 606; i++) loudness[i] = -8
  const r = detectMoments({ duration: 1800, loudness, chat, requests: [], marks: [] }, settings)
  const hit = r.find((c) => c.peak >= 598 && c.peak <= 608)
  assert.ok(hit && hit.reasons.includes('volume') && hit.start < 600 && hit.end > 605, JSON.stringify(r))
})

test('un tchat qui s’emballe est détecté', () => {
  const { loudness, chat } = synth(1800)
  for (let i = 1200; i < 1215; i++) chat[i] = 12
  const r = detectMoments({ duration: 1800, loudness, chat, requests: [], marks: [] }, settings)
  assert.ok(r.some((c) => c.peak >= 1195 && c.peak <= 1220 && c.reasons.includes('chat')), JSON.stringify(r))
})

test('rien de spécial = pas de clip', () => {
  const { loudness, chat } = synth(1800)
  assert.equal(detectMoments({ duration: 1800, loudness, chat, requests: [], marks: [] }, settings).length, 0)
})

test('« clip » écrit par 2 personnes et touche Clip', () => {
  const { loudness, chat } = synth(1800)
  const r = detectMoments(
    {
      duration: 1800,
      loudness,
      chat,
      requests: [
        { at: 300, user: 'a', word: 'clip', mod: false },
        { at: 310, user: 'b', word: 'CLIP', mod: false },
        { at: 900, user: 'seul', word: 'clip', mod: false }
      ],
      marks: [{ at: 1500, before: 30 }]
    },
    settings
  )
  assert.ok(r.some((c) => c.reasons.includes('clip-word') && c.start <= 270 && c.end >= 300))
  assert.ok(!r.some((c) => c.start > 850 && c.end < 950))
  const key = r.find((c) => c.reasons.includes('hotkey'))
  assert.ok(key && key.start === 1470 && key.end === 1505 && key.level === 'sure')
})

test('« clip » écrit par une seule personne : réglage et pseudos de confiance', () => {
  const { loudness, chat } = synth(1800)
  const input = { duration: 1800, loudness, chat, requests: [{ at: 900, user: 'Zaakro', word: 'clip', mod: false }], marks: [] }
  const zone = (r: { start: number; end: number }[]): boolean => r.some((c) => c.start < 900 && c.end >= 900)
  assert.ok(!zone(detectMoments(input, settings)), 'il faut 2 personnes par défaut')
  assert.ok(zone(detectMoments(input, { ...settings, chatUsers: 1 })), 'une personne suffit si on le règle')
  assert.ok(zone(detectMoments(input, { ...settings, trusted: ['zaakro'] })), 'pseudo de confiance (sans tenir compte des majuscules)')
  assert.ok(isTrusted('Modo', true, settings) && isTrusted('ZAAKRO', false, { trusted: ['zaakro'] }) && !isTrusted('autre', false, { trusted: ['zaakro'] }))
})

test('« clip : headshot » donne le titre, « clip » seul marche toujours', () => {
  assert.deepEqual(parseClipCommand('clip'), { word: 'clip', title: null })
  assert.deepEqual(parseClipCommand('clip : headshot'), { word: 'clip', title: 'headshot' })
  assert.deepEqual(parseClipCommand('CLIP: Le HEADSHOT de fou'), { word: 'CLIP', title: 'Le HEADSHOT de fou' })
  assert.deepEqual(parseClipCommand('clippez :   « le 1v4 »  '), { word: 'clippez', title: 'le 1v4' })
  assert.deepEqual(parseClipCommand('mdr clip : ace'), { word: 'clip', title: 'ace' })
  assert.deepEqual(parseClipCommand('clip :'), { word: 'clip', title: null })
  assert.deepEqual(parseClipCommand('clip : https://twitch.tv/x'), { word: 'clip', title: null })
  assert.equal(parseClipCommand('regarde clips.twitch.tv/abc'), null)
  assert.equal(parseClipCommand('eclipse : totale'), null)
  const long = cleanChatTitle(`${'mot '.repeat(40)}fin`) ?? ''
  assert.ok(long.length > 40 && long.length <= 80 && !long.endsWith(' '), long)
  // Le titre retenu : celui d'une personne de confiance, sinon le premier donné.
  assert.equal(pickChatTitle([{ title: null }, { title: 'a' }, { title: 'b', mod: true }]), 'b')
  assert.equal(pickChatTitle([{ title: null }, { title: 'a' }, { title: 'b' }]), 'a')
  assert.equal(pickChatTitle([{ title: null }]), null)
})

test('mot du tchat choisi dans les réglages', () => {
  assert.deepEqual(normalizeChatWords(' Moment, !CLIP ;; moment '), ['moment', '!clip'])
  assert.deepEqual(normalizeChatWords(''), ['clip'])
  assert.deepEqual(normalizeChatWords(['!', '  ']), ['clip'])
  assert.deepEqual(normalizeChatWords(undefined), ['clip'])
  const words = ['!clip', 'moment']
  assert.deepEqual(parseClipCommand('!clip : ace', words), { word: '!clip', title: 'ace' })
  assert.deepEqual(parseClipCommand('quel MOMENT', words), { word: 'MOMENT', title: null })
  assert.equal(parseClipCommand('clip', words), null, '« clip » ne marche plus si on a choisi un autre mot')
  assert.equal(parseClipCommand('momentané', words), null)
  assert.equal(clipWord('clip ça', ['moment']), null)
  // Journal du tchat relu à la fin du live avec les mots choisis, titres compris.
  const t0 = 1_000_000
  const log = [
    JSON.stringify({ type: 'video', at: t0 }),
    JSON.stringify({ type: 'msg', at: t0 + 10_000, user: 'a', text: '!clip : le 1v4' }),
    JSON.stringify({ type: 'msg', at: t0 + 11_000, user: 'b', text: 'clip' })
  ].join('\n')
  const r = parseChatLog(log, words)!
  assert.deepEqual(r.requests.map((q) => [q.at, q.word, q.title]), [[10, '!clip', 'le 1v4']])
})

test('le titre du tchat suit le clip trouvé à la fin du live', () => {
  const { loudness, chat } = synth(1800)
  const requests = [
    { at: 300, user: 'a', word: 'clip', mod: false, title: null },
    { at: 305, user: 'b', word: 'clip', mod: false, title: 'headshot' },
    { at: 306, user: 'c', word: 'clip', mod: false, title: 'autre titre' }
  ]
  const r = detectMoments({ duration: 1800, loudness, chat, requests, marks: [] }, settings)
  const clip = r.find((c) => c.reasons.includes('clip-word'))
  assert.equal(clip?.title, 'headshot', JSON.stringify(r))
  // Un modo l'emporte ; sans titre, rien.
  const withMod = detectMoments({ duration: 1800, loudness, chat, requests: [...requests, { at: 307, user: 'modo', word: 'clip', mod: true, title: 'le vrai titre' }], marks: [] }, settings)
  assert.equal(withMod.find((c) => c.reasons.includes('clip-word'))?.title, 'le vrai titre')
  const none = detectMoments({ duration: 1800, loudness, chat, requests: requests.map((q) => ({ ...q, title: null })), marks: [] }, settings)
  assert.equal(none.find((c) => c.reasons.includes('clip-word'))?.title ?? null, null)
})

test('durée des clips fixe ou automatique', () => {
  assert.deepEqual(markedWindow(100, 30, { fixedLength: 0, after: 5 }), { start: 70, end: 105 })
  assert.deepEqual(markedWindow(100, 30, { fixedLength: 20, after: 5 }), { start: 85, end: 105 })
  assert.deepEqual(markedWindow(10, 30, { fixedLength: 0, after: 3 }), { start: 0, end: 13 })
  const { loudness, chat } = synth(1800)
  for (let i = 600; i < 606; i++) loudness[i] = -8
  for (let i = 1200; i < 1215; i++) chat[i] = 12
  const fixed = { ...settings, fixedLength: 20, chatUsers: 1 }
  const r = detectMoments({ duration: 1800, loudness, chat, requests: [{ at: 300, user: 'a', word: 'clip', mod: false }], marks: [{ at: 1500, before: 30 }] }, fixed)
  assert.ok(r.length >= 4, JSON.stringify(r))
  assert.ok(r.every((c) => c.end - c.start === 20), `tous les clips durent 20 s : ${JSON.stringify(r.map((c) => c.end - c.start))}`)
  const key = r.find((c) => c.reasons.includes('hotkey'))
  assert.ok(key && key.start === 1485 && key.end === 1505, JSON.stringify(key))
  const voice = detectMoments({ duration: 1800, loudness, chat, requests: [], marks: [{ at: 1000, before: 30, voice: true }] }, { ...settings, voice: true })
  assert.ok(voice.some((c) => c.reasons.includes('voice') && c.start === 970 && c.end === 1005), JSON.stringify(voice))
  assert.ok(!detectMoments({ duration: 1800, loudness, chat, requests: [], marks: [{ at: 1000, before: 30, voice: true }] }, settings).some((c) => c.reasons.includes('voice')), 'écoute coupée = ignoré')
})

test('« clip » dit à voix haute (transcription de l’écoute)', () => {
  assert.equal(heardClip('Oh non ! Clip !'), 'Clip')
  assert.equal(heardClip('Clippez ça, c’était énorme'), 'Clippez')
  assert.equal(heardClip('il faut clipper ça'), 'clipper')
  assert.equal(heardClip('J’ai regardé une eclipse hier'), null)
  assert.equal(heardClip('un petit clic sur la souris'), null)
  assert.equal(heardClip('Clique ici'), null)
  // Parler d'un clip n'est pas en demander un.
  assert.equal(heardClip('Le clip de la semaine dernière était drôle'), null)
  assert.equal(heardClip('j’ai fait un clip hier, mais là clip !'), 'clip')
  assert.equal(heardClip('Mais non, clip ça !'), 'clip')
  assert.equal(heardClip('Clip de fou !'), 'Clip')
  // Réponse réelle de whisper-cli (-ojf) : « Clip » coupé en deux morceaux.
  const hit = findClipWord([
    { text: ' Bon, on continue.', offsets: { from: 4000, to: 6000 }, tokens: [{ text: ' Bon', offsets: { from: 4100, to: 4300 } }] },
    {
      text: ' Oh non ! Clip ! Clipper ça !',
      offsets: { from: 6000, to: 10500 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 6000, to: 6000 } },
        { text: ' Oh', offsets: { from: 6110, to: 6230 } },
        { text: ' non', offsets: { from: 6230, to: 6580 } },
        { text: ' !', offsets: { from: 6670, to: 7080 } },
        { text: ' Cl', offsets: { from: 7080, to: 7280 } },
        { text: 'ip', offsets: { from: 7280, to: 7460 } },
        { text: ' !', offsets: { from: 7460, to: 7790 } }
      ]
    }
  ])
  assert.deepEqual(hit, { at: 7.08, text: 'Oh non ! Clip ! Clipper ça !', word: 'Clip' })
  assert.equal(findClipWord([{ text: ' Rien à voir.', offsets: { from: 0, to: 1000 } }]), null)
  // Début de fenêtre tombé au milieu d'« éclipse » : « clip si » au tout début est ignoré.
  const cut = [{ text: ' clip si hier soir', offsets: { from: 37000, to: 39000 }, tokens: [{ text: ' clip', offsets: { from: 37050, to: 37300 } }, { text: ' si', offsets: { from: 37300, to: 37500 } }] }]
  assert.equal(findClipWord(cut, 37.6, 44), null)
  assert.equal(findClipWord(cut, 0, 44)?.word, 'clip')
  // « le clip … », puis une vraie demande dans la même phrase : c'est la demande qui compte.
  const both = findClipWord([
    {
      text: ' le clip était nul, clip !',
      offsets: { from: 0, to: 3000 },
      tokens: [' le', ' clip', ' était', ' nul,', ' clip', ' !'].map((text, i) => ({ text, offsets: { from: i * 500, to: i * 500 + 400 } }))
    }
  ])
  assert.equal(both?.at, 2)
  // Début des paquets MPEG-TS (octet 0x47 tous les 188 octets) dans un morceau pris au hasard.
  const buf = new Uint8Array(188 * 5)
  for (let i = 0; i < 5; i++) buf[57 + i * 188] = 0x47
  assert.equal(tsSync(buf.subarray(0, 188 * 4)), 57)
  assert.equal(tsSync(new Uint8Array(1000)), -1)
})

test('moments proches mais différents = clips séparés', () => {
  // Valeurs mesurées sur une vidéo de test : bruit à 40 s, voix à 70 s, tchat qui s'emballe
  // à 72-81 s avec des « clip », et touche Clip à 100 s.
  const loudness = new Array<number>(121).fill(-47)
  ;[-14, -14, -14, -14, -30].forEach((v, i) => (loudness[40 + i] = v))
  ;[-11, -20, -14, -12, -14, -16, -13, -14, -21].forEach((v, i) => (loudness[70 + i] = v))
  const chat: number[] = Array.from({ length: 121 }, (_, i) => (i % 3 === 0 ? 1 : 0))
  ;[13.5, 12.5, 12.5, 13.5, 10, 10, 11, 10, 10, 11].forEach((v, i) => (chat[72 + i] = v))
  const requests = Array.from({ length: 30 }, (_, i) => ({ at: 76 + Math.floor(i / 5), user: `v${i}`, word: 'CLIP', mod: false }))
  const r = detectMoments({ duration: 121, loudness, chat, requests, marks: [{ at: 100, before: 15 }] }, settings)
  assert.equal(r.length, 3, JSON.stringify(r))
  assert.ok(r.every((c) => c.end - c.start <= 60), 'aucun clip trop long')
  assert.ok(r.some((c) => c.start <= 40 && c.end >= 44 && c.reasons.includes('volume')), 'le bruit à 40 s')
  assert.ok(r.some((c) => c.start <= 72 && c.end >= 81 && c.reasons.includes('clip-word')), 'le tchat à 72-81 s')
  assert.ok(r.some((c) => c.start === 85 && c.end === 105 && c.reasons.includes('hotkey')), 'la touche à 100 s')
  for (let i = 1; i < r.length; i++) assert.ok(r[i].start >= r[i - 1].end, 'pas de chevauchement')
})

test('limite de clips par heure', () => {
  const { loudness, chat } = synth(3600)
  for (let k = 0; k < 20; k++) for (let i = 0; i < 5; i++) loudness[100 + k * 170 + i] = -6
  assert.equal(detectMoments({ duration: 3600, loudness, chat, requests: [], marks: [] }, settings).length, 6)
})

test('couleurs et horodatage ASS', () => {
  assert.equal(assColor('#FFE600'), '&H0000E6FF')
  assert.equal(assColor('#112233', 128), '&H80332211')
  assert.equal(assTime(3725.456), '1:02:05.46')
})

test('groupes de mots', () => {
  const w = (text: string, start: number): { text: string; start: number; end: number } => ({ text, start, end: start + 0.3 })
  const g = groupWords([w('a', 0), w('b', 0.3), w('c.', 0.6), w('d', 0.9), w('e', 2.5)], 3)
  assert.deepEqual(g.map((x) => x.map((y) => y.text)), [['a', 'b', 'c.'], ['d'], ['e']])
})

test('fichier ASS complet', () => {
  const look = defaultLook()
  look.title.enabled = true
  const ass = buildAss({
    look,
    words: [
      { text: 'Il', start: 10.0, end: 10.2 },
      { text: 'a', start: 10.2, end: 10.3 },
      { text: 'pas', start: 10.3, end: 10.6 },
      { text: 'vu', start: 10.6, end: 10.9 },
      { text: 'hors-clip', start: 40, end: 41 }
    ],
    clipStart: 9,
    clipEnd: 30,
    title: 'Le {titre}'
  })!
  // 78 px de « em » × 1,762 (hauteur totale de Poppins) = 137 pour libass.
  assert.ok(ass.includes('PlayResX: 1080') && ass.includes('Style: Sous,Poppins ExtraBold,137,'))
  const sous = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0'))
  assert.equal(sous.length, 4)
  assert.ok(sous[0].startsWith('Dialogue: 0,0:00:01.00,0:00:01.20,Sous'))
  assert.ok(!ass.includes('HORS-CLIP') && ass.includes('Le (titre)'))
})

test('mots reconstitués depuis whisper (accents coupés)', () => {
  const words = wordsFromSegments([
    {
      text: ' Oh non, c’était génial',
      offsets: { from: 1000, to: 3000 },
      tokens: [
        { text: '[_BEG_]', t_dtw: -1 },
        { text: ' Oh', t_dtw: 110 },
        { text: ' non', t_dtw: 140 },
        { text: ',', t_dtw: 160 },
        { text: ' c’', t_dtw: 180 },
        { text: '��tait', t_dtw: 190 },
        { text: ' g�nial', t_dtw: 220 },
        { text: '[_TT_150]', t_dtw: -1 }
      ]
    }
  ])
  assert.deepEqual(words.map((w) => w.text), ['Oh', 'non,', 'c’était', 'génial'])
  assert.equal(words[0].start, 1.1)
})

test('mots recalés dans les zones de parole', () => {
  // Cas réel : après 22 s de silence, whisper place les 3 premiers mots à 1,52 s.
  const zones = [
    { start: 22.47, end: 23.97 },
    { start: 24.67, end: 28.03 }
  ]
  const seg = {
    text: " On n'ont mais c'est pas possible.",
    offsets: { from: 0, to: 24680 },
    tokens: [' On', ' n', "'", 'ont', ' mais', ' c', "'", 'est', ' pas', ' possible', '.'].map((text, i) => ({ text, t_dtw: [152, 152, 152, 152, 152, 2326, 2326, 2326, 2326, 2384, 2450][i] }))
  }
  const words = wordsFromSegments([seg], zones)
  assert.deepEqual(words.map((w) => w.text), ['On', "n'ont", 'mais', "c'est", 'pas', 'possible.'])
  assert.ok(words.every((w) => w.start >= 22.4), JSON.stringify(words))
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start > words[i - 1].start, 'ordre conservé')
  // Phrase entièrement hors des zones de parole = texte inventé, écarté.
  assert.equal(wordsFromSegments([{ text: ' Merci', offsets: { from: 0, to: 2000 }, tokens: [{ text: ' Merci', t_dtw: 50 }] }], zones).length, 0)
})

test('lecture des infos ffmpeg', () => {
  const info = parseProbe(`  Duration: 01:02:03.50, start: 1.400000, bitrate: 6000 kb/s
  Stream #0:0[0x100]: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 60 fps, 60 tbr, 90k tbn
  Stream #0:1[0x101](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s`)
  assert.deepEqual(info, { duration: 3723.5, start: 1.4, width: 1920, height: 1080, fps: 60, hasVideo: true, hasAudio: true, vcodec: 'h264', alpha: false })
  const alpha = parseProbe(`  Duration: 00:00:02.51, start: 0.000000, bitrate: 333 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 720x720, SAR 1:1 DAR 1:1, 30 fps, 30 tbr, 1k tbn
      alpha_mode      : 1`)
  assert.equal(alpha.vcodec, 'vp9')
  assert.equal(alpha.alpha, true)
})

test('sous-titres décalés par l’intro et déplacés', () => {
  const look = defaultLook()
  look.subtitles.x = 0.3
  look.title = { ...look.title, enabled: true, x: 0.7, y: 0.1 }
  const ass = buildAss({ look, words: [{ text: 'salut', start: 5, end: 5.5 }], clipStart: 4, clipEnd: 10, title: 'Titre', offset: 2.5 })!
  // Le mot dit à 1 s du début du clip apparaît à 3,5 s (après 2,5 s d'intro), à 30 % de la largeur.
  assert.ok(ass.includes('Dialogue: 0,0:00:03.50,'), ass)
  assert.ok(ass.includes('\\pos(324,1421)'), ass)
  assert.ok(ass.includes('Dialogue: 1,0:00:02.50,0:00:08.50,Titre,,0,0,0,,{\\an5\\pos(756,192)}Titre'), ass)
})

test('même moment ou pas', () => {
  assert.ok(sameMoment({ start: 10, end: 40 }, { start: 15, end: 45 }))
  assert.ok(!sameMoment({ start: 10, end: 40 }, { start: 35, end: 70 }))
  assert.ok(!sameMoment({ start: 0, end: 20 }, { start: 20, end: 40 }))
})

test('empreinte du montage', () => {
  const clip = { look: defaultLook(), title: 'a', start: 1, end: 9, words: null }
  const sig = editSignature(clip)
  assert.equal(editSignature({ ...clip, look: defaultLook() }), sig, 'même montage = même empreinte')
  assert.notEqual(editSignature({ ...clip, title: 'b' }), sig)
  assert.notEqual(editSignature({ ...clip, end: 9.5 }), sig)
  const moved = defaultLook()
  moved.subtitles.y = 0.5
  assert.notEqual(editSignature({ ...clip, look: moved }), sig)
})

test('recadrage sans déformation', () => {
  const r = coverCrop({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080, 1080, 1920)
  assert.equal(r.h, 1080)
  assert.ok(Math.abs(r.w / r.h - 1080 / 1920) < 0.01)
})

test('toutes les mises en page restent dans l’image', () => {
  for (const l of LAYOUTS) {
    const f = { ...defaultLook().framing, layout: l.id, camera: { x: 0.7, y: 0.65, w: 0.3, h: 0.35 }, game: { x: 0.1, y: 0.05, w: 0.8, h: 0.9 } }
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [1080, 1920]
    ]) {
      const { width, height, regions } = computeRegions(f, w, h)
      for (const r of regions) {
        assert.ok(r.src.x >= 0 && r.src.y >= 0 && r.src.x + r.src.w <= w && r.src.y + r.src.h <= h, `${l.id} ${w}x${h} source hors image`)
        assert.ok(r.dst.x >= 0 && r.dst.y >= 0 && r.dst.x + r.dst.w <= width && r.dst.y + r.dst.h <= height, `${l.id} destination hors cadre`)
        assert.ok(r.src.w % 2 === 0 && r.src.h % 2 === 0 && r.dst.w % 2 === 0 && r.dst.h % 2 === 0, `${l.id} dimensions impaires`)
      }
    }
  }
})

console.log(`\n${passed} test(s) réussi(s)`)
