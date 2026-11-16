// The desktop as HTML: a pure function of the input data and one animation state.
import { icon } from '../icons.js';
import { HEATMAP_WEEKS } from '../model.js';
import { COMMANDS } from './timeline.js';
import type { SceneInput, State, Theme } from './types.js';

const DAY = 86_400_000;
const esc = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const hide = (hidden: boolean) => (hidden ? ' hid' : '');
const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3);
/** Thousands separators, switching to millions before the figure outgrows its tile. */
export const formatCount = (value: number) => (value >= 10_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value.toLocaleString('en-US'));

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat colour bands and ridgelines: reads as a wallpaper and survives a 256-colour palette. */
const wallpaper = (() => {
  const random = seeded(11);
  const bands = Array.from({ length: 12 }, (_, index) => `<rect x="0" y="${index * 100}" width="1920" height="101" style="fill:color-mix(in oklab,var(--glow) ${Math.round(Math.pow(index / 11, 1.5) * 100)}%,var(--sky))"/>`);
  const stars = Array.from({ length: 110 }, () => {
    const size = random() < 0.2 ? 5 : 3;
    return `<rect x="${Math.round(random() * 1920)}" y="${Math.round(random() * 640)}" width="${size}" height="${size}" style="fill:var(--fgBright);opacity:${(0.25 + random() * 0.6).toFixed(2)}"/>`;
  });
  const ridge = (base: number, amplitude: number, seed: number, mix: number, step: number) => {
    const next = seeded(seed);
    const points = ['0,1200'];
    for (let x = 0; x <= 1920; x += step) points.push(`${x},${Math.round(base + (next() - 0.5) * amplitude + Math.sin(x / 300 + seed) * amplitude * 0.7)}`);
    return `<polygon points="${points.join(' ')} 1920,1200" style="fill:color-mix(in oklab,var(--glow) ${mix}%,var(--bgDarker))"/>`;
  };
  return `<svg class="wall" viewBox="0 0 1920 1200" preserveAspectRatio="none">${bands.join('')}${stars.join('')}`
    + '<circle cx="600" cy="790" r="210" style="fill:color-mix(in oklab,var(--orange) 75%,var(--yellow))"/>'
    + ridge(820, 150, 3, 62, 80) + ridge(900, 130, 8, 42, 60) + ridge(990, 110, 5, 24, 50) + ridge(1090, 80, 9, 8, 40) + '</svg>';
})();

type Cursor = 'solid' | 'hollow' | 'none';
function prompt(command: string, typed: number, cursor: Cursor): string {
  const split = command.indexOf(' --');
  const shown = command.slice(0, typed);
  const text = split < 0 || typed <= split ? esc(shown) : `${esc(shown.slice(0, split))}<span class="dim">${esc(shown.slice(split))}</span>`;
  return `<div class="prompt"><span class="dir">~</span> <span class="chevron">${icon('chevron')}</span> <span class="bright">${text}</span>${cursor === 'none' ? '' : `<span class="cursor ${cursor}"></span>`}</div>`;
}

