// Réglages d'encodage du rendu final. La très bonne qualité est imposée : le clip vertical agrandit
// l'image du live (×1,1 pour le jeu, jusqu'à ×3 pour une petite caméra), chaque détail perdu à
// l'encodage se voit. Qualité constante : le débit monte dans les passages qui bougent (jusqu'à
// 40 Mb/s) au lieu d'être limité à 12 Mb/s.
// Mesuré sur un vrai clip Rocket League (caméra + jeu, 1080x1920, 60 i/s), comparé au même
// recadrage sans perte : NVENC 47,1 dB / SSIM 0,994 (avant : 43,7 dB / 0,985).

export function encoderArgs(enc: string): string[] {
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-maxrate', '40M', '-bufsize', '80M', '-spatial-aq', '1', '-profile:v', 'high', '-pix_fmt', 'yuv420p']
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryslow', '-global_quality', '18', '-profile:v', 'high', '-pix_fmt', 'nv12']
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', '25M', '-maxrate', '40M', '-bufsize', '80M', '-profile:v', 'high', '-pix_fmt', 'nv12']
    default:
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high']
  }
}
