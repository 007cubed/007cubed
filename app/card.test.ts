import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig, themeKeys, validateConfig } from './config.js';
import { loadTheme, parseTheme } from './themes.js';
import { buildTimeline, COMMANDS } from './scene/timeline.js';

test('committed config is valid and every theme it names loads', async () => {
  const config = await loadConfig();
  assert.deepEqual(themeKeys(config), [config.theme]);
  assert.deepEqual(themeKeys(config, 'cycle'), config.cycle);
  assert.deepEqual(themeKeys(config, 'nord'), ['nord']);
  for (const key of new Set([config.theme, ...config.cycle])) {
    const theme = await loadTheme(key);
    assert.ok(theme.name);
    assert.match(theme.colors.accent, /^#[0-9a-f]{6}$/);
  }
  await assert.rejects(loadTheme('no-such-theme'), /Unknown theme/);
  await assert.rejects(loadTheme('../config'), /Invalid theme name/);
  assert.throws(() => parseTheme('broken', 'name = "Broken"\nbackground = "blue"'), /no valid/);
});

test('config rejects unknown icons, colours and shapes', async () => {
  const config = JSON.parse(await readFile('config.json', 'utf8'));
  const withRow = (row: object) => ({ ...config, sections: [{ color: 'blue', rows: [{ icon: 'arch', label: 'OS', value: 'Omarchy', ...row }] }] });
  assert.throws(() => validateConfig(withRow({ icon: 'nope' })), /row icon "nope"/);
  assert.throws(() => validateConfig(withRow({ value: '' })), /row value/);
  assert.throws(() => validateConfig({ ...config, sections: [{ color: 'beige', rows: config.sections[0].rows }] }), /sections.color/);
  assert.throws(() => validateConfig({ ...config, timezone: 'Mars/Olympus' }), /timezone/);
  assert.throws(() => validateConfig({ ...config, cycle: [] }), /cycle/);
});

test('timeline starts on the finished card and replays the session', () => {
  const frames = buildTimeline(['tokyo-night']);
  const first = frames[0].state;
  assert.equal(first.open, 3);
  assert.equal(first.toast, false);
  for (const command of ['fetch', 'stats', 'top', 'heat'] as const) assert.deepEqual(first[command], { typed: COMMANDS[command].length, output: 1 });
  assert.ok(frames.some(frame => frame.state.open === 0), 'windows close to show the wallpaper');
  // The last frame equals the first apart from the portrait twinkle, so the loop is seamless.
  assert.deepEqual({ ...frames.at(-1)!.state, tick: 0 }, first);
  assert.ok(frames.every(frame => frame.delay >= 20 && frame.delay % 10 === 0), 'GIF delays are whole centiseconds');
});

test('cycling visits every theme once and announces each change', () => {
  const themes = ['tokyo-night', 'catppuccin', 'gruvbox'];
  const frames = buildTimeline(themes);
  const order = frames.map(frame => frame.state.theme).filter((theme, index, all) => theme !== all[index - 1]);
  assert.deepEqual(order, [...themes, themes[0]]);
  assert.equal(frames[0].state.toast, false);
  assert.ok(frames.find(frame => frame.state.theme === 'gruvbox')!.state.toast);
  assert.ok(frames.filter(frame => frame.state.open < 3).every(frame => frame.state.theme === themes[0]), 'the replay runs in the first theme');
  assert.throws(() => buildTimeline([]));
});
