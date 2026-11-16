// Emplacements des fichiers de l'application.
// Ce module n'importe pas Electron : index.ts l'initialise, ce qui permet de
// tester les autres modules avec Node seul.
import { join } from 'node:path'

let dataRoot = ''
let resourcesRoot = ''

export function configurePaths(opts: { data: string; resources: string }): void {
  dataRoot = opts.data
  resourcesRoot = opts.resources
}

export const dataDir = (): string => dataRoot
export const resourcesDir = (): string => resourcesRoot
export const fontsDir = (): string => join(resourcesRoot, 'fonts')

export const depsDir = (): string => join(dataRoot, 'outils')
export const streamlinkRoot = (): string => join(depsDir(), 'streamlink')
export const whisperRoot = (): string => join(depsDir(), 'whisper')
export const modelsDir = (): string => join(depsDir(), 'modeles')
export const tempDir = (): string => join(dataRoot, 'temp')

export const settingsFile = (): string => join(dataRoot, 'reglages.json')
export const libraryFile = (): string => join(dataRoot, 'clips.json')
export const templatesFile = (): string => join(dataRoot, 'pattes.json')
export const depsFile = (): string => join(dataRoot, 'outils.json')
