import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { validateProfile, type Activity, type Profile } from './model.js';
import { ACTIVITY_DAYS, languageShare, summarizeActivity } from './stats.js';

const execute = promisify(execFile);
const excluded = 'node_modules,vendor,dist,build,.venv,venv,__pycache__,coverage,.next,.nuxt';
const DAY = 86_400_000;

interface Repo { id: number; full_name: string; private: boolean; fork: boolean; size: number; default_branch: string; owner: { login: string }; stargazers_count: number }
interface Counted { sha: string; lines: number; languages: Record<string, number> }
interface DailyCounts { daily: number[]; end: string; source: Activity['source'] }

export function archiveTarget(root: string, name: string): string {
  if (name.includes(':') || name.includes('\\') || path.posix.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe archive entry');
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe archive entry');
  return target;
}

/** Total and per-language code lines from a `cloc --json` report. */
export function readCloc(report: unknown): Pick<Counted, 'lines' | 'languages'> {
  const entries = Object.entries((report ?? {}) as Record<string, { code?: unknown }>);
  const code = (value: { code?: unknown } | undefined) => {
    const lines = value?.code ?? 0;
    if (!Number.isSafeInteger(lines) || (lines as number) < 0) throw new Error('Invalid line count');
    return lines as number;
  };
  return {
    lines: code(entries.find(([name]) => name === 'SUM')?.[1]),
    languages: Object.fromEntries(entries.filter(([name]) => name !== 'SUM' && name !== 'header').map(([name, value]) => [name, code(value)])),
  };
}

/**
 * The profile's own contribution calendar. Returns nothing when the token may not read it,
 * so the caller can fall back to commit dates.
 */
async function contributionCalendar(token: string): Promise<DailyCounts | undefined> {
  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query{viewer{contributionsCollection{contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}' }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: { viewer?: { contributionsCollection?: { contributionCalendar?: { weeks?: { contributionDays: { date: string; contributionCount: number }[] }[] } } } } };
    const days = body.data?.viewer?.contributionsCollection?.contributionCalendar?.weeks?.flatMap(week => week.contributionDays) ?? [];
    if (!days.length || days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0)) return undefined;
    days.sort((a, b) => a.date.localeCompare(b.date));
    return { daily: days.map(day => day.contributionCount), end: days.at(-1)!.date, source: 'contributions' };
  } catch { return undefined; }
}

export async function collect(token: string): Promise<Profile> {
  if (!token) throw new Error('GH_TOKEN is required only for collection');
  async function request(route: string) {
    const response = await fetch('https://api.github.com' + route, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response;
  }
  const user = await (await request('/user')).json() as { login: string; avatar_url: string; created_at: string };
  const repos: Repo[] = [];
  for (let page = 1; ; page++) {
    const batch = await (await request(`/user/repos?affiliation=owner&per_page=100&page=${page}`)).json() as Repo[];
    repos.push(...batch.filter(repo => repo.owner.login.toLowerCase() === user.login.toLowerCase()));
    if (batch.length < 100) break;
  }

  const now = new Date();
  const calendar = await contributionCalendar(token);
  if (!calendar) console.log('Contribution calendar unavailable for this token; counting commit dates instead');
  // Fallback activity: commits per UTC day on default branches, same scope as the commit total.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = today - (ACTIVITY_DAYS - 1) * DAY;
  const commitDays = new Array<number>(ACTIVITY_DAYS).fill(0);

  let totalLines = 0, commits = 0;
  const languages: Record<string, number> = {};
  // Cache only on this runner; never publish or upload it as an artifact.
  await mkdir('.cache/counts', { recursive: true });
  for (const repo of repos) {
    try {
      if (repo.size === 0) continue;
      const head = await (await request(`/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`)).json() as { sha: string };
      const cachePath = `.cache/counts/${repo.id}.json`;
      let counted: Counted | undefined;
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<Counted>;
        if (cached.sha === head.sha && typeof cached.lines === 'number' && cached.languages) counted = cached as Counted;
      } catch {}
      if (!counted) {
        const directory = await mkdtemp(path.join(tmpdir(), 'profile-loc-'));
        try {
          const archive = await request(`/repos/${repo.full_name}/zipball/${head.sha}`);
          const zip = new AdmZip(Buffer.from(await archive.arrayBuffer()));
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory || ((entry.attr >>> 16) & 0o170000) === 0o120000) continue;
            const target = archiveTarget(directory, entry.entryName);
            await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, entry.getData());
          }
          const { stdout } = await execute('cloc', ['--json', '--quiet', '--skip-uniqueness', `--exclude-dir=${excluded}`, directory], { timeout: 600000, maxBuffer: 2e6 });
          counted = { sha: head.sha, ...readCloc(stdout.trim() ? JSON.parse(stdout) : {}) };
        } finally { await rm(directory, { recursive: true, force: true }); }
        await writeFile(cachePath, JSON.stringify(counted));
      }
      totalLines += counted.lines;
      if (repo.fork) continue;
      // Forks count towards LOC only: their history and languages are someone else's work.
      for (const [name, lines] of Object.entries(counted.languages)) languages[name] = (languages[name] ?? 0) + lines;
      const response = await request(`/repos/${repo.full_name}/commits?per_page=1&sha=${encodeURIComponent(head.sha)}`);
      const last = response.headers.get('link')?.match(/[?&]page=(\d+)>; rel="last"/);
      commits += last ? Number(last[1]) : ((await response.json()) as unknown[]).length;
      if (calendar) continue;
      for (let page = 1; ; page++) {
        const batch = await (await request(`/repos/${repo.full_name}/commits?sha=${encodeURIComponent(head.sha)}&since=${new Date(since).toISOString()}&per_page=100&page=${page}`)).json() as { commit: { committer: { date: string } | null } }[];
        for (const entry of batch) {
          const day = Math.floor((Date.parse(entry.commit.committer?.date ?? '') - since) / DAY);
          if (day >= 0 && day < ACTIVITY_DAYS) commitDays[day]++;
        }
        if (batch.length < 100) break;
      }
    } catch { throw new Error('Repository collection failed; keeping the previous profile rather than publishing partial totals'); }
  }
  const avatarResponse = await fetch(user.avatar_url, { signal: AbortSignal.timeout(30000) });
  if (!avatarResponse.ok) throw new Error('Avatar download failed');
  const avatar = await sharp(Buffer.from(await avatarResponse.arrayBuffer())).resize(512, 512, { fit: 'inside' }).png().toBuffer();
  const publicRepos = repos.filter(repo => !repo.private);
  const counts = calendar ?? { daily: commitDays, end: new Date(today).toISOString().slice(0, 10), source: 'commits' as const };
  return validateProfile({
    username: user.login,
    avatar: 'data:image/png;base64,' + avatar.toString('base64'),
    collectedAt: now.toISOString(),
    createdAt: user.created_at,
    totalLines,
    publicRepos: publicRepos.length,
    stars: publicRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0),
    commits,
    languages: languageShare(languages),
    activity: summarizeActivity(counts.daily, counts.end, counts.source),
  });
}