function clock(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

function bar(input: SceneInput): string {
  const workspaces = [1, 2, 3, 4, 5].map(number => `<span class="ws${number === 1 ? ' on' : ''}">${number}</span>`).join('');
  const tray = (['chip', 'bluetooth', 'wifi', 'volume', 'battery'] as const).map(name => `<span>${icon(name)}</span>`).join('');
  return `<div class="bar"><div class="left"><span class="logo">${icon('arch')}</span>${workspaces}</div><div class="center">${esc(clock(input.profile.collectedAt, input.config.timezone))}</div><div class="right">${tray}</div></div>`;
}

function fetchWindow(input: SceneInput, state: State, theme: Theme, art: { width: number; height: number }, cursor: (active: boolean) => Cursor): string {
  const { profile, config, preview } = input;
  const { fetch, stats } = state;
  const lines = [
    `<h1 data-fit="title">${esc(profile.username.toLowerCase())}<i>@</i>${esc(config.host)}</h1>`,
    '<div class="rule"></div>',
    ...config.sections.flatMap((section, index) => [
      ...(index ? ['<div class="gap"></div>'] : []),
      ...section.rows.map(row => `<div class="row"><span class="i ${section.color}">${icon(row.icon)}</span><span class="k ${section.color}" data-fit="label ${esc(row.label)}">${esc(row.label)}</span><span class="v" data-fit="row ${esc(row.label)}">${esc(row.value.replaceAll('{theme}', theme.name))}</span></div>`),
    ]),
  ];
  const revealed = Math.ceil(fetch.output * lines.length);
  const dots = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'fgBright'].map(color => `<span style="background:var(--${color})"></span>`).join('');
  const figures: [Parameters<typeof icon>[0], string, number, string][] = [['code', 'LOC', profile.totalLines, 'magenta'], ['commit', 'Commits', profile.commits, 'blue'], ['repo', 'Repos', profile.publicRepos, 'green'], ['star', 'Stars', profile.stars, 'yellow']];
  const tiles = figures.map(([name, label, value, color]) => `<div class="tile"><div class="n" data-fit="tile ${label}">${formatCount(Math.round(value * easeOut(stats.output)))}</div><div class="t ${color}">${icon(name)}&nbsp; ${label}</div></div>`).join('');
  const note = preview ? '# local preview · illustrative values from fixtures' : '# LOC + commits span public and private repos · totals only · updated daily';
  return `<div class="win a${state.focus === 0 ? ' on' : ''}" data-fit="terminal window">
    ${prompt(COMMANDS.fetch, fetch.typed, cursor(fetch.output === 0))}
    <div class="fetch${hide(fetch.output === 0)}">
      <div class="art"><canvas id="portrait" style="width:${art.width}px;height:${art.height}px"></canvas><div class="dots${hide(fetch.output < 1)}">${dots}</div></div>
      <div class="rows">${lines.map((line, index) => (index < revealed ? line : `<div class="hid">${line}</div>`)).join('')}</div>
    </div>
    <div class="block${hide(fetch.output < 1)}">${prompt(COMMANDS.stats, stats.typed, cursor(stats.output === 0))}</div>
    <div class="tiles${hide(stats.output === 0)}">${tiles}</div>
    <div class="${hide(stats.output < 1).trim()}"><div class="note dim" data-fit="note">${esc(note)}</div>${prompt('', 0, cursor(true))}</div>
  </div>`;
}

const LANGUAGE_COLORS = ['blue', 'orange', 'red', 'yellow', 'green', 'cyan'];
function topWindow(input: SceneInput, state: State, cursor: (active: boolean) => Cursor): string {
  const { activity, languages } = input.profile;
  const { top } = state;
  if (top.output === 0) return `<div class="win b${state.focus === 1 ? ' on' : ''}">${prompt(COMMANDS.top, top.typed, cursor(true))}</div>`;
  const settled = top.output === 1;
  const growth = Math.min(1, top.output * 1.25);
  const widest = Math.max(1, ...languages.map(language => language.percent));
  const bars = languages.map((language, index) => `<div class="lang" style="--c:var(--${language.name === 'other' ? 'dim' : LANGUAGE_COLORS[index % LANGUAGE_COLORS.length]})"><span class="name">${esc(language.name)}</span><span class="meter"><i style="width:${(language.percent / widest * growth * 100).toFixed(1)}%"></i></span><span class="p${hide(!settled)}">${language.percent}%</span></div>`).join('');
  const figure = (label: string, value: string) => `<span><span class="dim">${label}</span> <b class="bright${hide(!settled)}">${value}</b></span>`;
  return `<div class="win b tui${state.focus === 1 ? ' on' : ''}" data-fit="monitor window">
    <div class="box" style="--c:var(--green)"><span class="title"><sup>1</sup>${activity.source}</span><span class="aside">52w</span>
      <canvas id="graph"></canvas>
      <div class="kv">${figure('year', formatCount(activity.total))}${figure('streak', `${activity.streak}d`)}${figure('best', `${activity.longestStreak}d`)}</div>
    </div>
    <div class="box" style="--c:var(--magenta)"><span class="title"><sup>2</sup>languages</span><span class="aside">by LOC</span>${bars}</div>
  </div>`;
}

