# Publie une nouvelle version d'AutoClip sur GitHub.
# Tous ceux qui ont installé AutoClip depuis ta page GitHub la reçoivent automatiquement.
# Le plus simple : double-clique sur publier.cmd. La version préparée dans le code part sans
# question ; le jeton GitHub n'est demandé que la première fois (il est ensuite gardé sur ce PC,
# chiffré par Windows : seul ton compte Windows, sur ce PC, peut le relire).
# -Essai        : fabrique l'installeur sans rien publier (pour vérifier que tout marche).
# -Auto         : ne pose aucune question (s'arrête si le jeton manque ou si la version est déjà en ligne).
# -OublierJeton : efface le jeton gardé (le prochain publier.cmd le redemandera).
param([switch]$Essai, [switch]$Auto, [switch]$OublierJeton)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projet = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false
function Lire($fichier) { [IO.File]::ReadAllText((Join-Path $projet $fichier)) }
function Ecrire($fichier, $texte) { [IO.File]::WriteAllText((Join-Path $projet $fichier), $texte, $utf8) }
$entetes = @{ 'User-Agent' = 'AutoClip'; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
# Hors du dossier du projet : il n'est jamais copié dans l'installeur ni envoyé sur GitHub.
$jetonFichier = Join-Path $env:APPDATA 'AutoClip-publication\jeton-github.txt'

if ($OublierJeton) {
  Remove-Item $jetonFichier -Force -ErrorAction SilentlyContinue
  Write-Host 'Jeton GitHub oublié : le prochain publier.cmd le redemandera.' -ForegroundColor Yellow
  return
}

Write-Host ''
Write-Host "=== Publier une nouvelle version d'AutoClip ===" -ForegroundColor Magenta
if ($Essai) { Write-Host '(essai : rien ne sera publié)' -ForegroundColor Yellow }

# 1. Pseudo GitHub : demandé une seule fois, puis gardé dans electron-builder.yml.
$yml = Lire 'electron-builder.yml'
if (-not $Essai -and $yml -match 'owner:\s*CHANGE-MOI') {
  if ($Auto) { throw 'Pseudo GitHub pas encore réglé : lance publier.cmd une fois (double-clic).' }
  $pseudo = (Read-Host 'Ton pseudo GitHub').Trim()
  if ($pseudo -notmatch '^[A-Za-z0-9-]+$') { throw 'Pseudo GitHub invalide.' }
  Ecrire 'electron-builder.yml' ($yml -replace 'owner:\s*CHANGE-MOI', "owner: $pseudo")
  Write-Host "Pseudo enregistré : $pseudo"
}
$owner = ([regex]'owner:\s*(\S+)').Match((Lire 'electron-builder.yml')).Groups[1].Value
$depot = "https://api.github.com/repos/$owner/autoclip"

# 2. Numéro de la nouvelle version (chaque publication doit avoir un numéro plus grand).
$pkg = Lire 'package.json'
$actuelle = ([regex]'"version":\s*"([^"]+)"').Match($pkg).Groups[1].Value
$version = $actuelle
if (-not $Essai) {
  # Où en est cette version sur GitHub ? absente (préparée dans le code), incomplète (envoi
  # interrompu) ou déjà en ligne.
  $etat = 'absente'
  try {
    $enLigne = Invoke-RestMethod -Uri "$depot/releases/tags/v$actuelle" -Headers $entetes
    $etat = if ($enLigne.assets | Where-Object { $_.name -eq 'latest.yml' }) { 'en-ligne' } else { 'incomplete' }
  } catch {
    if (-not ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404)) { throw "GitHub ne répond pas : $($_.Exception.Message)" }
  }
  if ($etat -eq 'absente') {
    Write-Host "Version $actuelle (préparée dans le code, pas encore en ligne) : publication." -ForegroundColor Yellow
  } elseif ($etat -eq 'incomplete') {
    Write-Host "La version $actuelle est en ligne mais incomplète : on la complète." -ForegroundColor Yellow
  } else {
    if ($Auto) { throw "La version $actuelle est déjà en ligne : rien à publier (le numéro de version doit d'abord changer dans package.json)." }
    $p = $actuelle.Split('.')
    $proposee = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
    $v = (Read-Host "La version $actuelle est déjà en ligne. Nouvelle version (Entrée = $proposee)").Trim()
    if (-not $v) { $v = $proposee }
    if ($v -notmatch '^\d+\.\d+\.\d+$') { throw 'La version doit ressembler à 1.2.3' }
    Ecrire 'package.json' ($pkg -replace '"version":\s*"[^"]+"', "`"version`": `"$v`"")
    $version = $v
  }
  Write-Host "Version : $version"
}

# 3. Jeton GitHub : demandé une seule fois, puis gardé chiffré par Windows (DPAPI) hors du projet.
#    Vérifié tout de suite, avant les minutes de fabrication.
if (-not $Essai -and -not $env:GH_TOKEN) {
  $secret = $null
  if (Test-Path $jetonFichier) {
    try { $secret = (Get-Content $jetonFichier -Raw).Trim() | ConvertTo-SecureString } catch { Remove-Item $jetonFichier -Force -ErrorAction SilentlyContinue }
  }
  $nouveau = $false
  if (-not $secret) {
    if ($Auto) { throw 'Aucun jeton GitHub gardé sur ce PC : double-clique une fois sur publier.cmd pour le donner.' }
    Write-Host "Colle ton jeton GitHub puis Entrée (il ne s'affiche pas, c'est normal)."
    Write-Host "Il sera gardé sur ce PC, chiffré par Windows : tu n'auras plus à le donner." -ForegroundColor DarkGray
    $secret = Read-Host -AsSecureString
    $nouveau = $true
  }
  $env:GH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret))
  try {
    Invoke-RestMethod -Uri $depot -Headers ($entetes + @{ Authorization = "Bearer $env:GH_TOKEN" }) | Out-Null
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $env:GH_TOKEN = $null
    if ($code -eq 401) {
      Remove-Item $jetonFichier -Force -ErrorAction SilentlyContinue
      throw 'GitHub refuse ce jeton (expiré ou supprimé). Crée-en un nouveau, puis relance publier.cmd : il le redemandera.'
    }
    throw "GitHub ne répond pas : $($_.Exception.Message)"
  }
  if ($nouveau) {
    New-Item -ItemType Directory -Force (Split-Path $jetonFichier) | Out-Null
    $secret | ConvertFrom-SecureString | Set-Content -Path $jetonFichier -Encoding ASCII -NoNewline
    Write-Host 'Jeton gardé (chiffré par Windows) : les prochaines publications ne le demanderont plus.' -ForegroundColor Green
  }
}

