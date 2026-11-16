# Chantier en cours : version 0.3.2 (tchat : « clip : titre », mot au choix ; publication sans saisie)

Ce fichier sert à reprendre le travail exactement où il s'est arrêté (limite d'utilisation…).
Il est mis à jour à chaque étape. Quand tout est fini, la ligne d'état devient « ÉTAT : TERMINÉ ».

ÉTAT 0.3.2 : TERMINÉ ET PUBLIÉ — en ligne le 2026-11-13 à 11:05:56 (installeur, blockmap, latest.yml ; « latest » =
v0.3.2 ; empreinte identique à dist\ ; fabriquée avec chatcommand.ts). Publication lancée par Claude dans l'onglet de
terminal « Publier 0.3.2 » à la demande de l'utilisateur (« lance tout toi-même ») ; l'utilisateur y a collé son
nouveau jeton, désormais gardé chiffré (DPAPI) dans %APPDATA%\AutoClip-publication\jeton-github.txt (vérifié : pas en
clair). Prochaines versions : `powershell -File publier.ps1 -Auto` (aucune saisie), après le « oui » de l'utilisateur.
Avant : code, tests (npm test 26 + 13 + 8 OK, typecheck OK), essai de bout en bout (scratchpad\harness\chat-title.ts :
ligne IRC → décision → moment → vraie découpe d'un enregistrement ZeratoR, titre « headshot » OK), capture de Réglages.
- Demande de l'utilisateur : « clip » seul fait un clip comme avant ; « clip : headshot » → le clip s'appelle
  « headshot » ; choisir le mot qui déclenche le clip dans le tchat.
- Code : src/shared/chatcommand.ts (`parseClipCommand`, `cleanChatTitle` : sans lien ni guillemets, 80 caractères,
  `normalizeChatWords` : 5 mots au plus, « clip » si vide, `pickChatTitle` : titre d'une personne de confiance
  d'abord) ; detect.ts (ChatRequest.title, Candidate.title, parseChatLog(texte, mots)) ; chat.ts (mots lus dans les
  réglages) ; recorder.ts (`pendingChatMoment` : un titre écrit juste après le clip va au clip en préparation) ;
  analyze.ts (Clip.title = titre du tchat) ; store.ts (`detection.chatWords`, défaut ['clip']) ; Réglages (champ
  « Mot qui demande un clip ») ; carte de la chaîne (« clip : titre » de X).
- Publication : l'utilisateur veut que Claude publie lui-même avec SON jeton (il l'a collé dans la conversation le
  2026-11-12 : REFUSÉ, ne jamais l'utiliser ; il doit le supprimer sur GitHub). À la place, publier.ps1 garde le
  jeton chiffré par Windows (DPAPI) dans %APPDATA%\AutoClip-publication\jeton-github.txt après l'avoir demandé UNE
  fois dans sa fenêtre ; la version de package.json part sans question si elle n'est pas en ligne ; `-Auto` (aucune
  question, pour Claude, avec l'accord de l'utilisateur à chaque version ; la sécurité de la session a refusé une
  fois de lancer publier.cmd : « Create Public Surface ») ; `-OublierJeton`. Vérifié avec des valeurs factices :
  chiffrement aller-retour (bug du saut de ligne corrigé), jeton refusé → 401, `-Auto` s'arrête avant de fabriquer.

---

# Chantier précédent : version 0.3.1 (IA gratuite, sans clé)

