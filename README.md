# AutoClip

Application Windows qui surveille des chaînes Twitch, **enregistre les lives automatiquement**,
repère les meilleurs moments et en fait des **clips verticaux montés** (TikTok, Shorts, Reels),
avec sous-titres, titre, intro, outro, logo et musique.

Inspirée du fonctionnement de Sakoclip (voir [docs/analyse-sakoclip.md](docs/analyse-sakoclip.md)),
mais entièrement réécrite, sans compte ni abonnement, et faite pour être modifiée.

## Installer

Lance l'installeur `AutoClip-Setup-<version>.exe` : la dernière version est sur la page GitHub du
projet, rubrique **Releases** (ou dans `dist/` après `npm run dist`). Si AutoClip est déjà installé,
il se met à jour tout seul. L'installeur n'est pas signé : si Windows affiche
« Windows a protégé votre ordinateur », clique sur **Informations complémentaires** puis
**Exécuter quand même**.

Au premier lancement, AutoClip télécharge tout seul ses outils depuis leurs sites officiels :
Streamlink avec FFmpeg (GitHub de Streamlink), whisper.cpp (GitHub de whisper.cpp) et le modèle
de transcription (Hugging Face). Compte environ 300 Mo ; la progression s'affiche en haut de l'écran.

## Lancer depuis le code source

