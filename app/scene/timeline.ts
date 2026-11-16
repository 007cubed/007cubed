// The animation as data: an ordered list of scene states with their display times.
import type { Frame, PortraitStyle, State } from './types.js';

export const COMMANDS = { fetch: 'fastfetch', stats: 'gh stats --aggregate', top: 'ghtop', heat: 'gh heatmap --weeks 26' } as const;
type Command = keyof typeof COMMANDS;

const done = (command: Command) => ({ typed: COMMANDS[command].length, output: 1 });
const idle = { typed: 0, output: 0 };

/**
 * Frame 0 is the finished card, so the still image and any player that shows only the
 * first frame get the complete picture. The loop then holds once per look, closes the
 * windows, and replays the session until it is back at frame 0.
 *
 * A look is a theme with a portrait style. The two lists are stepped through together,
 * each wrapping around, so the longer one decides how many looks there are.
 */
export function buildTimeline(themes: string[], portraits: PortraitStyle[]): Frame[] {
  if (!themes.length || !portraits.length) throw new Error('At least one theme and one portrait style are required');
  const looks = Array.from({ length: Math.max(themes.length, portraits.length) }, (_, index) => ({ theme: themes[index % themes.length], portrait: portraits[index % portraits.length] }));
  const frames: Frame[] = [];
  let state: State = { ...looks[0], toast: false, open: 3, focus: 0, cursor: true, sweep: -1, tick: 0, fetch: done('fetch'), stats: done('stats'), top: done('top'), heat: done('heat') };
  const push = (delay: number, patch: Partial<State> = {}) => { state = { ...state, ...patch }; frames.push({ delay, state }); };
  const hold = (look: typeof looks[number], count: number) => {
    const toast = look.theme !== state.theme;
    // A light sweep crosses the portrait early in every hold.
    for (let index = 0; index < count; index++) push(250, { ...look, toast: toast && index < 6, cursor: index % 4 < 2, sweep: index >= 2 && index <= 7 ? (index - 2) / 5 : -1, tick: state.tick + (frames.length ? 1 : 0) });
  };

  if (looks.length === 1) hold(looks[0], 16);
  else {
    for (const look of looks) hold(look, 10);
    hold(looks[0], 8);
  }

  // Close everything, then let the windows tile back in one at a time.
  push(700, { toast: false, cursor: true, sweep: -1, open: 0, fetch: idle, stats: idle, top: idle, heat: idle });
  push(280, { open: 1 });
  push(280, { open: 2 });
  push(450, { open: 3 });

  const run = (command: Command, focus: State['focus'], steps: number, stepDelay: number) => {
    if (state.focus !== focus) push(300, { focus });
    const length = COMMANDS[command].length;
    for (let typed = 2; typed < length + 2; typed += 2) push(110, { [command]: { typed: Math.min(typed, length), output: 0 } });
    push(250); // the pause before Enter
    for (let step = 1; step <= steps; step++) push(stepDelay, { [command]: { typed: length, output: step / steps } });
    push(350);
  };
  run('fetch', 0, 8, 60);
  run('stats', 0, 6, 80);
  run('top', 1, 10, 70);
  run('heat', 2, 9, 70);
  push(300, { focus: 0 });
  return frames;
}
