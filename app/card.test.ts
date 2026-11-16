import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig, portraitStyles, themeKeys, validateConfig } from './config.js';
import { loadTheme, parseTheme } from './themes.js';
import { buildTimeline, COMMANDS } from './scene/timeline.js';
import { PORTRAIT_STYLES } from './scene/types.js';

test('committed config is valid and every theme it names loads', async () => {
  const config = await loadConfig();
  assert.deepEqual(themeKeys(config), config.theme === 'cycle' ? config.cycle : [config.theme]);
  assert.deepEqual(themeKeys(config, 'cycle'), config.cycle);
  assert.deepEqual(themeKeys(config, 'nord'), ['nord']);
  for (const key of new Set([...themeKeys(config), ...config.cycle])) {
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

test('portrait is one of the known styles or cycle, in config and as an override', async () => {
  const raw = JSON.parse(await readFile('config.json', 'utf8'));
  const config = await loadConfig();
  assert.deepEqual(portraitStyles(config), config.portrait === 'cycle' ? [...PORTRAIT_STYLES] : [config.portrait]);
  for (const style of PORTRAIT_STYLES) {
    assert.equal(validateConfig({ ...raw, portrait: style }).portrait, style);
    assert.deepEqual(portraitStyles(config, style), [style]);
  }
  assert.equal(validateConfig({ ...raw, portrait: 'cycle' }).portrait, 'cycle');
  assert.deepEqual(portraitStyles(config, 'cycle'), [...PORTRAIT_STYLES]);
  for (const bad of ['ascii', '', 7, undefined, ['mono']]) assert.throws(() => validateConfig({ ...raw, portrait: bad }), /portrait \(use blocks, color, matrix, mono or cycle\)/);
  assert.throws(() => portraitStyles(config, 'sepia'), /portrait/);
});

test('timeline starts on the finished card and replays the session', () => {
  const frames = buildTimeline(['tokyo-night'], ['blocks']);
  const first = frames[0].state;
  assert.equal(first.open, 3);
  assert.equal(first.toast, false);
  for (const command of ['fetch', 'stats', 'top', 'heat'] as const) assert.deepEqual(first[command], { typed: COMMANDS[command].length, output: 1 });
  assert.ok(frames.some(frame => frame.state.open === 0), 'windows close to show the wallpaper');
  // The last frame equals the first, so the loop is seamless.
  assert.deepEqual(frames.at(-1)!.state, first);
  // The portrait idles during the holds and is at rest while the session replays.
  assert.ok(frames.some(frame => frame.state.tick > 0) && frames.every(frame => frame.state.tick === 0 || (frame.state.open === 3 && frame.state.fetch.output === 1)));
  assert.ok(frames.every(frame => frame.delay >= 20 && frame.delay % 10 === 0), 'GIF delays are whole centiseconds');
});

test('cycling visits every theme once and announces each change', () => {
  const themes = ['tokyo-night', 'catppuccin', 'gruvbox'];
  const frames = buildTimeline(themes, ['mono']);
  const order = frames.map(frame => frame.state.theme).filter((theme, index, all) => theme !== all[index - 1]);
  assert.deepEqual(order, [...themes, themes[0]]);
  assert.equal(frames[0].state.toast, false);
  assert.ok(frames.find(frame => frame.state.theme === 'gruvbox')!.state.toast);
  assert.ok(frames.filter(frame => frame.state.open < 3).every(frame => frame.state.theme === themes[0]), 'the replay runs in the first theme');
  assert.ok(frames.every(frame => frame.state.portrait === 'mono'));
  assert.throws(() => buildTimeline([], ['mono']));
  assert.throws(() => buildTimeline(themes, []));
});

test('themes and portrait styles step together, each wrapping around', () => {
  const looks = (themes: string[], portraits: Parameters<typeof buildTimeline>[1]) => buildTimeline(themes, portraits)
    .filter(frame => frame.state.open === 3 && frame.state.fetch.output === 1)
    .map(frame => `${frame.state.theme}/${frame.state.portrait}`).filter((look, index, all) => look !== all[index - 1]);
  assert.deepEqual(looks(['a', 'b', 'c'], ['mono', 'color']), ['a/mono', 'b/color', 'c/mono', 'a/mono']);
  assert.deepEqual(looks(['a'], ['mono', 'color', 'blocks']), ['a/mono', 'a/color', 'a/blocks', 'a/mono']);
  // A style change without a theme change is not announced as a theme change.
  assert.ok(buildTimeline(['a'], ['mono', 'color']).every(frame => !frame.state.toast));
});