# 4. Fabrication de l'installeur (dans un dossier au chemin court : l'outil de l'installeur
#    refuse les chemins trop longs).
$dossier = $projet
if ($projet.Length -gt 80) {
  # Dossier temporaire : un dossier placé directement dans AppData\Local fait échouer la compilation.
  $dossier = Join-Path $env:TEMP 'autoclip-pub'
  Write-Host "Copie du projet vers $dossier ..."
  robocopy $projet $dossier /MIR /XD node_modules out dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'La copie du projet a échoué.' }
}
Push-Location $dossier
try {
  Write-Host 'Installation des modules (une à deux minutes la première fois)...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "L'installation des modules a échoué." }
  Write-Host "Fabrication de l'installeur..."
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw "La fabrication de l'installeur a échoué : lis les messages au-dessus." }
} finally {
  Pop-Location
}
$dist = Join-Path $dossier 'dist'
$exe = Join-Path $dist "AutoClip-Setup-$version.exe"
if (-not (Test-Path $exe)) { throw "Installeur introuvable : $exe" }
if ($dossier -ne $projet) {
  New-Item -ItemType Directory -Force (Join-Path $projet 'dist') | Out-Null
  Copy-Item $exe (Join-Path $projet 'dist') -Force
}

if ($Essai) {
  Write-Host ''
  Write-Host "Essai réussi : AutoClip-Setup-$version.exe est dans le dossier dist (rien n'a été publié)." -ForegroundColor Green
  return
}

# 5. Publication sur GitHub : d'abord un brouillon, on y envoie l'installeur puis latest.yml
#    (le fichier que les AutoClip installés lisent pour trouver la mise à jour), et seulement
#    à la fin on rend la version publique. Si une version existe déjà, on la complète.
$auth = $entetes + @{ Authorization = "Bearer $env:GH_TOKEN" }
$tag = "v$version"
$toutes = Invoke-RestMethod -Uri "$depot/releases?per_page=50" -Headers $auth
$release = $toutes | Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1
if (-not $release) {
  $branche = (Invoke-RestMethod -Uri $depot -Headers $auth).default_branch
  $corps = @{ tag_name = $tag; name = $version; target_commitish = $branche; draft = $true } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Post -Uri "$depot/releases" -Headers $auth -Body $corps -ContentType 'application/json'
  Write-Host "Version $version créée (brouillon)."
}
$enPlace = @{}
foreach ($a in @($release.assets)) { if ($a) { $enPlace[$a.name] = $a.id } }
# L'installeur, son .blockmap et latest.yml doivent venir de la même fabrication (latest.yml
# contient l'empreinte de l'installeur) : un fichier déjà en ligne est donc remplacé.
foreach ($fichier in @($exe, "$exe.blockmap", (Join-Path $dist 'latest.yml'))) {
  $nom = Split-Path $fichier -Leaf
  if (-not (Test-Path $fichier)) { throw "Fichier manquant : $fichier" }
  if ($enPlace.ContainsKey($nom)) {
    Write-Host "Remplacement de $nom ..."
    Invoke-RestMethod -Method Delete -Uri "$depot/releases/assets/$($enPlace[$nom])" -Headers $auth | Out-Null
  }
  Write-Host "Envoi de $nom ..."
  $url = "https://uploads.github.com/repos/$owner/autoclip/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($nom))"
  Invoke-RestMethod -Method Post -Uri $url -Headers $auth -InFile $fichier -ContentType 'application/octet-stream' | Out-Null
}
if ($release.draft) {
  Invoke-RestMethod -Method Patch -Uri "$depot/releases/$($release.id)" -Headers $auth -Body (@{ draft = $false } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
}

Write-Host ''
Write-Host "Publié ! Version $version en ligne." -ForegroundColor Green
Write-Host "Page à envoyer à tes amis : https://github.com/$owner/autoclip/releases/latest"
Write-Host 'Ceux qui ont déjà installé AutoClip depuis cette page recevront la mise à jour tout seuls.'
