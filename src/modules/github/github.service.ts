/**
 * Minimal GitHub REST client.
 *
 * Uses repo-scoped listing endpoints rather than the Search API on purpose:
 * GitHub's search index lags by seconds-to-minutes, which would break a live
 * demo where someone pushes a commit on stage. /repos/.../commits is immediate.
 *
 * Built on global fetch (Node 18+) so there is no extra dependency to install.
 */

import type { CommitRecord, PullRequestRecord } from '../../store/types.js';

const API = 'https://api.github.com';

export interface GitHubConfig {
  token: string;
  org: string;
  /** Repos to inspect, as "owner/repo". */
  repos: string[];
}

export class GitHubConfigError extends Error {}

/**
 * Reads config from the environment each call so a token added to .env
 * mid-session is picked up on the next tool run without a restart.
 */
export function readConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN?.trim() ?? '';
  const org = process.env.GITHUB_ORG?.trim() ?? '';
  const raw = process.env.GITHUB_REPOS?.trim() ?? '';

  if (!token) {
    throw new GitHubConfigError(
      'GITHUB_TOKEN is not set. Copy .env.example to .env and add a GitHub personal access token with repo read scope.',
    );
  }
  if (!org) {
    throw new GitHubConfigError(
      'GITHUB_ORG is not set. Add the GitHub org or username that owns the repos you want to check.',
    );
  }

  const repos = raw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    // Accept either "owner/repo" or a bare repo name under GITHUB_ORG.
    .map((r) => (r.includes('/') ? r : `${org}/${r}`));

  return { token, org, repos };
}

async function ghFetch<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'groundtruth-mcp',
    },
  });

  if (res.status === 401) {
    throw new GitHubConfigError(
      'GitHub rejected the token (401). Check GITHUB_TOKEN is valid and has repo read scope.',
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub rate limit or permission issue (${res.status}). Wait a moment, or check the token's scopes.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

/** Start and end of a YYYY-MM-DD day as ISO timestamps. */
function dayBounds(date: string): { since: string; until: string } {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);
  return { since: start.toISOString(), until: end.toISOString() };
}

/**
 * Repos to inspect: the explicit GITHUB_REPOS list if set, otherwise the org's
 * 30 most recently pushed repos.
 */
export async function resolveRepos(cfg: GitHubConfig): Promise<string[]> {
  if (cfg.repos.length > 0) return cfg.repos;

  // Works for both orgs and personal accounts — try org first, fall back to user.
  const paths = [
    `${API}/orgs/${cfg.org}/repos?sort=pushed&per_page=30`,
    `${API}/users/${cfg.org}/repos?sort=pushed&per_page=30`,
  ];

  for (const url of paths) {
    try {
      const repos = await ghFetch<Array<{ full_name: string }>>(url, cfg.token);
      if (repos.length > 0) return repos.map((r) => r.full_name);
    } catch (err) {
      if (err instanceof GitHubConfigError) throw err;
      // Try the next shape.
    }
  }

  throw new Error(
    `No repositories found for "${cfg.org}". Set GITHUB_REPOS explicitly (comma-separated owner/repo).`,
  );
}

export async function fetchCommits(
  cfg: GitHubConfig,
  githubUsername: string,
  date: string,
): Promise<CommitRecord[]> {
  const { since, until } = dayBounds(date);
  const repos = await resolveRepos(cfg);
  const out: CommitRecord[] = [];

  for (const repo of repos) {
    const url =
      `${API}/repos/${repo}/commits` +
      `?author=${encodeURIComponent(githubUsername)}` +
      `&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`;

    try {
      const commits = await ghFetch<
        Array<{
          sha: string;
          html_url: string;
          commit: { message: string; author: { date: string } };
        }>
      >(url, cfg.token);

      for (const c of commits) {
        out.push({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split('\n')[0],
          repo,
          committedAt: c.commit.author.date,
          url: c.html_url,
        });
      }
    } catch (err) {
      if (err instanceof GitHubConfigError) throw err;
      // An empty or inaccessible repo shouldn't abort the whole check.
    }
  }

  return out.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
}

export async function fetchPullRequests(
  cfg: GitHubConfig,
  githubUsername: string,
  date: string,
): Promise<PullRequestRecord[]> {
  const repos = await resolveRepos(cfg);
  const needle = githubUsername.toLowerCase();
  const out: PullRequestRecord[] = [];

  for (const repo of repos) {
    const url = `${API}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`;

    try {
      const prs = await ghFetch<
        Array<{
          number: number;
          title: string;
          state: string;
          merged_at: string | null;
          created_at: string;
          updated_at: string;
          html_url: string;
          user: { login: string } | null;
        }>
      >(url, cfg.token);

      for (const pr of prs) {
        if (pr.user?.login.toLowerCase() !== needle) continue;
        // Count a PR toward the day if it was opened or touched that day.
        const touchedToday =
          pr.created_at.startsWith(date) ||
          pr.updated_at.startsWith(date) ||
          (pr.merged_at?.startsWith(date) ?? false);
        if (!touchedToday) continue;

        out.push({
          number: pr.number,
          title: pr.title,
          repo,
          state: pr.state === 'closed' ? 'closed' : 'open',
          merged: pr.merged_at !== null,
          createdAt: pr.created_at,
          url: pr.html_url,
        });
      }
    } catch (err) {
      if (err instanceof GitHubConfigError) throw err;
      // Skip repos we can't read.
    }
  }

  return out;
}
