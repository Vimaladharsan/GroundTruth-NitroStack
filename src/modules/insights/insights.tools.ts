import { ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import { daysAgo, store, today } from '../../store/store.js';
import { tokenize } from '../../lib/text.js';
import type { EODReport } from '../../store/types.js';

/**
 * Cross-cutting analysis over stored reports.
 *
 * Same discipline as everywhere else in this project: these tools compute
 * signals — slopes, streaks, recurrences, matches — and never conclude. The
 * agent reading them decides what, if anything, to do.
 */

type Direction = 'improving' | 'steady' | 'declining';

interface TrendPoint {
  date: string;
  submitted: boolean;
  confidence: number | null;
  sentiment: string | null;
  blockerCount: number;
}

export class InsightsTools {
  @Tool({
    name: 'analyze_wellbeing_trend',
    description:
      'Track confidence, tone, and blockers per person across recent days to surface early ' +
      'burnout signals — the kind that never show up in a single day\'s report. ' +
      'Returns a per-day series plus computed signals (confidence slope, consecutive negative days, ' +
      'blockers that keep recurring, missed submissions). ' +
      'These are signals, not conclusions: a two-day dip after a hard release is normal, ' +
      'while a slow four-day slide with a stuck blocker usually is not. Reason about which you are seeing.',
    inputSchema: z.object({
      teamId: z
        .string()
        .default('team-platform')
        .describe('Team to analyse. Ignored when employeeId is given.'),
      employeeId: z
        .string()
        .optional()
        .describe('Restrict to one person (id, name, or GitHub username)'),
      days: z
        .number()
        .int()
        .min(2)
        .max(30)
        .default(7)
        .describe('How many days back to include, counting today'),
    }),
  })
  @Widget('wellbeing-trend')
  async analyzeWellbeingTrend(
    input: { teamId: string; employeeId?: string; days: number },
    ctx: ExecutionContext,
  ) {
    const dates: string[] = [];
    for (let i = input.days - 1; i >= 0; i--) dates.push(daysAgo(i));

    const employees = input.employeeId
      ? [store.resolveEmployee(input.employeeId)].filter(
          (e): e is NonNullable<typeof e> => Boolean(e),
        )
      : store.listEmployees(input.teamId);

    if (employees.length === 0) {
      throw new Error(
        input.employeeId
          ? `No employee matches "${input.employeeId}".`
          : `No employees on team "${input.teamId}".`,
      );
    }

    ctx.logger.info('Analysing wellbeing trend', {
      employees: employees.length,
      days: input.days,
    });

    const people = employees.map((employee) => {
      const reports = new Map<string, EODReport>();
      for (const date of dates) {
        const r = store.getReport(employee.id, date);
        if (r) reports.set(date, r);
      }

      const series: TrendPoint[] = dates.map((date) => {
        const r = reports.get(date);
        return {
          date,
          submitted: Boolean(r),
          confidence: r?.confidence ?? null,
          sentiment: r?.sentiment ?? null,
          blockerCount: r?.blockers?.length ?? 0,
        };
      });

      const scored = series.filter(
        (p): p is TrendPoint & { confidence: number } => p.confidence !== null,
      );

      // Slope over submitted days only, so a missed day doesn't read as a crash.
      const confidenceDelta =
        scored.length >= 2
          ? scored[scored.length - 1].confidence - scored[0].confidence
          : 0;

      const direction: Direction =
        confidenceDelta <= -1 ? 'declining' : confidenceDelta >= 1 ? 'improving' : 'steady';

      // Longest run of negative tone ending on the most recent submitted day.
      let consecutiveNegative = 0;
      for (let i = scored.length - 1; i >= 0; i--) {
        if (scored[i].sentiment === 'negative') consecutiveNegative++;
        else break;
      }

      // Blockers appearing on two or more days, with how long each has run.
      const blockerRuns = new Map<string, string[]>();
      for (const date of dates) {
        for (const blocker of reports.get(date)?.blockers ?? []) {
          const key = blocker.toLowerCase();
          blockerRuns.set(key, [...(blockerRuns.get(key) ?? []), date]);
        }
      }
      const recurringBlockers = [...blockerRuns.entries()]
        .filter(([, ds]) => ds.length >= 2)
        .map(([key, ds]) => ({
          blocker:
            reports.get(ds[ds.length - 1])?.blockers?.find(
              (b) => b.toLowerCase() === key,
            ) ?? key,
          days: ds.length,
          dates: ds,
        }))
        .sort((a, b) => b.days - a.days);

      const signals: string[] = [];
      if (direction === 'declining') {
        signals.push(
          `Confidence fell ${Math.abs(confidenceDelta)} point(s) across the window, from ${scored[0].confidence} to ${scored[scored.length - 1].confidence}.`,
        );
      }
      if (consecutiveNegative >= 2) {
        signals.push(`Tone has read negative ${consecutiveNegative} submitted days running.`);
      }
      for (const r of recurringBlockers) {
        signals.push(`Blocker unresolved across ${r.days} days: "${r.blocker}".`);
      }
      const missed = series.filter((p) => !p.submitted).length;
      if (missed > 0) {
        signals.push(`${missed} of ${input.days} days have no report.`);
      }
      if (signals.length === 0) {
        signals.push('No trend signals — confidence and tone are holding steady.');
      }

      const latest = scored[scored.length - 1];

      return {
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role,
        },
        series,
        currentConfidence: latest?.confidence ?? null,
        currentSentiment: latest?.sentiment ?? null,
        confidenceDelta,
        direction,
        consecutiveNegativeDays: consecutiveNegative,
        recurringBlockers,
        missedDays: missed,
        signals,
      };
    });

    // Most concerning first, so the agent reads the important person first.
    const weight = (p: (typeof people)[number]) =>
      (p.direction === 'declining' ? 3 : 0) +
      p.consecutiveNegativeDays +
      p.recurringBlockers.reduce((sum, r) => sum + r.days, 0);
    people.sort((a, b) => weight(b) - weight(a));

    return {
      teamId: input.employeeId ? undefined : input.teamId,
      days: input.days,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      people,
      reminder:
        'Signals only. A dip after a hard week is normal; decide whether what you see is a pattern worth raising, and say why.',
    };
  }

  @Tool({
    name: 'search_reports',
    description:
      'Search stored EOD reports by keyword, person, date range, or whether they mention blockers. ' +
      'Use this to answer open questions about the team — "what has been blocking the mobile work this week", ' +
      '"has anyone mentioned the staging database", "who reported on Monday". ' +
      'Matching is keyword-based, so try a couple of phrasings before concluding nothing exists.',
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe('Keywords to match against report text. Omit to list everything in range.'),
      employeeId: z
        .string()
        .optional()
        .describe('Restrict to one person (id, name, or GitHub username)'),
      teamId: z.string().optional().describe('Restrict to one team'),
      since: z
        .string()
        .optional()
        .describe('Earliest date, YYYY-MM-DD, inclusive'),
      until: z.string().optional().describe('Latest date, YYYY-MM-DD, inclusive'),
      blockersOnly: z
        .boolean()
        .default(false)
        .describe('Only return reports that flagged at least one blocker'),
      limit: z.number().int().min(1).max(100).default(25).describe('Maximum results'),
    }),
  })
  async searchReports(
    input: {
      query?: string;
      employeeId?: string;
      teamId?: string;
      since?: string;
      until?: string;
      blockersOnly: boolean;
      limit: number;
    },
    ctx: ExecutionContext,
  ) {
    const target = input.employeeId
      ? store.resolveEmployee(input.employeeId)
      : undefined;
    if (input.employeeId && !target) {
      throw new Error(`No employee matches "${input.employeeId}".`);
    }

    const queryTokens = input.query ? tokenize(input.query) : [];

    const matches = store
      .listReports()
      .filter((report) => {
        if (target && report.employeeId !== target.id) return false;
        if (input.teamId) {
          const emp = store.getEmployee(report.employeeId);
          if (emp?.teamId !== input.teamId) return false;
        }
        if (input.since && report.date < input.since) return false;
        if (input.until && report.date > input.until) return false;
        if (input.blockersOnly && (report.blockers?.length ?? 0) === 0) return false;
        if (queryTokens.length > 0) {
          const haystack = new Set(tokenize(report.rawText));
          if (!queryTokens.some((t) => haystack.has(t))) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, input.limit)
      .map((report) => {
        const employee = store.getEmployee(report.employeeId);
        return {
          date: report.date,
          employee: employee
            ? { id: employee.id, name: employee.name, role: employee.role }
            : { id: report.employeeId, name: report.employeeId, role: 'unknown' },
          text: report.rawText,
          confidence: report.confidence,
          sentiment: report.sentiment ?? null,
          blockers: report.blockers ?? [],
          verified: Boolean(store.getActivityCheck(report.id)),
        };
      });

    ctx.logger.info('Searched reports', {
      query: input.query ?? '(none)',
      results: matches.length,
    });

    return {
      query: input.query ?? null,
      filters: {
        employee: target?.name ?? null,
        teamId: input.teamId ?? null,
        since: input.since ?? null,
        until: input.until ?? null,
        blockersOnly: input.blockersOnly,
      },
      resultCount: matches.length,
      results: matches,
      note:
        matches.length === 0
          ? 'No reports matched. Keyword matching is literal — try a synonym, widen the date range, or drop the query to see what exists.'
          : undefined,
      today: today(),
    };
  }
}