ÉTAT 0.3.1 : TERMINÉ ET PUBLIÉ — en ligne le 2026-11-12 à 21:28:57 (publier.cmd lancé par l'utilisateur ;
installeur, blockmap et latest.yml en ligne, « latest » = v0.3.1, empreinte identique à dist\). Fabriquée avec le
code de 21:09 : l'IA gratuite, PAS les nouveautés du tchat (0.3.2). Demande : « l'IA qui donne les conseils et
analyse les algorithmes : toujours présente, gratuite, sans clé API, juste un bouton ».
- Choix : IA sur le PC = llama.cpp b12322 (version Vulkan, URL figée) + Qwen 3.5 4B Q4_K_M (unsloth, Apache 2.0,
  2,74 Go, URL figée sur un commit, taille vérifiée). Comparé sur les vraies demandes : Qwen > Gemma 4 E2B (2× plus
  rapide sur processeur mais vague) > Ministral 3 3B (anglais, markdown, invente). Pas de recherche web (aucun service
  gratuit sans clé n'est fiable) : conseils = données du streamer + repères `ALGO_FACTS` (advisor.ts). Claude reste en
  « Option payante » repliée (prefs.aiEngine = 'local' | 'claude', défaut 'local').
- Code : src/main/llm.ts (installation au 1er clic, dossier `llama\cpu` = mêmes fichiers en liens physiques sans
  ggml-vulkan.dll ; `--list-devices` → vraie carte, sinon processeur 8 cœurs max ; repli processeur si la carte plante ;
  arrêt après 4 min ; une demande à la fois ; JSON forcé par schéma ; `enable_thinking: false` ; nettoyage des moteurs
  orphelins de notre dossier ; message si Smart App Control bloque) ; advisor.ts (`localAiAdvice`, `localAiCaption`) ;
  deps.ts (téléchargement repris) ; index.ts ; Publish.tsx ; tests/ia.test.ts (8) ; README ; version 0.3.1.
- Essais faits (accord de l'utilisateur pour lancer llama.cpp) : clic « Demander à l'IA » dans une copie de l'app →
  moteur téléchargé, conseils en ≈ 20 s (RTX 4070, Rocket League ouvert) ; description d'un vrai clip ZeratoR
  (transcrit) en 11 à 20 s ; plantage simulé : pas de moteur orphelin ; « Quitter » : moteur arrêté ; arrêt après 4 min OK.
- PIÈGES découverts : (1) la couche Vulkan d'Overwolf (ow-graphics-vulkan.dll) bloque llama-server au démarrage →
  `VK_LOADER_LAYERS_DISABLE=~implicit~`. (2) Smart App Control est ACTIF chez l'utilisateur : il bloque des fichiers
  non signés inconnus (llama-bench, DLL de la version « cpu », b11900 entier), puis les laisse passer quelques minutes
  plus tard (analyse dans le nuage). (3) `npm run dist` dans ce dossier échoue (chemin > 260 caractères pour NSIS) :
  passer par `publier.ps1` (copie dans %TEMP%\autoclip-pub). (4) GitHub très lent ce soir-là (36 Mo en 2 min 30, curl
  aussi) ; Hugging Face ≈ 10 Mo/s avec fetch.

---

# Chantier précédent : version 0.3.0 (2e liste d'améliorations de l'utilisateur)

ÉTAT : TERMINÉ ET PUBLIÉ — 2026-11-12 (vu à 19:35) : version 0.3.0 en ligne sur GitHub (`publier.cmd` lancé par
l'utilisateur avec son jeton : « Publié ! Version 0.3.0 en ligne. »). Avant : typecheck OK, npm test 23 + 13 OK,
build OK, installeur d'essai démarré : OK. L'AutoClip installé chez l'utilisateur (0.2.1, C:\Program Files\AutoClip,
mises à jour réglées sur GitHub) la cherche 15 s après son démarrage puis toutes les 4 h, la télécharge, affiche
« Redémarrer et mettre à jour » et l'installe aussi tout seul à la fermeture.

## Demandes (fichier « ameliorationchangement autoclip 2.txt » sur le Bureau)

1. Intro : fondu, clip qui démarre en même temps (flou) ou en pause, sans flou possible, intensité du flou réglable
2. Changer de clip directement dans le montage (précédent / suivant / liste)
3. Transcription : supprimer / modifier chaque mot plus simplement
4. Choisir la patte dès le bouton « Garder »
5. Supprimer le clip directement depuis le montage (clips « À trier »)
6. Choisir et appliquer une patte dans le montage
7. Case des travaux en bas à gauche : pause, annuler, gérer les rendus / transcriptions
8. Publication directe TikTok / Instagram / YouTube Shorts, date + heure, description, hashtags, calendrier glisser-déposer, assistant « meilleures heures »
9. Créer une patte directement dans l'onglet Pattes avec une fausse image de stream + caméra
10. Détection vocale : le streamer dit « clip » → clip
11. BUG : « clip » écrit dans le tchat est compté mais aucun clip n'est fait
12. Option pour choisir la durée des clips

## Analyse

- 11 : il fallait 2 personnes différentes en 30 s, ou un modo / le streamer. Une seule personne → compté (« clip » × 1) mais pas de clip.
  Correctif : réglage du nombre de personnes (1 à 5), pseudos de confiance, VIP comptés, retour visible dans la carte de la chaîne.

## Avancement

ATTENTION : une copie de la session (« fork », local_f97cd3cf…) travaille dans le même dossier
depuis le 2026-11-12 13:02. Se répartir les fichiers avant de continuer (voir messages entre sessions).

Session principale (local_b027f2e2…) — fait, testé (22 tests OK, typecheck OK avant les modifs du fork) :
- [x] 11 (« clip » du tchat) : `detection.chatUsers` (1 à 5, défaut 2), `detection.trusted` (pseudos de confiance),
  VIP comptés comme les modos (chat.ts), `ChannelState.lastRequest` (ce qui a été décidé) affiché dans la carte
  de la chaîne avec un bouton « Faire confiance à <pseudo> » (Channels.tsx). Délai entre 2 clips du tchat : 45 s.
- [x] 12 (durée des clips) : `detection.fixedLength` (0 = auto) et `detection.after` ; `markedWindow()` et
  `isTrusted()` dans detect.ts ; les moments demandés par le tchat ne sont plus écartés par la limite par heure ;
  section « Durée des clips » et « Le tchat écrit « clip » » dans Réglages.
- [x] Préparation du 10 : raison `voice` (Clips.tsx), `Mark.voice` (detect.ts), `ChannelState.voice` (affiché dans
  la carte de la chaîne), `detection.voice` (défaut false), `saveMark()` dans recorder.ts.
- [x] 10 (le streamer dit « clip ») — FINI ET TESTÉ le 2026-11-12 18:07 avec le code final des deux sessions
  (typecheck complet OK, npm test : 23 + 13 OK) :
  - src/main/voice.ts : `VoiceListener` (toutes les 4 s, Whisper « base » écoute les 7 dernières secondes de
    l'enregistrement en cours, `-ot`, indice `--prompt "Clip !"`, une écoute à la fois toutes chaînes confondues),
    `heardClip()` (ignore « éclipse », « clic », et « le/un/mon… clip » = on parle d'un clip), `findClipWord()`
    (mots au bord de la fenêtre ignorés : 0,6 s au début, 0,35 s à la fin), `Mp4Walker` + `tsSync()`.
  - DÉCOUVERTE : Twitch envoie maintenant ses lives en MP4 FRAGMENTÉ (ftyp/moov puis moof/mdat de ~2 s) ;
    Streamlink l'écrit tel quel dans le « .ts ». L'écoute recolle l'en-tête + les derniers fragments complets ;
    elle gère aussi le vrai MPEG-TS. (ffmpeg lit très bien ces fichiers pour l'analyse et la découpe.)
  - recorder.ts : l'écoute démarre avec l'enregistrement, `onVoice()` = touche Clip au moment du mot
    (`saveMark(…, voice)`, raison `voice`) ; index.ts : `prepareVoice()` télécharge le modèle « base » s'il manque
    (quand on active l'écoute, et au démarrage) ; Réglages : section « Le streamer dit « clip » » ;
    AUTOCLIP_DEBUG=voix affiche tout ce que l'écoute entend.
  - Essais (scratchpad\harness) : voice-test (faux live qui grossit en temps réel, TS et MP4 fragmenté : « clip »
    dit à 22,2 s repéré à 21,9–22,8 s, une seule fois, pas d'alerte sur « éclipse » / « clic ») ; fenêtres glissantes
    sur son bruyant (indice : 7/7 au lieu de 5/7) ; voice-live (vrai live Twitch : transcription correcte, sans
    erreur) ; voice-flow (vrai live : « clip » → clip de 25 s dans À trier 11 s après, pas de doublon en fin de live) ;
    chat-flow (décisions du tchat : attente, clip, déjà clippé, confiance, modo, réglé à 1, coupé).
  - Mesure : ≈ 1,2 s de calcul (4 cœurs) par écoute de 7 s sur ce PC (Core Ultra 7 155H).

Session « fork » (local_f97cd3cf…) — points 1 à 9, FAITS ET TESTÉS de bout en bout le 2026-11-12 (copie de l'app hors
du projet lancée avec AUTOCLIP_DATA + AUTOCLIP_SILENT=1 et pilotée par CDP : scratchpad\e2e-setup.mjs + e2e-drive.mjs,
phases editeur / rendu / file / publier / patte, toutes OK) :
- [x] 1 Intro / outro : `IntroStyle` (mode pause | play, flou 0–100, fondu 0–2 s) ; `extraTimeline()` (presets.ts)
  commun au rendu et à l'aperçu ; render.ts : tpad (pause), flou réglable (boxblur sur l'image au quart, 60 = ancien
  flou), fondus en transparence, son de l'intro mixé (play) ou mis bout à bout (pause) ; aperçu « ▶ Avec l'intro »
  dans le montage, sans rendu. Vérifié image par image : intro play = 10 s (flou + fondu entre 1,9 et 2,5 s),
  intro pause + outro = 12,5 s ; image et son de la bonne durée.
- [x] 2 Clip précédent / suivant dans le montage (‹ n / N ›, Alt+← →, Page préc. / suiv.), liste mémorisée (nav.ts).
- [x] 3 Mots (WordsEditor.tsx + shared/words.ts) : clic, double-clic ou Entrée pour corriger, Suppr, ✕, « + » pour
  ajouter, mode texte (les mots inchangés gardent leur instant, les nouveaux se placent entre eux).
- [x] 4 et 6 « ✓ Garder ▾ » avec choix de la patte (KeepButton.tsx, `keepClips`), liste « Patte » en bas du montage et
  onglet Patte, annulables par Ctrl+Z.
- [x] 5 🗑 ou Suppr dans le montage → corbeille, clip suivant, petit message avec « Annuler » (Toast.tsx).
- [x] 7 Case des travaux (Queue.tsx ; proc.ts `ProcGroup` + NtSuspendProcess ; jobs.ts) : pause / reprise (processus
  vraiment suspendus : temps CPU figé), mettre de côté, passer en premier, ouvrir le clip, annuler, tout annuler ;
  les clips demandés pendant un live passent à côté de la file.
- [x] 8 Publier (Publish.tsx ; main : publish.ts, advisor.ts, audience.ts, secrets.ts ; shared/publishing.ts) : agenda
  semaine / mois en glisser-déposer, ⭐ meilleurs créneaux (calcul local d'après les VOD des chaînes suivies, ou IA
  Claude facultative avec clé chiffrée par Windows), rappel à l'heure (notification) et publication assistée (vidéo à
  glisser dans le site, texte copié, page d'envoi ouverte, « C'est publié »). Pas d'envoi 100 % automatique : TikTok et
  YouTube gardent en privé les vidéos des applis non auditées.
- [x] 9 « ＋ Nouvelle patte » / « ✏️ Modifier » (TemplateEditor.tsx) sur une fausse image de stream avec caméra, une
  capture du stream ou un clip.
- Corrigés pendant les essais : correction de mots écrasée si une mise à jour du clip arrivait avant l'enregistrement
  (Editor.tsx) ; menu « Garder » coupé par les cartes (position fixe) ; message « patte appliquée » resté après
  Ctrl+Z ; agenda ouvert sur 6 h (il s'ouvre maintenant sur les heures utiles) ; étiquettes trop larges dans les cases.
- Tests unitaires : tests/v3.test.ts (13), lancés par npm test.
- [x] Vérification finale commune (typecheck, npm test, build), version 0.3.0 (package.json + package-lock.json),
  README (nouveautés 1 à 12, IA et coût, variables de test), publier.ps1 (propose la version de package.json tant
  qu'elle n'est pas en ligne, au lieu de sauter à la suivante), advisor.ts (relance valide si un appel d'outil est
  coupé), coût indicatif de l'IA affiché dans Publier.
- Non vérifié faute de clé / de compte : un vrai appel à Claude (conseils, descriptions) et une vraie publication
  sur TikTok / Instagram / YouTube (le glisser de la vidéo vers le navigateur).