Il faut [Node.js](https://nodejs.org) 22 ou plus.

```bash
npm install
```

```bash
node node_modules/electron/install.js
```

```bash
npm run build
```

```bash
npm start
```

Autres commandes :

| Commande | Rôle |
| --- | --- |
| `npm run dev` | mode développement (rechargement à chaud de l'interface) |
| `npm test` | tests de la logique (détection, tchat, voix, sous-titres, cadrage, intro, mots, file des travaux, publication) |
| `npm run typecheck` | vérification des types TypeScript |
| `npm run dist` | fabrique l'installeur `dist/AutoClip-Setup-<version>.exe` |
| `npm run release` | fabrique l'installeur et le publie sur GitHub (mise à jour automatique pour tout le monde) |
| `npm run fonts` | retélécharge les polices libres des sous-titres (et affiche leur valeur `cell`) |

`npm run dist` doit être lancé depuis un dossier au chemin court (par exemple `C:\dev\autoclip`) :
l'outil NSIS qui fabrique l'installeur refuse les chemins de plus de 260 caractères.

## Comment s'en servir

1. **Chaînes** : tape un pseudo (des chaînes existantes sont proposées, avec 🔴 si elles sont
   en live) ou colle un lien. Dès qu'une chaîne passe en live, AutoClip l'enregistre avec son tchat
   (même fenêtre fermée : il reste dans la barre des tâches).
2. **Pendant le live**, le clip est fabriqué tout de suite et arrive dans **Clips → À trier**
   (sans attendre la fin du live) quand :
   - tu appuies sur la **touche Clip** (F8 par défaut) ;
   - le tchat écrit « clip » : 2 personnes différentes en 30 secondes par défaut (réglable de 1 à 5),
     ou un modérateur, un VIP, le streamer ou un **pseudo de confiance** (un seul « clip » suffit).
     **« clip : headshot »** donne aussi le titre du clip (« headshot » ; celui d'une personne de
     confiance d'abord, sinon le premier donné ; un titre écrit juste après le clip va encore au clip
     en préparation). Le mot se choisit dans **Réglages → Le tchat écrit « clip »** (plusieurs mots
     possibles, par exemple `clip, !clip` ; avec « clip », les variantes clips, clippe, clippez… comptent) ;
   - le streamer dit « clip » à voix haute (**Réglages → Le streamer dit « clip »**, désactivé par
     défaut) : toutes les 4 secondes, Whisper écoute les 7 dernières secondes du live, sur ton PC et
     sans internet (modèle « Rapide » d'environ 60 Mo, téléchargé tout seul ; environ 1 seconde de
     calcul à chaque fois, une seule écoute à la fois même avec plusieurs chaînes). « Éclipse »,
     « clic » et « le / un / mon clip » (quand on parle d'un clip sans en demander un) sont ignorés.
     Ces clips portent l'étiquette **🎙 « clip » dit**.
   La carte de la chaîne montre ce qu'AutoClip a fait du dernier « clip » du tchat, avec un bouton
   **Faire confiance à …**. **Réglages → Durée des clips** : automatique, ou fixe (de 15 s à 3 min),
   avec les secondes gardées après le moment signalé.
3. **À la fin du live**, l'analyse trouve les autres moments forts (tchat qui s'emballe, son qui
   monte), sans refaire ceux déjà clippés pendant le live.
4. **Clips** : un dossier par chaîne, puis les onglets **À trier**, **Gardés**, **Rendus**, **Tous**
   et **Corbeille**. Le bouton **Clips prêts** ouvre le dossier des vidéos finales de la chaîne.
   La petite flèche de **✓ Garder ▾** garde le clip en lui appliquant la patte de ton choix.
5. Ouvre un clip (**✂ Monter**) :
   - **‹ ›** en haut (ou **Alt+← →**) : clip précédent / suivant de la liste, sans revenir en
     arrière ; **🗑** (ou **Suppr**) : jette le clip et passe au suivant (**Annuler** dans le petit
     message qui s'affiche) ; **✓ Garder ▾** : comme dans la liste ;
   - **Cadrage** : jeu + fond flou, caméra + jeu, caméra seule, jeu seul ou horizontal ;
     déplace les cadres « Caméra » et « Jeu » sur l'image du live ;
   - **Sous-titres** : activés ou non, 10 styles, police, couleurs, taille. Le texte se corrige mot
     par mot : clic = aller au mot, double-clic ou Entrée = corriger, **Suppr** ou ✕ = supprimer,
     **+** = ajouter un mot après, **Mode texte** = tout retaper d'un coup (les mots qui n'ont pas
     changé gardent leur instant) ;
   - **Titre** : une accroche en bandeau ;
   - **Intro** : une vidéo ou une image avant (et/ou après) le clip, avec au choix :
     - **⏸ Le clip attend** : sa première image reste figée derrière l'intro, il démarre après ;
     - **▶ Le clip démarre dessous** : l'intro passe par-dessus le début du clip, qui joue déjà ;
     - **Flou du clip derrière** : de « Aucun » à 100 % ;
     - **Fondu** : l'intro (et le flou) disparaît en douceur, jusqu'à 2 secondes.

     Une vidéo transparente (WebM avec transparence, MOV ProRes 4444, PNG) laisse voir le clip à
     travers. **▶ Avec l'intro** la montre par-dessus le clip, sans attendre le rendu. Pareil pour
     l'outro, sur la fin du clip ;
   - **Habillage** : logo, musique de fond, volume (on l'entend dans l'aperçu) ;
   - **Patte** : choisis une patte pour ce clip, ou enregistre ce montage comme patte (voir plus
     bas). La liste **Patte** en bas à droite change aussi la patte du clip.
   Dans l'aperçu, **déplace le titre, les sous-titres et le logo à la souris**.
   **Ctrl+Z** annule, **Ctrl+Y** rétablit (ou les flèches en haut). Tout est enregistré tout seul.
6. **Garder → Valider → Terminé** :
   - **Garder** : le clip passe dans « Gardés » ;
   - **Valider** : fabrique la vidéo avec tes changements. Le bouton **▶ Rendu final** au-dessus de
     l'aperçu la montre avec l'intro et l'outro. Tu peux remodifier et revalider autant que tu veux
     (« modifications non validées » s'affiche tant que la vidéo n'est pas à jour) ;
   - **Terminé** : le clip va dans **Rendus** et sa vidéo dans « Clips prêts », prête à publier
     quand tu le décides. Si tu le modifies encore, il revient dans « Gardés ».
7. **La patte** = ton montage type :
   - **Pattes → ＋ Nouvelle patte** la crée sans avoir de clip, sur une fausse image de stream (jeu +
     caméra, avec le coin de la caméra au choix), sur une capture de ton stream ou sur un de tes
     clips ; **✏️ Modifier** retouche une patte existante ;
   - dans l'onglet Patte de l'éditeur : enregistre le montage du clip comme patte, utilise-la pour
     les prochains clips (d'une chaîne ou de toutes), applique-la aux clips déjà faits (les clips
     terminés ne sont pas touchés, sauf si tu le demandes).

   Avec **Réglages → Rendu automatique**, chaque nouveau clip sort déjà monté avec ta patte.
8. **Les travaux** (case en bas à gauche) : ce qui est en cours (analyse, transcription, rendu) et
   ce qui attend. **⏸** met tout en pause (le travail en cours est vraiment suspendu et reprend là
   où il en était), **✕** l'annule, **☰** ouvre la liste : passer en premier, mettre de côté,
   ouvrir le clip, annuler, tout annuler. Les clips demandés pendant un live sont découpés même
   quand la file est en pause.
9. **Publier** : glisse un clip terminé sur l'agenda (vue semaine ou mois), ou clique sur
   **⭐ Programmer** pour le placer au meilleur créneau libre. Pour chaque publication : date et
   heure, réseaux (TikTok, Instagram Reels, YouTube Shorts), description et hashtags
   (**Remplir tout seul**). Déplace une publication en la glissant. À l'heure prévue, AutoClip te
   prévient ; dans la publication : **🎬 Glisser la vidéo** dans la page d'envoi du réseau,
   **📋 Copier le texte**, **🌐 Ouvrir** le site, puis **✓ C'est publié**.

### Les meilleurs créneaux et l'IA

Sans rien régler, les ⭐ viennent d'un calcul fait sur ton PC : les heures où le public de chaque
réseau est le plus actif, croisées avec les horaires des 50 derniers lives de tes chaînes (une
publication 1 à 3 h avant un live ramène du monde). Bouton **⭐ Conseils** pour les voir et régler
tes habitudes (réseaux, publications par jour, hashtags ajoutés à chaque fois).

**L'IA gratuite** (par défaut, sans clé ni compte) : **✨ Demander à l'IA** lit tes horaires de
live, tes jeux et les meilleurs créneaux, et écrit un résumé et des conseils adaptés (gardés une
semaine) ; **✨ Écrire avec l'IA** propose la description et les hashtags d'un clip à partir de ce
qui y est dit. Elle tourne sur ton PC : au premier clic, AutoClip télécharge le moteur llama.cpp
(version b12322, github.com/ggml-org/llama.cpp) et le modèle Qwen 3.5 4B (licence Apache 2.0,
≈ 2,7 Go, une seule fois ; un téléchargement coupé reprend où il s'était arrêté). Ensuite elle
marche sans internet et rien ne quitte le PC. Elle utilise la carte graphique quand il y en a une
vraie (NVIDIA, AMD, Intel Arc) avec assez de mémoire libre, sinon le processeur (8 cœurs au plus),
et s'arrête après 4 minutes sans demande pour rendre la mémoire. Mesuré sur un PC portable
RTX 4070 avec Rocket League ouvert : conseils en ≈ 20 s (la toute première demande ≈ 40 s, la
carte prépare ses calculs une fois pour toutes) ; sur processeur (4 cœurs) : ≈ 1 min 30. Comme
elle ne va pas sur internet, ses conseils s'appuient sur tes données et sur des repères connus des
algorithmes (`ALGO_FACTS` dans `advisor.ts`), pas sur l'actualité. **⭐ Conseils → ✨ IA
gratuite** : télécharger maintenant, ou la supprimer (libère 2,7 Go).

Choix faits après essais (novembre 2026) : Qwen 3.5 4B analyse le mieux les horaires et les jeux
(Gemma 4 E2B est 2 fois plus rapide sur processeur mais reste vague ; Ministral 3 3B mélange
l'anglais et invente). Le moteur est lancé avec `VK_LOADER_LAYERS_DISABLE=~implicit~` : sinon
l'incrustation d'Overwolf (et d'autres logiciels du même genre) le bloque au démarrage. Sur
processeur, il tourne depuis `outils\llama\cpu\` (les mêmes fichiers, sans la partie Vulkan).
Smart App Control (Windows 11) peut bloquer quelques minutes des fichiers qu'il ne connaît pas
encore : AutoClip le dit et il suffit de réessayer.

**Option payante : Claude** (repliée sous l'IA gratuite) : avec une clé API Anthropic
(console.anthropic.com, payée à l'usage) et « IA des boutons ✨ : Claude », Claude cherche en plus
sur le web ce que chaque réseau met en avant en ce moment et propose ses propres créneaux. Coût
indicatif d'une demande de conseils : environ 0,05 $ avec Haiku, 0,15 $ avec Sonnet, 0,30 $ avec
Opus ; une description coûte bien moins. La clé est chiffrée par Windows sur ton PC et n'est jamais
montrée à l'interface.

Pourquoi AutoClip ne publie pas tout seul : TikTok et YouTube gardent en **privé** les vidéos
envoyées par une application qui n'a pas passé leur audit, et Instagram n'accepte que les comptes
professionnels reliés à une page Facebook. AutoClip prépare donc tout (vidéo, texte, rappel) et te
laisse cliquer sur « Publier » sur le site.

## Mises à jour automatiques

AutoClip vérifie au démarrage (puis toutes les quelques heures) s'il existe une nouvelle version,
la télécharge en arrière-plan et propose **Redémarrer pour mettre à jour** (bandeau en haut, ou
Réglages → Application). Ceux à qui tu as donné l'installeur reçoivent donc tes nouvelles versions.

### Publier une mise à jour

**À faire une seule fois** (sur github.com) :

1. Crée un compte GitHub (gratuit).
2. Crée un dépôt nommé `autoclip`, **public**, en cochant **Add a README file**. Sans ce premier
   fichier, GitHub refuse la publication.
3. Crée un jeton : photo de profil → **Settings** → **Developer settings** → **Personal access
   tokens** → **Fine-grained tokens** → **Generate new token**. Accès : seulement le dépôt
   `autoclip`. Permission **Contents : Read and write**. Copie le jeton (il ne s'affiche qu'une
   fois) et garde-le pour toi : il donne le droit de publier à ta place.

**À chaque nouvelle version** : double-clique sur `publier.cmd`. Il n'y a rien à taper :

- la version préparée dans le code (`package.json`) part directement si elle n'est pas encore en
  ligne ; si elle l'est déjà, il propose la suivante (Entrée = par exemple `0.3.1` → `0.3.2`) ;
- le jeton n'est demandé que **la première fois** (il ne s'affiche pas quand tu le colles). Il est
  ensuite gardé sur ce PC, chiffré par Windows (seul ton compte Windows, sur ce PC, peut le relire),
  dans `%APPDATA%\AutoClip-publication\`, hors du projet : il ne part jamais dans l'installeur ni
  sur GitHub. Il est vérifié avant la fabrication : s'il a expiré ou a été supprimé, il est oublié et
  redemandé. `publier.cmd -OublierJeton` l'efface ;
- le pseudo GitHub n'a été demandé qu'une fois (il est gardé dans `electron-builder.yml`).

Il fabrique l'installeur et le publie. À la fin, il affiche le lien à envoyer à tes amis :
`https://github.com/<ton-pseudo>/autoclip/releases/latest`.

`publier.ps1 -Auto` fait la même chose sans jamais poser de question (il s'arrête si le jeton
n'est pas encore gardé ou si la version est déjà en ligne) : c'est ce que Claude lance quand tu lui
dis de publier.

Ne colle jamais ton jeton ailleurs que dans la fenêtre de `publier.cmd` (ni dans une conversation,
ni dans un fichier) : il donne le droit de publier à ta place. S'il a fuité, supprime-le sur GitHub
(même menu que pour le créer) et crée-en un nouveau.

**Important** : les installeurs fabriqués avant que ton pseudo soit réglé ne savent pas où chercher
les mises à jour. Toi et tes amis devez installer **une fois** AutoClip depuis cette page GitHub ;
ensuite, chaque nouvelle version arrive toute seule (bandeau « Redémarrer et mettre à jour »).

`publier.cmd -Essai` fabrique l'installeur sans rien publier, pour vérifier que tout marche.
Seule l'application installée se met à jour (pas `npm start`). Pour tester avec un serveur local :
variable `AUTOCLIP_UPDATE_URL=http://127.0.0.1:8123` pointant vers un dossier contenant
`latest.yml` et l'installeur.

## Où sont les fichiers

- Lives : `Vidéos\AutoClip\Enregistrements\<chaîne>\` (+ `clips\` pour les extraits 16:9,
  `montages\` pour les vidéos validées pas encore terminées)
- Vidéos finales : `Vidéos\AutoClip\Clips prêts\<chaîne>\`
- Réglages, pattes, liste des clips, agenda de publication (`publications.json`), clé API chiffrée
  (`secrets.json`), outils téléchargés : `%APPDATA%\AutoClip\` (l'IA gratuite : `outils\llama\`
  et `outils\modeles\Qwen3.5-4B-Q4_K_M.gguf`)

Les deux premiers dossiers se changent dans Réglages.

## Essayer une copie sans toucher à ton AutoClip

Variables d'environnement utiles pour tester une version (avec `npm start` ou une copie compilée) :

| Variable | Effet |
| --- | --- |
| `AUTOCLIP_DATA=<dossier>` | réglages, clips et pattes dans ce dossier au lieu de `%APPDATA%\AutoClip` ; la copie ne réveille pas l'AutoClip installé |
| `AUTOCLIP_SILENT=1` | aucune notification Windows (elles s'écrivent dans la console) |
| `AUTOCLIP_DEBUG=voix` | affiche tout ce que l'écoute du streamer entend |
| `AUTOCLIP_UPDATE_URL=<adresse>` | cherche les mises à jour sur un serveur local (voir plus haut) |

## Organisation du code

```
src/
  shared/            utilisé par l'interface ET par le moteur
    types.ts         modèle de données (Clip, Look = montage, Template = patte, Settings…)
    presets.ts       mises en page, styles de sous-titres, polices, cadrage, déroulé intro / outro
    words.ts         corrections de la transcription (mots remplacés, ajoutés, retapés)
    publishing.ts    agenda de publication, réseaux, calcul des meilleurs créneaux
    chatcommand.ts   commande du tchat : « clip », « clip : titre », mots choisis dans les réglages
    api.ts           liste des fonctions que l'interface peut appeler
  main/              moteur (processus principal Electron)
    index.ts         démarrage, fenêtre, barre des tâches, touche Clip, API
    recorder.ts      surveillance d'une chaîne + enregistrement Streamlink
    chat.ts          enregistrement du tchat Twitch
    voice.ts         écoute du streamer (« clip » dit à voix haute)
    twitch.ts        statut des lives et profils (API GQL de twitch.tv)
    analyze.ts       analyse d'un live → clips
    detect.ts        algorithme de détection des moments forts
    transcribe.ts    transcription mot par mot (whisper.cpp)
    subtitles.ts     fichier de sous-titres .ass
    render.ts        rendu final ffmpeg (cadrage, sous-titres, logo, musique, intro/outro)
    jobs.ts          file d'attente (analyse, clips du live, transcription, rendu, Terminé)
    proc.ts          lancement des outils, pause (suspension des processus) et annulation
    publish.ts       agenda de publication et rappels à l'heure
    advisor.ts       conseils de publication (calcul local, IA gratuite, ou Claude avec recherche web)
    llm.ts           IA gratuite sur le PC (llama.cpp : téléchargement, carte graphique, demandes)
    audience.ts      horaires des derniers lives des chaînes (pour les conseils)
    secrets.ts       clé API chiffrée par Windows
    updater.ts       mises à jour automatiques (electron-updater + GitHub)
    deps.ts          téléchargement / détection des outils externes
    store.ts         réglages, pattes, clips (fichiers JSON)
    media.ts         protocole media:// pour lire les vidéos dans l'interface
  preload/index.ts   pont sécurisé interface ↔ moteur
  renderer/src/      interface React
    pages/           Chaînes, Clips, Éditeur, Publier, Pattes (et l'éditeur de patte), Enregistrements, Réglages
    components/      aperçu vertical en direct (Preview.tsx), réglages du montage (LookPanel.tsx),
                     mots (WordsEditor.tsx), bouton Garder, case des travaux, petits composants
tests/               tests de la logique
```

L'aperçu de l'éditeur et le rendu ffmpeg utilisent le même calcul de cadrage
(`computeRegions` dans `shared/presets.ts`) : ce qu'on voit est ce qu'on obtient.

## Idées pour la suite

- Note des moments par IA (avec ta propre clé API)
- Suivi automatique du visage pour la caméra
- Kick, YouTube Live
- Envoi direct sur YouTube avec son API officielle (il faut d'abord faire valider l'application par
  Google, sinon les vidéos restent privées)
- Compilation de plusieurs clips en une vidéo
- Effets : zoom sur les moments forts, émojis, bruitages, barre de progression
