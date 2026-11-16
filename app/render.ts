// Renders the scene frame by frame in headless Chromium and exports fetch.gif and fetch.png.
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { portraitStyles, themeKeys } from './config.js';
import { buildPalette, DeltaGif, type Palette } from './gif.js';
import { loadTheme } from './themes.js';
import type { Profile } from './model.js';
import type { CardConfig, SceneInput } from './scene/types.js';

export const WIDTH = 1920, HEIGHT = 1200;
/** GitHub READMEs load the GIF on every profile visit; refuse to publish a heavy one. */
export const GIF_BUDGET = 3_000_000;
const root = path.resolve(import.meta.dir, '..');
/** Palette sampling takes every Nth pixel of each frame, starting one pixel later per frame. */
const SAMPLE_STRIDE = 23;

export interface RenderOptions {
  output: string;
  config: CardConfig;
  /** A theme key or "cycle"; defaults to the configured theme. */
  theme?: string;
  /** A portrait style or "cycle"; defaults to the configured portrait. */
  portrait?: string;
  preview?: boolean;
}
export interface RenderResult { frames: number; gifBytes: number; milliseconds: number }

export async function render(profile: Profile, { output, config, theme, portrait, preview = false }: RenderOptions): Promise<RenderResult> {
  const themes = await Promise.all(themeKeys(config, theme).map(key => loadTheme(key, path.join(root, 'themes'))));
  const bundle = await Bun.build({ entrypoints: [path.join(root, 'app/scene/main.ts')], target: 'browser', format: 'iife' });
  if (!bundle.success) throw new Error('Scene bundle failed');
  const script = await bundle.outputs[0].text();
  const input: SceneInput = { profile, config, themes, portraits: portraitStyles(config, portrait), preview };

  // CHROMIUM_PATH lets a system browser stand in for Playwright's own download.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    // The page gets the validated snapshot only; it has no credentials and no network.
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, offline: true });
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(root, 'assets/card.html')).href);
    await page.addScriptTag({ content: script });
    const frames = await page.evaluate(sceneInput => window.card.prepare(sceneInput), input);

    // Pass 1: capture every frame as PNG and gather colour samples per theme.
    const captures: Buffer[] = [];
    const samples = new Map<string, Uint8Array[]>();
    for (let index = 0; index < frames.length; index++) {
      const misfits = await page.evaluate(frame => window.card.show(frame), index);
      if (misfits.length) throw new Error(`Card content does not fit: ${[...new Set(misfits)].join(', ')}`);
      const png = await page.screenshot({ type: 'png' });
      captures.push(png);
      const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
      const picked = new Uint8Array(Math.ceil((rgba.length / 4 - index % SAMPLE_STRIDE) / SAMPLE_STRIDE) * 4);
      for (let pixel = index % SAMPLE_STRIDE, target = 0; pixel < rgba.length / 4; pixel += SAMPLE_STRIDE, target += 4) picked.set(rgba.subarray(pixel * 4, pixel * 4 + 4), target);
      samples.set(frames[index].theme, [...(samples.get(frames[index].theme) ?? []), picked]);
    }
    const palettes = new Map<string, Palette>([...samples].map(([key, parts]) => [key, buildPalette(Buffer.concat(parts))]));

    // Pass 2: encode. One palette per theme keeps static pixels identical between frames.
    const gif = new DeltaGif(WIDTH, HEIGHT);
    for (let index = 0; index < frames.length; index++) {
      gif.add(await sharp(captures[index]).ensureAlpha().raw().toBuffer(), frames[index].delay, palettes.get(frames[index].theme)!);
    }
    const bytes = gif.finish();
    if (bytes.length > GIF_BUDGET) throw new Error(`GIF is ${(bytes.length / 1e6).toFixed(2)} MB, over the ${GIF_BUDGET / 1e6} MB budget`);

    // Complete both exports before replacing any previously generated images.
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'fetch.png.tmp'), captures[0]); await writeFile(path.join(output, 'fetch.gif.tmp'), bytes);
    await rename(path.join(output, 'fetch.png.tmp'), path.join(output, 'fetch.png')); await rename(path.join(output, 'fetch.gif.tmp'), path.join(output, 'fetch.gif'));
    return { frames: frames.length, gifBytes: bytes.length, milliseconds: frames.reduce((sum, frame) => sum + frame.delay, 0) };
  } finally { await browser.close(); }
}
