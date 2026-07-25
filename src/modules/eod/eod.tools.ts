import { ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import { store, today } from '../../store/store.js';
import {
  assertsCompletion,
  looksLikeBlocker,
  sameBlocker,
  scoreSentiment,
  splitClaims,
} from '../../lib/text.js';
import type { EODReport, ExtractedClaim } from '../../store/types.js';

export class EodTools {
  @Tool({
    name: 'open_eod_form',
    description:
      'Open the end-of-day report form so an employee can write their update. ' +
      'Renders an interactive form; submitting it calls submit_eod_report.',
    inputSchema: z.object({
      employeeId: z
        .string()
        .optional()
        .describe('Pre-select this employee (id, name, or GitHub username)'),
    }),
  })
  @Widget('eod-form')
  async openEodForm(input: { employeeId?: string }, ctx: ExecutionContext) {
    ctx.logger.info('Opening EOD form');

    const employees = store.listEmployees().map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
    }));

    const selected = input.employeeId
      ? store.resolveEmployee(input.employeeId)
      : undefined;

    return {
      date: today(),
      employees,
      selectedEmployeeId: selected?.id ?? employees[0]?.id ?? null,
    };
  }

  @Tool({
    name: 'submit_eod_report',
    description:
      "Record an employee's end-of-day report for a date. Stores the raw text and " +
      'immediately pre-parses it into candidate claims and blockers. ' +
      'Resubmitting for the same date replaces the earlier report.',
    inputSchema: z.object({
      employeeId: z
        .string()
        .describe('Employee id, full name, or GitHub username'),
      reportText: z
        .string()
        .min(3)
        .describe('Free-text report: what they worked on, and anything blocking them'),
      confidence: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(3)
        .describe('Self-reported confidence, 1 (struggling) to 5 (on track)'),
      date: z
        .string()
        .optional()
        .describe('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
  })
  async submitEodReport(
    input: {
      employeeId: string;
      reportText: string;
      confidence: number;
      date?: string;
    },
    ctx: ExecutionContext,
  ) {
    const employee = store.resolveEmployee(input.employeeId);
    if (!employee) {
      throw new Error(
        `No employee matches "${input.employeeId}". Read the team://employees resource for valid ids.`,
      );
    }

    const date = input.date ?? today();
    const extraction = extractFrom(input.reportText);

    const report: EODReport = {
      id: `rep-${employee.id}-${date}`,
      employeeId: employee.id,
      date,
      rawText: input.reportText,
      confidence: input.confidence,
      submittedAt: new Date().toISOString(),
      ...extraction,
    };

    store.addReport(report);

    ctx.logger.info('EOD report stored', {
      employee: employee.name,
      date,
      claims: extraction.claims.length,
      blockers: extraction.blockers.length,
      sentiment: extraction.sentiment,
    });

    return {
      stored: true,
      reportId: report.id,
      employee: { id: employee.id, name: employee.name, role: employee.role },
      date,
      confidence: input.confidence,
      ...extraction,
      nextStep:
        `Run crosscheck_activity for ${employee.name} on ${date} to verify these claims against GitHub.`,
    };
  }

  @Tool({
    name: 'extract_eod_summary',
    description:
      'Re-parse a stored EOD report into structured claims, blockers, and a sentiment reading. ' +
      'submit_eod_report already does this on save; use this to refresh the extraction, ' +
      'or to inspect the structure before cross-checking. Extraction is deterministic keyword ' +
      'analysis — treat the output as a starting point and apply your own judgement to the raw text.',
    inputSchema: z.object({
      employeeId: z
        .string()
        .describe('Employee id, full name, or GitHub username'),
      date: z
        .string()
        .optional()
        .describe('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
  })
  async extractEodSummary(
    input: { employeeId: string; date?: string },
    ctx: ExecutionContext,
  ) {
    const employee = store.resolveEmployee(input.employeeId);
    if (!employee) {
      throw new Error(`No employee matches "${input.employeeId}".`);
    }

    const date = input.date ?? today();
    const report = store.getReport(employee.id, date);
    if (!report) {
      throw new Error(
        `${employee.name} has not submitted an EOD report for ${date}.`,
      );
    }

    const extraction = extractFrom(report.rawText);
    store.updateReport(report.id, extraction);

    ctx.logger.info('Re-extracted report structure', {
      employee: employee.name,
      date,
      claims: extraction.claims.length,
    });

    return {
      reportId: report.id,
      employee: { id: employee.id, name: employee.name },
      date,
      rawText: report.rawText,
      confidence: report.confidence,
      ...extraction,
    };
  }

  @Tool({
    name: 'generate_daily_digest',
    description:
      "Build the manager's digest for a team on a date: every submitted report, its cross-check " +
      'result, open alerts, and who has not reported yet. Rows are ordered by how much attention ' +
      'they appear to need. Use this after reviewing individual submissions.',
    inputSchema: z.object({
      teamId: z
        .string()
        .default('team-platform')
        .describe('Team id, e.g. team-platform'),
      date: z
        .string()
        .optional()
        .describe('Date in YYYY-MM-DD format. Defaults to today.'),
    }),
  })
  @Widget('team-digest')
  async generateDailyDigest(
    input: { teamId: string; date?: string },
    ctx: ExecutionContext,
  ) {
    const date = input.date ?? today();
    const team = store.listEmployees(input.teamId);

    if (team.length === 0) {
      throw new Error(
        `No employees on team "${input.teamId}". Read team://employees to see the roster.`,
      );
    }

    const openAlerts = store.listAlerts(input.teamId);

    const rows = team.map((employee) => {
      const report = store.getReport(employee.id, date);
      const check = report ? store.getActivityCheck(report.id) : undefined;
      const alerts = openAlerts.filter((a) => a.employeeId === employee.id);

      // Repeated blockers are the signal a manager most often misses. Matched
      // by meaning rather than exact text — see sameBlocker.
      const recurringBlockers = report?.blockers?.filter((blocker) =>
        store
          .historyFor(employee.id, 5)
          .some(
            (prior) =>
              prior.date !== date &&
              (prior.blockers ?? []).some((b) => sameBlocker(b, blocker)),
          ),
      );

      return {
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role,
        },
        submitted: Boolean(report),
        reportText: report?.rawText ?? null,
        confidence: report?.confidence ?? null,
        sentiment: report?.sentiment ?? null,
        blockers: report?.blockers ?? [],
        recurringBlockers: recurringBlockers ?? [],
        verified: Boolean(check),
        matchScore: check?.matchScore ?? null,
        verdict: check?.verdict ?? null,
        commitCount: check?.commits.length ?? null,
        prCount: check?.pullRequests.length ?? null,
        alerts: alerts.map((a) => ({
          id: a.id,
          reason: a.reason,
          severity: a.severity,
        })),
        attentionRank: rankAttention({
          submitted: Boolean(report),
          alerts: alerts.length,
          highestSeverity: alerts.reduce<'low' | 'medium' | 'high' | null>(
            (acc, a) =>
              a.severity === 'high' || acc === 'high'
                ? 'high'
                : a.severity === 'medium' || acc === 'medium'
                  ? 'medium'
                  : 'low',
            null,
          ),
          verdict: check?.verdict ?? null,
          recurringBlockers: recurringBlockers?.length ?? 0,
          sentiment: report?.sentiment ?? null,
        }),
      };
    });

    rows.sort((a, b) => b.attentionRank - a.attentionRank);

    ctx.logger.info('Generated daily digest', {
      teamId: input.teamId,
      date,
      submitted: rows.filter((r) => r.submitted).length,
      total: rows.length,
      openAlerts: openAlerts.length,
    });

    return {
      teamId: input.teamId,
      date,
      summary: {
        headcount: rows.length,
        submitted: rows.filter((r) => r.submitted).length,
        missing: rows.filter((r) => !r.submitted).length,
        verified: rows.filter((r) => r.verified).length,
        openAlerts: openAlerts.length,
        needsAttention: rows.filter((r) => r.attentionRank >= 40).length,
      },
      rows,
    };
  }
}

/** Deterministic pre-parse of a report's free text. */
function extractFrom(rawText: string): {
  claims: ExtractedClaim[];
  blockers: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
} {
  const sentences = splitClaims(rawText);
  const blockers = sentences.filter(looksLikeBlocker);
  const claims: ExtractedClaim[] = sentences
    // A sentence that only describes a blocker isn't a claim of work done.
    .filter((s) => !blockers.includes(s))
    .map((text) => ({ text, assertsCompletion: assertsCompletion(text) }));

  return { claims, blockers, sentiment: scoreSentiment(rawText) };
}

/**
 * Orders digest rows so the manager reads the most consequential row first.
 * This is presentation ordering only — whether to alert is the agent's call.
 */
function rankAttention(input: {
  submitted: boolean;
  alerts: number;
  highestSeverity: 'low' | 'medium' | 'high' | null;
  verdict: string | null;
  recurringBlockers: number;
  sentiment: string | null;
}): number {
  let score = 0;
  if (input.highestSeverity === 'high') score += 60;
  else if (input.highestSeverity === 'medium') score += 40;
  else if (input.highestSeverity === 'low') score += 20;

  if (input.recurringBlockers > 0) score += 30;
  if (input.verdict === 'unsupported') score += 25;
  else if (input.verdict === 'partial') score += 15;
  if (input.sentiment === 'negative') score += 15;
  if (!input.submitted) score += 10;

  return score;
}
