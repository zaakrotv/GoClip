# AutoClip — résumé de la conversation (11 au 13 novembre 2026)

## Décisions prises

- AutoClip = recréation de Sakoclip (clips Twitch automatiques), en Electron, modifiable à volonté.
- Mises à jour par GitHub (zaakrotv/autoclip) : chaque nouvelle version arrive toute seule chez toi et tes amis.
- IA de Publier gratuite et sans clé : elle tourne sur le PC (llama.cpp + modèle Qwen 3.5 4B, ≈ 2,7 Go téléchargés au premier clic ✨).
  - Elle ne va pas sur internet (aucun service gratuit sans clé n'est fiable) : conseils = tes lives, tes jeux et des règles connues des algorithmes.
  - Qwen 3.5 choisi après comparaison (plus juste que Gemma 4 et Ministral 3).
  - Claude reste disponible en option payante (clé API, recherches web).
- Moteur de l'IA figé sur une version essayée (protection Smart App Control de Windows) et protégé contre l'incrustation d'Overwolf.
- Tchat : « clip » seul fait un clip, « clip : titre » donne le titre, le mot se choisit dans Réglages.
- Jeton GitHub : jamais utilisé depuis la conversation. Il est collé une seule fois dans la fenêtre de `publier.cmd`, puis gardé chiffré par Windows sur ton PC.
- Publication : lancée par Claude seulement après ton « oui » pour chaque version.

## Ce qui a été fait

- 0.2.x : l'app de base (enregistrement, détection des moments forts, montage vertical, pattes) et les mises à jour automatiques.
- 0.3.0 (publiée le 12/11) : ta 2e liste de 12 améliorations.
  - Intro, montage, mots modifiables, file des travaux, agenda Publier, éditeur de patte.
  - Correction du « clip » du tchat, durée des clips au choix, le streamer qui dit « clip ».
- 0.3.1 (publiée le 12/11 à 21 h 28) : l'IA gratuite dans Publier.
  - Conseils en ≈ 20 s sur ta RTX 4070, description d'un clip en 10 à 20 s.
- 0.3.2 (publiée le 13/11 à 11 h 05) :
  - « clip : titre » et mot du tchat au choix ;
  - `publier.cmd` sans saisie : jeton gardé, version publiée sans question, mode `-Auto`.
- Chaque version : tests automatiques (47 au total) et essais de bout en bout sur ton PC.
- Suivi détaillé dans `docs/en-cours.md`, mode d'emploi dans `README.md`.

## Ce qui reste à faire

- Si le jeton gardé est celui que tu avais écrit dans la conversation :
  - le supprimer sur GitHub et en créer un nouveau ;
  - lancer `publier.cmd -OublierJeton` : la prochaine publication demandera le nouveau.
- Pas encore vérifié :
  - un vrai appel à Claude (pas de clé) ;
  - une vraie publication sur TikTok, Instagram ou YouTube ;
  - l'IA gratuite sur les PC de tes amis (sans carte graphique ou avec Smart App Control).
- Idées pour plus tard (README) :
  - IA qui note les moments ;
  - suivi du visage pour la caméra ;
  - Kick et YouTube Live ;
  - envoi direct sur YouTube (après validation par Google) ;
  - compilations de clips.
