/**
 * GroundTruth domain types.
 *
 * Deliberately minimal — this is a hackathon MVP. The whole dataset lives in a
 * single JSON file (see store.ts) so there is no database to provision.
 */

export interface Employee {
  id: string;
  name: string;
  role: string;
  teamId: string;
  /** GitHub login used to attribute commits and PRs to this person. */
  githubUsername: string;
  /**
   * Optional git commit email.
   *
   * GitHub only links a commit to a user account when the commit's author email
   * is registered on that account. A mismatched `git config user.email` — very
   * common — leaves commits showing as an unlinked author, and filtering by
   * login alone then finds nothing. Setting this lets attribution fall back to
   * the raw commit email.
   */
  githubEmail?: string;
}

/** A single claim pulled out of an employee's free-text report. */
export interface ExtractedClaim {
  text: string;
  /** Whether the claim asserts finished work ("done", "shipped") or work in progress. */
  assertsCompletion: boolean;
}

export interface EODReport {
  id: string;
  employeeId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  rawText: string;
  /** Self-reported confidence, 1 (struggling) to 5 (on track). */
  confidence: number;
  submittedAt: string;
  /** Populated once extract_eod_summary has run over rawText. */
  claims?: ExtractedClaim[];
  blockers?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
}

export interface CommitRecord {
  sha: string;
  message: string;
  repo: string;
  /** UTC instant, as GitHub reports it. */
  committedAt: string;
  /**
   * The local calendar day this commit falls in, and the local wall-clock time.
   *
   * Both exist because `committedAt` alone misleads. A commit made at 00:29 in
   * IST is stamped 18:59Z the *previous* day, so anything reading the UTC date
   * prefix concludes it happened yesterday — which is how a review once reported
   * "zero commits today" while listing six of them.
   */
  localDate: string;
  localTime: string;
  url: string;
}

export interface PullRequestRecord {
  number: number;
  title: string;
  repo: string;
  state: 'open' | 'closed';
  merged: boolean;
  createdAt: string;
  url: string;
}

/**
 * The result of comparing what someone said they did against what GitHub shows.
 * `verdict` is a signal for the agent to reason about — not a decision in itself.
 */
export interface ActivityCheck {
  reportId: string;
  employeeId: string;
  date: string;
  commits: CommitRecord[];
  pullRequests: PullRequestRecord[];
  /** 0..1 — rough overlap between claim wording and real activity. */
  matchScore: number;
  verdict: 'consistent' | 'partial' | 'unsupported' | 'no-claims';
  /** Human-readable observations for the agent to weigh. */
  observations: string[];
  checkedAt: string;
}

export type AlertSeverity = 'low' | 'medium' | 'high';

export interface Alert {
  id: string;
  employeeId: string;
  teamId: string;
  date: string;
  reason: string;
  severity: AlertSeverity;
  createdAt: string;
  resolved: boolean;
}

export interface GroundTruthData {
  employees: Employee[];
  reports: EODReport[];
  activityChecks: ActivityCheck[];
  alerts: Alert[];
}
