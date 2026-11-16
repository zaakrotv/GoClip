# Analyse de Sakoclip 0.1.4 (ce qu'on a appris en le démontant)

Fichier étudié : `sakoclip-0.1.4-setup.exe` (242 907 912 octets,
SHA-256 `a7a8b7e93265e7171f7a11f607171de77c4ddf9a21736b7077658b71a6316aae`).

AutoClip n'en reprend **aucune ligne de code** : c'est une réécriture à partir de
ce comportement observé. Ce document sert de carte pour comprendre l'original et
voir ce qui reste à faire.

## 1. Emballage

| Couche | Constat | Comment on le sait |
| --- | --- | --- |
| Installeur | NSIS (signature `NullsoftInst` à l'offset 0x65C04, en-tête compressé en deflate brut) | lu dans les octets |
| Charge utile | archive 7z stockée telle quelle à 0x7B6D1 (242 040 918 octets, LZMA2 + BCJ2) | blocs NSIS parcourus, archive listée |
| Application | Electron (`sakoclip.exe`, `resources.pak`), code dans `resources/app.asar` | arborescence extraite |
| Outils embarqués | `resources/streamlink/` (Streamlink + Python 3.14 + `ffmpeg.exe` n9.0.1) | arborescence + `BUILDINFO.txt` |
| IA locale | `resources/ia/bin/sakoclip-ia.exe` (whisper.cpp), `sakoclip-ia-voix.exe` + `modeles/voix.bin` (885 Ko : détecteur de voix Silero) | noms, tailles, arguments trouvés dans le code |
| Vision | `models/yunet-2023mar.onnx` (détection de visage) et `sface-2021dec.onnx` (reconnaissance de visage) via `onnxruntime-node` | fichiers + licences MIT/Apache |
| Polices | 14 polices libres (Anton, Bangers, Bebas Neue, Luckiest Guy…) | `resources/fonts` + licences OFL/Apache |
| Mises à jour | `electron-updater`, serveur `telechargements.sakoclip.com` | `app-update.yml` |
| Comptes / paiement | Supabase (fonctions `ia`, `abonnement`, `gratuit`, `partenaire`, `reseaux`) + portail Stripe | chaînes du code principal |

Pile de l'interface (d'après `package.json`) : electron-vite, React, Radix UI, Phosphor Icons,
`opentype.js` (mesure du texte des sous-titres), `koffi` (appels Windows natifs).

## 2. Fonctionnement (lu dans `out/main/index.js` de l'asar)

1. **Surveillance** : `streamlink --json <chaîne>` répond « live » ou « No playable streams »
   (hors ligne). Twitch GQL (`gql.twitch.tv`, Client-ID public du site) sert pour les profils
   et les lives ratés. Kick est aussi géré (`kick.com/api/v2/channels`).
2. **Enregistrement** : `streamlink --force --output <fichier.ts> <url> 1080p60,best`.
   En version gratuite, le flux passe par la sortie standard et est chiffré (« coffre »).
3. **Tchat** : connexion IRC anonyme (`wss://irc-ws.chat.twitch.tv`, pseudo `justinfanNNNNN`)
   ou Pusher pour Kick ; chaque message est écrit dans `<live>.chat.jsonl`, avec un repère
   `{"type":"video"}` quand le fichier vidéo commence à grossir.
4. **Analyse en fin de live** :
   - son : ffmpeg décode en mono 8 kHz, énergie (dB) par seconde ;
   - tchat : poids par seconde (mots « hype » ×2 : lol, mdr, ptdr, kekw, pog…), demandes « clip » ;
   - score = 3 × (tchat normalisé) + 3,7 × (montée du son), normalisation robuste (médiane / écart
     absolu médian), seuil 11, clips de 20 à 60 s (90 s quand le tchat demande un clip) ;
   - « IA » : transcription whisper.cpp, puis notation des passages de 2 min par un LLM distant
     (fonction Supabase `ia`, payante) ;
   - touche Clip (F8 par défaut, durées 15 à 300 s) enregistrée dans `<live>.touches.json`.
5. **Transcription** : `sakoclip-ia-voix.exe -vm voix.bin` (zones de parole), puis
   `sakoclip-ia.exe -m sous-titres.bin -l fr -ojf --dtw large.v3.turbo` (horodatage par mot).
   Le modèle (574 Mo, large-v3-turbo q5_0) et les DLL CUDA se téléchargent au premier lancement.
6. **Rendu vertical 1080×1920** : graphe de filtres ffmpeg (recadrages `crop`/`scale`, fond flou
   `boxblur`, zones rondes par masque `geq` + `alphamerge`, suivi du visage), sous-titres `.ass`
   brûlés par libass, filigrane forcé en gratuit, musique mixée, encodeur choisi parmi
   `h264_nvenc`, `h264_amf`, `h264_qsv`, `h264_mf`, sinon `libx264`.
7. **Mises en page** : Jeu seul (fond flou), Caméra + contenu, Plein cadre visage,
   Deux personnes, Groupe.
8. **Styles de sous-titres** : 10 préréglages (police, couleurs, contour, ombre, majuscules,
   mots par groupe, zoom du mot dit, karaoké, effets « grossit » / « tremble » suivant la voix).
9. **Profils** : un montage peut être enregistré en profil et appliqué « sur ce clip / tous les
   clips de ce live / de cette chaîne / de toutes mes chaînes » (`clips:paste-look`).
10. **Publication** : TikTok, YouTube, Instagram via le serveur Sakoclip (fonction `reseaux`).

## 3. Ce qu'AutoClip reprend, change ou laisse de côté

| Fonction | AutoClip |
| --- | --- |
| Surveillance + enregistrement Streamlink + tchat | ✅ même principe (Twitch) |
| Détection tchat / son / « clip » / touche | ✅ algorithme réécrit et réglable (sensibilité, limite par heure) |
| Transcription mot par mot whisper.cpp | ✅ en local, modèle au choix (base, small, large-v3-turbo) |
| Rendu vertical, 5 mises en page, sous-titres stylés, titre | ✅ |
| Profils (« pattes ») appliqués aux autres clips | ✅ + patte par chaîne et par défaut |
| Intro / outro sur chaque clip | ➕ **nouveau** (absent de Sakoclip) |
| Logo et musique | ✅ logo libre (pas de filigrane imposé) |
| Note des moments par IA distante, titres / hashtags IA | ❌ à faire (idée : clé API perso) |
| Suivi automatique du visage (YuNet / SFace) | ❌ à faire (cadrage manuel pour l'instant) |
| Kick | ❌ à faire |
| Publication automatique sur les réseaux | ❌ à faire |
| Comptes, abonnement, chiffrement des lives gratuits | ❌ volontairement absent |
