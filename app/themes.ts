// Loads themes/<key>.toml, which use the schema of Omarchy's colors.toml.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { COLOR_TOKENS, type ColorToken, type Theme } from './scene/types.js';

const SOURCE: Record<ColorToken, string> = {
  bg: 'background', bgDark: 'dark_background', bgDarker: 'darker_background', bgLight: 'lighter_background',
  selection: 'selection', muted: 'muted', fg: 'foreground', fgBright: 'bright_foreground', accent: 'accent',
  red: 'red', yellow: 'yellow', orange: 'orange', green: 'green', cyan: 'cyan', blue: 'blue', magenta: 'magenta',
};

export function parseTheme(key: string, toml: string): Theme {
  const data = Bun.TOML.parse(toml) as Record<string, unknown>;
  if (typeof data.name !== 'string' || !data.name) throw new Error(`Theme ${key} has no name`);
  const colors = Object.fromEntries(COLOR_TOKENS.map(token => {
    const value = data[SOURCE[token]];
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Theme ${key} has no valid ${SOURCE[token]} colour`);
    return [token, value.toLowerCase()];
  })) as Record<ColorToken, string>;
  return { key, name: data.name, colors };
}

export async function loadTheme(key: string, directory = 'themes'): Promise<Theme> {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Invalid theme name: ${key}`);
  let toml: string;
  try { toml = await readFile(path.join(directory, `${key}.toml`), 'utf8'); } catch { throw new Error(`Unknown theme: ${key}`); }
  return parseTheme(key, toml);
}
