import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from './config.js';
import { validateProfile } from './model.js';
import { GIF_BUDGET, HEIGHT, render, WIDTH } from './render.js';
import { loadTheme } from './themes.js';
import { buildTimeline } from './scene/timeline.js';

const profile = validateProfile(JSON.parse(await readFile('fixtures/profile.json', 'utf8')));
const config = await loadConfig();

async function exported(theme: string, check: (gif: Buffer, directory: string, result: Awaited<ReturnType<typeof render>>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-test-'));
  try {
    const result = await render(profile, { output: directory, config, theme, preview: true });
    await check(await readFile(path.join(directory, 'fetch.gif')), directory, result);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const page = (gif: Buffer, index: number) => sharp(gif, { page: index }).ensureAlpha().raw().toBuffer();
const crop = (data: Buffer, region: { left: number; top: number; width: number; height: number }) => sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).extract(region).toBuffer();
const near = (data: Buffer, x: number, y: number, hex: string) => [0, 1, 2].every(channel => Math.abs(data[(y * WIDTH + x) * 4 + channel] - parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16)) <= 8);
// Inside the fastfetch window, left of its text: plain terminal background while the window is open.
const terminal = { x: 36, y: 700 };

test('fixed theme export loops within the size budget with steady text', async () => {
  await exported('tokyo-night', async (gif, directory, result) => {
    const metadata = await sharp(gif, { animated: true }).metadata();
    assert.equal(metadata.width, WIDTH); assert.equal(metadata.pageHeight, HEIGHT); assert.equal(metadata.loop, 0);
    assert.ok(metadata.pages! > 40 && metadata.pages! <= result.frames);
    assert.equal(metadata.delay?.reduce((sum, delay) => sum + delay, 0), result.milliseconds);
    assert.equal(gif.length, result.gifBytes);
    assert.ok(gif.length < GIF_BUDGET, `GIF is ${gif.length} bytes`);
    const still = await sharp(path.join(directory, 'fetch.png')).metadata();
    assert.equal(still.width, WIDTH); assert.equal(still.height, HEIGHT);

    // Between two frames of the opening hold only the portrait twinkles; all text stays put.
    const [first, second] = [await page(gif, 0), await page(gif, 1)];
    const text = { left: 540, top: 150, width: 1360, height: 1030 };
    assert.deepEqual(await crop(first, text), await crop(second, text));
    const portrait = { left: 56, top: 150, width: 440, height: 650 };
    assert.notDeepEqual(await crop(first, portrait), await crop(second, portrait));

    // Later the windows close and the wallpaper shows where the terminal was.
    const theme = await loadTheme('tokyo-night');
    const closed = buildTimeline(['tokyo-night']).findIndex(frame => frame.state.open === 0);
    assert.ok(near(first, terminal.x, terminal.y, theme.colors.bg));
    assert.ok(!near(await page(gif, closed), terminal.x, terminal.y, theme.colors.bg));
  });
}, 180_000);

test('cycling export switches palettes per theme and stays within the budget', async () => {
  await exported('cycle', async (gif, _directory, result) => {
    assert.ok(gif.length < GIF_BUDGET, `GIF is ${gif.length} bytes`);
    const timeline = buildTimeline(config.cycle);
    assert.equal(result.frames, timeline.length);
    for (const key of config.cycle) {
      // The hold frames all differ (twinkle), so timeline and GIF frame numbers still agree here.
      const index = timeline.findIndex(frame => frame.state.theme === key);
      const theme = await loadTheme(key);
      assert.ok(near(await page(gif, index), terminal.x, terminal.y, theme.colors.bg), `${key} background at frame ${index}`);
    }
  });
}, 180_000);

test('content that does not fit stops the render instead of being clipped', async () => {
  const crowded = structuredClone(config);
  crowded.sections[1].rows[0].value = 'IT Security · Copenhagen School of Design and Technology';
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-test-'));
  try {
    await assert.rejects(render(profile, { output: directory, config: crowded, preview: true }), new RegExp(`does not fit: row ${crowded.sections[1].rows[0].label}`));
    await assert.rejects(readFile(path.join(directory, 'fetch.gif')));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
