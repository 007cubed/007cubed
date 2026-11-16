import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { collect } from './collect.js';
import { loadConfig } from './config.js';
import { render } from './render.js';
import { validateProfile } from './model.js';

const [command, ...flags] = process.argv.slice(2);
const flag = (name: string) => flags.find(entry => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  if (!['collect', 'render', 'preview', 'update'].includes(command) || flags.some(entry => !/^--(theme|out)=.+/.test(entry))) {
    throw new Error('Use collect, render, preview, or update [--theme=<name|cycle>] [--out=<directory>]');
  }
  let profile;
  if (command === 'collect' || command === 'update') {
    profile = await collect(process.env.GH_TOKEN ?? '');
    await mkdir('.cache', { recursive: true }); await writeFile('.cache/profile.json.tmp', JSON.stringify(profile, null, 2)); await rename('.cache/profile.json.tmp', '.cache/profile.json');
    console.log('Aggregate snapshot collected successfully');
  }
  if (command === 'collect') process.exit(0);
  const preview = command === 'preview';
  if (!profile) {
    const snapshot = preview ? 'fixtures/profile.json' : '.cache/profile.json';
    profile = validateProfile(JSON.parse(await readFile(snapshot, 'utf8').catch(() => { throw new Error(`No snapshot at ${snapshot}; run collect first`); })));
  }
  const output = flag('out') ?? (preview ? 'out/preview' : 'out');
  const result = await render(profile, { output, config: await loadConfig(), theme: flag('theme'), preview });
  console.log(`${preview ? 'Preview ready' : 'Profile exported'}: ${output}/fetch.gif (${result.frames} frames, ${(result.milliseconds / 1000).toFixed(1)} s loop, ${(result.gifBytes / 1e6).toFixed(2)} MB)`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Profile update failed'); process.exitCode = 1; }
