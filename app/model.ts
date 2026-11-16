export interface LanguageShare {
  name: string;
  percent: number;
}

export interface Activity {
  /** Where the daily counts came from: the contribution calendar, or commit dates as a fallback. */
  source: 'contributions' | 'commits';
  total: number;
  streak: number;
  longestStreak: number;
  /** 52 weekly totals, oldest first. Weeks run Monday to Sunday; the last one is the current week. */
  weeks: number[];
  /** Daily intensity 0-4 for the last 26 weeks, oldest first. The current week may be partial. */
  levels: number[];
}

export interface Profile {
  username: string;
  avatar: string;
  collectedAt: string;
  createdAt: string;
  totalLines: number;
  publicRepos: number;
  stars: number;
  commits: number;
  languages: LanguageShare[];
  activity: Activity;
}

export const WEEKS = 52;
export const HEATMAP_WEEKS = 26;
export const MAX_LANGUAGES = 6;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid snapshot field: ${field}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid snapshot field: ${field}`);
  return value;
}
function count(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`Invalid snapshot field: ${field}`);
  return value as number;
}
function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`Invalid snapshot field: ${field}`);
  return new Date(value).toISOString();
}
function list(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid snapshot field: ${field}`);
  return value;
}

/**
 * The public allowlist. The result is rebuilt field by field, so nothing that is not
 * named and validated here can reach the renderer or the published images.
 */
export function validateProfile(value: unknown): Profile {
  const data = record(value, 'profile');
  const activity = record(data.activity, 'activity');
  if (activity.source !== 'contributions' && activity.source !== 'commits') throw new Error('Invalid snapshot field: activity.source');
  return {
    username: text(data.username, 'username', /^[A-Za-z0-9-]{1,39}$/),
    avatar: text(data.avatar, 'avatar', /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
    collectedAt: timestamp(data.collectedAt, 'collectedAt'),
    createdAt: timestamp(data.createdAt, 'createdAt'),
    totalLines: count(data.totalLines, 'totalLines'),
    publicRepos: count(data.publicRepos, 'publicRepos'),
    stars: count(data.stars, 'stars'),
    commits: count(data.commits, 'commits'),
    languages: list(data.languages, 'languages', 0, MAX_LANGUAGES).map(entry => {
      const language = record(entry, 'languages');
      return { name: text(language.name, 'languages.name', /^[A-Za-z0-9][A-Za-z0-9 #+.'/-]{0,23}$/), percent: count(language.percent, 'languages.percent', 100) };
    }),
    activity: {
      source: activity.source,
      total: count(activity.total, 'activity.total'),
      streak: count(activity.streak, 'activity.streak'),
      longestStreak: count(activity.longestStreak, 'activity.longestStreak'),
      weeks: list(activity.weeks, 'activity.weeks', WEEKS, WEEKS).map(week => count(week, 'activity.weeks')),
      levels: list(activity.levels, 'activity.levels', (HEATMAP_WEEKS - 1) * 7 + 1, HEATMAP_WEEKS * 7).map(level => count(level, 'activity.levels', 4)),
    },
  };
}