function age(from: string, to: string): string {
  const start = new Date(from), end = new Date(to);
  const months = Math.max(0, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() - (end.getUTCDate() < start.getUTCDate() ? 1 : 0));
  return `${Math.floor(months / 12)}y ${months % 12}m`;
}

function heatWindow(input: SceneInput, state: State, cursor: (active: boolean) => Cursor): string {
  const { activity, collectedAt, createdAt } = input.profile;
  const { heat } = state;
  const shownColumns = Math.ceil(heat.output * HEATMAP_WEEKS);
  const shade = (level: number) => (level ? `color-mix(in oklab,var(--green) ${[0, 28, 50, 75, 100][level]}%,var(--bgLight))` : 'var(--bgLight)');
  const cells = activity.levels.map((level, index) => `<i${index >= shownColumns * 7 ? ' class="hid"' : ''} style="background:${shade(level)}"></i>`).join('');
  // The last column is the current week; its Monday anchors the month labels.
  const end = new Date(collectedAt);
  const lastMonday = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - (activity.levels.length - (HEATMAP_WEEKS - 1) * 7 - 1) * DAY;
  const monthOf = (column: number) => new Date(lastMonday - (HEATMAP_WEEKS - 1 - column) * 7 * DAY).getUTCMonth();
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let months = '';
  for (let column = 0; column < HEATMAP_WEEKS; column++) {
    const starts = column === 0 ? monthOf(1) === monthOf(0) && monthOf(2) === monthOf(0) : monthOf(column) !== monthOf(column - 1);
    if (starts && column < HEATMAP_WEEKS - 1) months += `<span style="left:${column * 25}px">${names[monthOf(column)]}</span>`;
  }
  const legend = [0, 1, 2, 3, 4].map(level => `<i style="background:${shade(level)}"></i>`).join('');
  return `<div class="win c${state.focus === 2 ? ' on' : ''}" data-fit="heatmap window">
    ${prompt(COMMANDS.heat, heat.typed, cursor(heat.output === 0))}
    <div class="${hide(heat.output === 0).trim()}">
      <div class="heat">${cells}</div>
      <div class="months dim">${months}</div>
      <div class="legend dim"><span>less</span>${legend}<span>more</span></div>
    </div>
    <div class="facts${hide(heat.output < 1)}">
      <div data-fit="uptime"><span class="cyan">${icon('clock')} uptime</span> <span class="bright">on GitHub since ${new Date(createdAt).getUTCFullYear()} · ${age(createdAt, collectedAt)}</span></div>
      <div data-fit="streak"><span class="orange">${icon('flame')} streak</span> <span class="bright">${activity.streak} ${activity.streak === 1 ? 'day' : 'days'} · longest ${activity.longestStreak}</span></div>
      ${prompt('', 0, cursor(true))}
    </div>
  </div>`;
}

/** `art` is the size the portrait will be drawn at, so the layout can make room before it is painted. */
export function view(input: SceneInput, state: State, art: { width: number; height: number }): string {
  const theme = input.themes.find(candidate => candidate.key === state.theme);
  if (!theme) throw new Error(`Unknown theme: ${state.theme}`);
  const tokens = Object.entries(theme.colors).map(([token, value]) => `--${token}:${value}`).join(';');
  const cursorFor = (window: State['focus']) => (active: boolean): Cursor => (!active ? 'none' : state.focus !== window ? 'hollow' : state.cursor ? 'solid' : 'none');
  const windows = [() => fetchWindow(input, state, theme, art, cursorFor(0)), () => topWindow(input, state, cursorFor(1)), () => heatWindow(input, state, cursorFor(2))];
  const toast = state.toast ? `<div class="toast"><span class="accent">${icon('brush')}</span><div><b class="bright">Theme changed</b><div>${esc(theme.name)}</div></div></div>` : '';
  return `<div class="desk" style="${tokens}">${wallpaper}${bar(input)}<div class="workspace open-${state.open}">${windows.slice(0, state.open).map(render => render()).join('')}</div>${toast}</div>`;
}
