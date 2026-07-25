import { ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import { store, today } from '../../store/store.js';
import { groupBlockerRuns, overlapRatio } from '../../lib/text.js';
import type { ActivityCheck, ExtractedClaim } from '../../store/types.js';
import {
  GitHubConfigError,
  fetchCommits,
  fetchPullRequests,
  readConfig,
} from './github.service.js';

/** A claim is considered supported at or above this overlap with real activity. */
const SUPPORT_THRESHOLD = 0.34;

export class GitHubTools {
  @Tool({
    name: 'crosscheck_activity',
    description:
      "Compare an employee's claimed work for a date against their real GitHub activity (commits and pull requests). " +
      'Returns the raw activity, per-claim support signals, and an overall matchScore. ' +
      'IMPORTANT: the returned verdict is a signal, not a decision — you must reason about whether the ' +
      'difference is significant before deciding to alert anyone. A low score can be legitimate ' +
      '(meetings, design work, pair programming, work on an untracked repo).',
    inputSchema: z.object({
      employeeId: z
        .string()
        .describe('Employee id, full name, or GitHub username'),
      date: z
        .string()
        .optional()
        .describe('Date to check in YYYY-MM-DD format. Defaults to today.'),
    }),
  })
  @Widget('crosscheck-result')
  async crosscheckActivity(
    input: { employeeId: string; date?: string },
    ctx: ExecutionContext,
  ) {
    const date = input.date ?? today();
    const employee = store.resolveEmployee(input.employeeId);

    if (!employee) {
      throw new Error(
        `No employee matches "${input.employeeId}". Read the team://employees resource for valid ids.`,
      );
    }

    const report = store.getReport(employee.id, date);
    if (!report) {
      throw new Error(
        `${employee.name} has not submitted an EOD report for ${date}. There is nothing to cross-check yet.`,
      );
    }

    ctx.logger.info('Cross-checking claims against GitHub', {
      employee: employee.name,
      githubUsername: employee.githubUsername,
      date,
    });

    let cfg;
    try {
      cfg = readConfig();
    } catch (err) {
      if (err instanceof GitHubConfigError) {
        throw new Error(`${err.message} (GroundTruth needs GitHub access to verify anything.)`);
      }
      throw err;
    }

    const identity = {
      login: employee.githubUsername,
      email: employee.githubEmail,
      name: employee.name,
    };

    const [commits, pullRequests] = await Promise.all([
      fetchCommits(cfg, identity, date),
      fetchPullRequests(cfg, employee.githubUsername, date),
    ]);

    // Everything GitHub knows about this person's day, as one searchable blob.
    const evidence = [
      ...commits.map((c) => c.message),
      ...pullRequests.map((p) => p.title),
    ].join(' \n');

    const claims: ExtractedClaim[] = report.claims ?? [];
    const claimSupport = claims.map((claim) => {
      const ratio = overlapRatio(claim.text, evidence);
      return {
        claim: claim.text,
        assertsCompletion: claim.assertsCompletion,
        overlap: Number(ratio.toFixed(2)),
        supported: ratio >= SUPPORT_THRESHOLD,
      };
    });

    const observations: string[] = [];

    if (claims.length === 0) {
      observations.push(
        'No structured claims on file — run extract_eod_summary on this report first for a meaningful comparison.',
      );
    }
    if (commits.length === 0 && pullRequests.length === 0) {
      observations.push(
        `No commits or PRs found for ${employee.githubUsername} on ${date} in the repos GroundTruth watches.`,
      );
    } else {
      // State the local day explicitly. GitHub timestamps are UTC, so a commit
      // made just after local midnight carries the previous day's date prefix —
      // enough to make a reader conclude nothing happened today.
      observations.push(
        `Found ${commits.length} commit(s) and ${pullRequests.length} pull request(s) ` +
          `on ${date} in local time. Note that the raw committedAt timestamps are UTC ` +
          `and may show a different calendar date; localDate on each commit is the ` +
          `day it counts towards.`,
      );
    }

    const completionClaims = claimSupport.filter((c) => c.assertsCompletion);
    const unsupportedCompletion = completionClaims.filter((c) => !c.supported);

    for (const c of unsupportedCompletion) {
      observations.push(
        `Claim asserts completed work but no matching commit or PR text was found: "${c.claim}"`,
      );
    }

    if (completionClaims.length > 0 && pullRequests.length === 0) {
      observations.push(
        'Work was described as finished, but no pull request was opened or updated that day.',
      );
    }

    if (report.blockers && report.blockers.length > 0) {
      observations.push(
        `Report lists ${report.blockers.length} blocker(s): ${report.blockers.join('; ')}`,
      );
    }

    // Prior days give the agent the context to spot a blocker that keeps recurring.
    const history = store
      .historyFor(employee.id, 5)
      .filter((r) => (r.blockers?.length ?? 0) > 0);

    const priorBlockers = history
      .filter((r) => r.date !== date)
      .map((r) => ({ date: r.date, blockers: r.blockers ?? [] }));

    /*
     * Recurrence is resolved here rather than in the widget. Matching blocker
     * text is a judgement about meaning (see sameBlocker), and duplicating that
     * logic in the frontend would let the two drift — the widget previously did
     * its own exact-string comparison and so never showed a recurrence at all.
     *
     * This must run before the ActivityCheck is built: observations are stored
     * with the check and read back by the digest, so anything pushed after
     * addActivityCheck would appear in the response but not in the record.
     */
    const recurringBlockers = groupBlockerRuns(
      history.flatMap((r) => (r.blockers ?? []).map((blocker) => ({ date: r.date, blocker }))),
    )
      .filter((r) => r.dates.length >= 2 && r.dates.includes(date))
      .map((r) => ({ blocker: r.blocker, days: r.dates.length, dates: r.dates }))
      .sort((a, b) => b.days - a.days);

    for (const r of recurringBlockers) {
      observations.push(
        `This blocker has now been reported on ${r.days} separate days (${r.dates.join(', ')}): "${r.blocker}"`,
      );
    }

    // Overall score: how much of the claimed work has visible support.
    const scored = claimSupport.length > 0 ? claimSupport : [];
    const matchScore =
      scored.length === 0
        ? 0
        : Number(
            (scored.filter((c) => c.supported).length / scored.length).toFixed(2),
          );

    let verdict: ActivityCheck['verdict'];
    if (claims.length === 0) {
      verdict = 'no-claims';
    } else if (matchScore >= 0.7) {
      verdict = 'consistent';
    } else if (matchScore > 0) {
      verdict = 'partial';
    } else {
      verdict = 'unsupported';
    }

    const check: ActivityCheck = {
      reportId: report.id,
      employeeId: employee.id,
      date,
      commits,
      pullRequests,
      matchScore,
      verdict,
      observations,
      checkedAt: new Date().toISOString(),
    };

    store.addActivityCheck(check);

    ctx.logger.info('Cross-check complete', {
      employee: employee.name,
      matchScore,
      verdict,
      commits: commits.length,
      pullRequests: pullRequests.length,
    });

    return {
      employee: {
        id: employee.id,
        name: employee.name,
        role: employee.role,
        githubUsername: employee.githubUsername,
      },
      date,
      reportText: report.rawText,
      confidence: report.confidence,
      claimSupport,
      blockers: report.blockers ?? [],
      priorBlockers,
      recurringBlockers,
      commits,
      pullRequests,
      commitCount: commits.length,
      pullRequestCount: pullRequests.length,
      matchScore,
      verdict,
      observations,
      reminder:
        'This is evidence, not a conclusion. Decide for yourself whether it warrants an alert, and say why.',
    };
  }
}
