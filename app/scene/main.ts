// Browser entry point. It receives the validated snapshot and never touches the network.
import { loadPortrait, type Portrait } from './portrait.js';
import { buildTimeline } from './timeline.js';
import { view } from './view.js';
import type { Frame, SceneInput, State } from './types.js';

declare global {
  interface Window {
    card: {
      /** Loads fonts and the avatar; resolves with each frame's display time (ms) and theme. */
      prepare(input: SceneInput): Promise<{ delay: number; theme: string }[]>;
      /** Renders one frame and returns the names of any content that does not fit its box. */
      show(index: number): string[];
    };
  }
}

let input: SceneInput;
let frames: Frame[] = [];
let portrait: Portrait;

/** Weekly totals as columns of dots, coloured by height like a btop graph. */
function drawGraph(canvas: HTMLCanvasElement, weeks: number[], progress: number): void {
  const dot = 4, pitch = 6, rows = 30, perWeek = 2;
  canvas.width = canvas.clientWidth;
  canvas.height = rows * pitch;
  const context = canvas.getContext('2d')!;
  const colors = getComputedStyle(canvas);
  const shades = ['--green', '--yellow', '--red'].map(name => colors.getPropertyValue(name).trim());
  const left = Math.floor((canvas.width - weeks.length * perWeek * pitch + (pitch - dot)) / 2);
  const peak = Math.max(1, ...weeks);
  weeks.slice(0, Math.ceil(progress * weeks.length)).forEach((value, week) => {
    const height = value ? Math.max(1, Math.round(value / peak * rows)) : 0;
    for (let row = 0; row < height; row++) {
      context.fillStyle = shades[row / rows < 0.45 ? 0 : row / rows < 0.75 ? 1 : 2];
      for (let column = 0; column < perWeek; column++) context.fillRect(left + (week * perWeek + column) * pitch, canvas.height - (row + 1) * pitch + (pitch - dot), dot, dot);
    }
  });
}

function paint(state: State): void {
  const portraitCanvas = document.querySelector<HTMLCanvasElement>('#portrait');
  const theme = input.themes.find(candidate => candidate.key === state.theme)!;
  if (portraitCanvas) portrait.draw(portraitCanvas, state.portrait, theme.colors, { sweep: state.sweep, tick: state.tick, reveal: state.fetch.output });
  const graph = document.querySelector<HTMLCanvasElement>('#graph');
  if (graph) drawGraph(graph, input.profile.activity.weeks, state.top.output);
}

function overflowing(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-fit]')]
    .filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
    .map(element => element.dataset.fit!);
}

window.card = {
  async prepare(next) {
    input = next;
    frames = buildTimeline(input.themes.map(theme => theme.key), input.portraits);
    await Promise.all(['400', '700'].map(weight => document.fonts.load(`${weight} 25px 'Card Mono'`)));
    portrait = await loadPortrait(input.profile.avatar);
    return frames.map(frame => ({ delay: frame.delay, theme: frame.state.theme }));
  },
  show(index) {
    const { state } = frames[index];
    document.body.innerHTML = view(input, state, portrait);
    paint(state);
    return overflowing();
  },
};
