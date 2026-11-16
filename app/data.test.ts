import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProfile } from './model.js';
import { archiveTarget, readCloc } from './collect.js';
import { languageShare, summarizeActivity } from './stats.js';

const sample = JSON.parse(await readFile('fixtures/profile.json', 'utf8'));

test('snapshot publishes only allowed aggregate fields', () => {
  const profile = validateProfile({
    ...sample,
    privateRepositories: ['secret'], privateLines: 123, token: 'never-publish',
    languages: sample.languages.map((language: object) => ({ ...language, repositories: ['secret'] })),
    activity: { ...sample.activity, days: [{ date: '2026-10-30', repository: 'secret' }] },
  });
  assert.equal(JSON.stringify(profile).includes('secret'), false);
  assert.equal('token' in profile, false);
  assert.deepEqual(Object.keys(profile).sort(), ['activity', 'avatar', 'collectedAt', 'commits', 'createdAt', 'languages', 'publicRepos', 'stars', 'totalLines', 'username']);
  assert.deepEqual(Object.keys(profile.activity).sort(), ['levels', 'longestStreak', 'source', 'streak', 'total', 'weeks']);
  assert.deepEqual(Object.keys(profile.languages[0]).sort(), ['name', 'percent']);
  assert.deepEqual(validateProfile(sample), sample);
});

test('snapshot rejects malformed values in every published field', () => {
  const invalid: Record<string, unknown>[] = [
    { totalLines: -1 }, { totalLines: '123' }, { stars: 1.5 },
    { username: 'not a login!' }, { avatar: 'https://example.com/avatar.png' },
    { createdAt: 'yesterday' }, { collectedAt: 42 },
    { languages: 'TypeScript' }, { languages: [{ name: '<script>', percent: 10 }] }, { languages: [{ name: 'Go', percent: 101 }] },
    { languages: Array.from({ length: 7 }, () => ({ name: 'Go', percent: 1 })) },
    { activity: undefined }, { activity: { ...sample.activity, source: 'private' } },
    { activity: { ...sample.activity, weeks: sample.activity.weeks.slice(1) } },
    { activity: { ...sample.activity, levels: sample.activity.levels.map(() => 5) } },
    { activity: { ...sample.activity, streak: -1 } },
  ];
  for (const change of invalid) assert.throws(() => validateProfile({ ...sample, ...change }), /Invalid snapshot field/, JSON.stringify(change).slice(0, 80));
});

test('archive paths cannot escape the temporary workspace', () => {
  const root = path.resolve('temporary-source');
  for (const entry of ['../escape', '/absolute', 'folder/../../escape', 'folder\\escape']) assert.throws(() => archiveTarget(root, entry));
  assert.equal(archiveTarget(root, 'snapshot/src/index.ts'), path.join(root, 'snapshot', 'src', 'index.ts'));
});

test('cloc reports reduce to a total and per-language lines', () => {
  const report = { header: { n_files: 3 }, TypeScript: { nFiles: 2, blank: 1, comment: 2, code: 120 }, JSON: { code: 30 }, SUM: { code: 150 } };
  assert.deepEqual(readCloc(report), { lines: 150, languages: { TypeScript: 120, JSON: 30 } });
  assert.deepEqual(readCloc({}), { lines: 0, languages: {} });
  assert.throws(() => readCloc({ SUM: { code: -5 } }));
});

test('language share is percentages only: code languages, top five, summing to 100', () => {
  const share = languageShare({ TypeScript: 500, JSON: 9000, Markdown: 4000, 'Bourne Shell': 60, 'Bourne Again Shell': 40, Astro: 200, Svelte: 100, Python: 50, Go: 30, Rust: 20, 'Windows Module Definition (x)': 0 });
  assert.deepEqual(share.map(language => language.name), ['TypeScript', 'Astro', 'Shell', 'Svelte', 'Python', 'other']);
  assert.equal(share.reduce((sum, language) => sum + language.percent, 0), 100);
  assert.deepEqual(share[0], { name: 'TypeScript', percent: 50 });
  assert.deepEqual(languageShare({ JSON: 10 }), []);
  // Whatever cloc calls a language, the label must pass the public allowlist.
  const odd = languageShare({ 'Windows Module Definition (x64)': 10, '<b>': 5, 'C++': 5 });
  assert.deepEqual(validateProfile({ ...sample, languages: odd }).languages, odd);
  assert.ok(odd.every(language => language.name.length <= 12));
});

test('activity is reduced to weekly totals, coarse levels and streaks', () => {
  // 2026-10-28 is a Wednesday, so the current week holds three days.
  const daily = new Array<number>(400).fill(0);
  daily.splice(-10, 10, 2, 0, 1, 1, 1, 9, 0, 3, 4, 0);
  const activity = summarizeActivity(daily, '2026-10-28', 'commits');
  assert.equal(activity.source, 'commits');
  assert.equal(activity.weeks.length, 52);
  assert.equal(activity.levels.length, 25 * 7 + 3);
  assert.deepEqual(activity.weeks.slice(-2), [2 + 0 + 1 + 1 + 1 + 9 + 0, 3 + 4 + 0]);
  assert.equal(activity.total, 21);
  assert.equal(activity.streak, 2, 'a quiet today does not end the streak');
  assert.equal(activity.longestStreak, 4);
  assert.deepEqual(activity.levels.slice(-10), [2, 0, 1, 1, 1, 4, 0, 3, 3, 0]);
  assert.ok(activity.levels.every(level => level >= 0 && level <= 4));
  assert.deepEqual(validateProfile({ ...sample, activity }).activity, activity);
  // Short histories are padded rather than misaligned.
  assert.equal(summarizeActivity([1, 1], '2026-10-28', 'contributions').streak, 2);
});
