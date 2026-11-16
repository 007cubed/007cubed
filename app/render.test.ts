import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig, portraitStyles } from './config.js';
import { validateProfile } from './model.js';
import { GIF_BUDGET, HEIGHT, render, WIDTH, type RenderOptions } from './render.js';
import { loadTheme } from './themes.js';
import { buildTimeline } from './scene/timeline.js';
import { PORTRAIT_STYLES, type Frame } from './scene/types.js';

const profile = validateProfile(JSON.parse(await readFile('fixtures/profile.json', 'utf8')));
const config = await loadConfig();
const RENDER_TIMEOUT = 240_000;

// All frames of a cycling GIF together exceed sharp's default pixel limit.
const animated = (gif: Buffer) => sharp(gif, { animated: true, limitInputPixels: false });
interface Exported { gif: Buffer; directory: string; frames: number; milliseconds: number; delays: number[] }
async function exported(options: Pick<RenderOptions, 'theme' | 'portrait'>, check: (result: Exported) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-test-'));
  try {
    const result = await render(profile, { output: directory, config, preview: true, ...options });
    const gif = await readFile(path.join(directory, 'fetch.gif'));
    assert.equal(gif.length, result.gifBytes);
    assert.ok(gif.length < GIF_BUDGET, `GIF is ${gif.length} bytes`);
    await check({ gif, directory, frames: result.frames, milliseconds: result.milliseconds, delays: (await animated(gif).metadata()).delay ?? [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
/** The GIF frame on screen when a timeline frame starts. Identical neighbours are merged in the GIF, so the numbers differ. */
function pageFor({ gif, delays }: Exported, timeline: Frame[], index: number) {
  const start = timeline.slice(0, index).reduce((sum, frame) => sum + frame.delay, 0);
  let elapsed = 0;
  const page = delays.findIndex(delay => (elapsed += delay) > start);
  return sharp(gif, { page }).ensureAlpha().raw().toBuffer();
}
type Region = { left: number; top: number; width: number; height: number };
const crop = (data: Buffer, region: Region) => sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).extract(region).toBuffer();
const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const near = (data: Buffer, x: number, y: number, hex: string) => rgb(hex).every((value, channel) => Math.abs(data[(y * WIDTH + x) * 4 + channel] - value) <= 8);
const linear = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (red: number, green: number, blue: number) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
/** WCAG contrast of every pixel in a region against a background colour. */
function contrasts(data: Buffer, region: Region, background: string): number[] {
  const [r, g, b] = rgb(background), base = luminance(r, g, b);
  const values: number[] = [];
  for (let y = region.top; y < region.top + region.height; y++) for (let x = region.left; x < region.left + region.width; x++) {
    const offset = (y * WIDTH + x) * 4, value = luminance(data[offset], data[offset + 1], data[offset + 2]);
    values.push((Math.max(value, base) + 0.05) / (Math.min(value, base) + 0.05));
  }
  return values;
}
// Inside the fastfetch window, left of its text: plain terminal background while the window is open.
const terminal = { x: 36, y: 700 };
const text: Region = { left: 540, top: 150, width: 1360, height: 1030 };
const portrait: Region = { left: 56, top: 150, width: 440, height: 650 };

test('fixed theme export loops with steady text and a moving portrait', async () => {
  await exported({ theme: 'tokyo-night' }, async result => {
    const metadata = await animated(result.gif).metadata();
    assert.equal(metadata.width, WIDTH); assert.equal(metadata.pageHeight, HEIGHT); assert.equal(metadata.loop, 0);
    assert.ok(metadata.pages! > 40 && metadata.pages! <= result.frames);
    assert.equal(result.delays.reduce((sum, delay) => sum + delay, 0), result.milliseconds);
    const still = await sharp(path.join(result.directory, 'fetch.png')).metadata();
    assert.equal(still.width, WIDTH); assert.equal(still.height, HEIGHT);

    // During the opening hold a light sweep crosses the portrait; all text stays put.
    const timeline = buildTimeline(['tokyo-night'], portraitStyles(config));
    const sweeping = timeline.findIndex(frame => frame.state.sweep > 0.3 && frame.state.cursor);
    const [first, swept] = [await pageFor(result, timeline, 0), await pageFor(result, timeline, sweeping)];
    assert.deepEqual(await crop(first, text), await crop(swept, text));
    assert.notDeepEqual(await crop(first, portrait), await crop(swept, portrait));

    // Later the windows close and the wallpaper shows where the terminal was.
    const theme = await loadTheme('tokyo-night');
    const closed = timeline.findIndex(frame => frame.state.open === 0);
    assert.ok(near(first, terminal.x, terminal.y, theme.colors.bg));
    assert.ok(!near(await pageFor(result, timeline, closed), terminal.x, terminal.y, theme.colors.bg));
  });
}, RENDER_TIMEOUT);

for (const style of PORTRAIT_STYLES) {
  test(`${style} portrait cycles through every theme within the budget and stays readable`, async () => {
    await exported({ theme: 'cycle', portrait: style }, async result => {
      const timeline = buildTimeline(config.cycle, [style]);
      assert.equal(result.frames, timeline.length);
      for (const key of config.cycle) {
        const theme = await loadTheme(key);
        const frame = await pageFor(result, timeline, timeline.findIndex(candidate => candidate.state.theme === key));
        assert.ok(near(frame, terminal.x, terminal.y, theme.colors.bg), `${key} background`);
        // The subject must stand out from the terminal: a solid share of clearly lit pixels.
        const lit = contrasts(frame, portrait, theme.colors.bg);
        assert.ok(Math.max(...lit) >= 4.5, `${style} on ${key}: brightest contrast ${Math.max(...lit).toFixed(1)}`);
        const share = lit.filter(value => value >= 3).length / lit.length;
        assert.ok(share >= 0.03, `${style} on ${key}: only ${(share * 100).toFixed(1)}% of the portrait area is clearly lit`);
      }
    });
  }, RENDER_TIMEOUT);
}

test('themes and portrait styles cycling together stay within the budget', async () => {
  await exported({ theme: 'cycle', portrait: 'cycle' }, async result => {
    const timeline = buildTimeline(config.cycle, [...PORTRAIT_STYLES]);
    assert.equal(result.frames, timeline.length);
    // Two looks in different styles differ in more than colour: compare where each one is lit.
    const shape = async (index: number) => {
      const state = timeline[index].state;
      const lit = contrasts(await pageFor(result, timeline, index), portrait, (await loadTheme(state.theme)).colors.bg);
      return lit.map(value => value >= 3);
    };
    const [one, two] = [await shape(0), await shape(timeline.findIndex(frame => frame.state.portrait !== timeline[0].state.portrait))];
    assert.ok(one.filter((value, index) => value !== two[index]).length > one.length * 0.02);
  });
}, RENDER_TIMEOUT);

test('content that does not fit stops the render instead of being clipped', async () => {
  const crowded = structuredClone(config);
  crowded.sections[1].rows[0].value = 'IT Security · Copenhagen School of Design and Technology';
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-test-'));
  try {
    await assert.rejects(render(profile, { output: directory, config: crowded, preview: true }), new RegExp(`does not fit: row ${crowded.sections[1].rows[0].label}`));
    await assert.rejects(readFile(path.join(directory, 'fetch.gif')));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test('an unknown portrait style is refused before anything is rendered', async () => {
  await assert.rejects(render(profile, { output: tmpdir(), config, portrait: 'sepia', preview: true }), /portrait \(use blocks, color, matrix, mono or cycle\)/);
});
