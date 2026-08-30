/**
 * THE RENDERER MUST CARRY ITS OWN FONTS.
 *
 * Netlify's build container ships a font set; its Lambda runtime ships none. So
 * the card generated at build time looked correct while the identical code,
 * running in the on-demand endpoint, drew every single character as a tofu box.
 * That was invisible in the source and invisible in the tests — it was only
 * found by fetching the deployed card and looking at it.
 *
 * Naming fonts we ship removes the dependency on whatever a host happens to
 * have installed, and makes the build-time and on-demand cards identical by
 * construction rather than by luck.
 *
 * The faces are OFL, vendored under `assets/fonts/` with their licences beside
 * them: JetBrains Mono, which production's own CSS already names; Lora, which
 * stands in for the Georgia the site actually renders; and Instrument Sans.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_MONO = 'JetBrains Mono';
export const FONT_SERIF = 'Lora';
export const FONT_SANS = 'Instrument Sans';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The bundle layout differs between the build and a packaged function. */
function findFontDir() {
  const candidates = [
    path.join(process.cwd(), 'assets', 'fonts'),
    path.join(here, '..', '..', '..', 'assets', 'fonts'),
    path.join(here, 'fonts'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.readdirSync(dir).some((f) => f.endsWith('.ttf'))) return dir;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

let configured = false;

/**
 * Point fontconfig at the vendored faces.
 *
 * Must run BEFORE the first render: fontconfig reads its configuration once,
 * when the rasteriser first initialises, and ignores the variable afterwards.
 * Returns whether it succeeded so a caller can say so rather than silently
 * producing boxes.
 */
export function useVendoredFonts() {
  if (configured) return true;
  const fontDir = findFontDir();
  if (!fontDir) return false;

  const cacheDir = path.join(os.tmpdir(), 'ponsr-fontconfig');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const confPath = path.join(cacheDir, 'fonts.conf');
    fs.writeFileSync(
      confPath,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`
    );
    process.env.FONTCONFIG_FILE = confPath;
    process.env.FONTCONFIG_PATH = cacheDir;
    configured = true;
    return true;
  } catch {
    return false;
  }
}
