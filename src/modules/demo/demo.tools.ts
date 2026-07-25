import { ToolDecorator as Tool, ExecutionContext, z } from '@nitrostack/core';
import { daysAgo, store } from '../../store/store.js';
import {
  assertsCompletion,
  looksLikeBlocker,
  scoreSentiment,
  splitClaims,
} from '../../lib/text.js';
import type { EODReport } from '../../store/types.js';

/**
 * Demo scaffolding.
 *
 * Several GroundTruth signals only mean anything across days — a blocker is
 * unremarkable on day one and urgent on day three; a confidence slide only
 * reads as a slide if there is something to slide from. Seeding history makes
 * those visible without waiting a week.
 *
 * The four employees are deliberately different cases, including one where the
 * evidence looks bad but the explanation is innocent. An agent that alerts on
 * all four is doing it wrong, and this data is what exposes that.
 */

const STAGING_BLOCKER =
  'Still blocked on the staging database credentials, waiting on the infra team';

/** day 0 is the most recent seeded day (yesterday by default). */
interface SeedDay {
  employeeId: string;
  text: string;
  confidence: number;
}

/**
 * Case A — Aarav: claims completion daily, same blocker three days running,
 * confidence sliding. This is the escalation the demo is built around.
 * Case B — Divya: healthy and consistent. Should produce no alert.
 * Case C — Karthik: real work that leaves almost no commit trail (review,
 * pairing, design). Low match score, innocent explanation. Should NOT alert.
 * Case D — Meera: no claim mismatch at all, but visibly wearing down. The
 * signal here is the person, not the code.
 */
function seedScript(dayOffset: number): SeedDay[] {
  const aaravByDay = [
    {
      text: `Finished the login module and wired up session handling. ${STAGING_BLOCKER}.`,
      confidence: 2,
    },
    {
      text: `Completed the token refresh flow. ${STAGING_BLOCKER}.`,
      confidence: 3,
    },
    {
      text: `Wrapped up the auth middleware. ${STAGING_BLOCKER}.`,
      confidence: 3,
    },
    {
      text: 'Started on the auth middleware, reading through the existing session code.',
      confidence: 4,
    },
  ];

  const divyaByDay = [
    {
      text: 'Completed the digest dashboard widget and opened a PR for review.',
      confidence: 5,
    },
    {
      text: 'Shipped the severity chip component and merged the layout fixes.',
      confidence: 5,
    },
    {
      text: 'Built out the report form and pushed the first pass of the styling.',
      confidence: 4,
    },
    {
      text: 'Set up the widget scaffolding and got the dev server running.',
      confidence: 4,
    },
  ];

  const karthikByDay = [
    {
      text: 'Spent most of today reviewing PRs and pairing with Divya on the widget layout.',
      confidence: 4,
    },
    {
      text: 'Wrote the design doc for the alerting flow, mostly discussion and diagrams today.',
      confidence: 4,
    },
    {
      text: 'Interviewing candidates for the backend role, plus a long architecture call.',
      confidence: 4,
    },
    {
      text: 'Reviewed the auth approach with Aarav and sketched the data model on the whiteboard.',
      confidence: 4,
    },
  ];

  const meeraByDay = [
    {
      text: 'Regression suite is still failing intermittently and I am struggling to keep up with the queue. Feeling pretty exhausted.',
      confidence: 2,
    },
    {
      text: 'Wrote more test cases but the flaky suite is overwhelming, spent the day rerunning things.',
      confidence: 2,
    },
    {
      text: 'Worked through the regression backlog, slower than I wanted.',
      confidence: 3,
    },
    {
      text: 'Finished the smoke test checklist and filed three bugs.',
      confidence: 4,
    },
  ];

  const pick = (arr: Array<{ text: string; confidence: number }>) =>
    arr[Math.min(dayOffset, arr.length - 1)];

  return [
    { employeeId: 'emp-1', ...pick(aaravByDay) },
    { employeeId: 'emp-2', ...pick(divyaByDay) },
    { employeeId: 'emp-3', ...pick(karthikByDay) },
    { employeeId: 'emp-4', ...pick(meeraByDay) },
  ];
}

export class DemoTools {
  @Tool({
    name: 'seed_demo_data',
    description:
      'Populate several days of prior EOD reports for the whole team, so trend and ' +
      'blocker-recurrence signals have history to work against. Use this once when ' +
      "setting up a demo. By default it leaves today's reports empty so a live " +
      'submission can be made on stage. Replaces any existing reports, cross-checks, and alerts.',
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(3)
        .describe('How many prior days of history to create'),
      includeToday: z
        .boolean()
        .default(false)
        .describe(
          "Also create today's reports. Leave false so you can submit today's live during a demo.",
        ),
    }),
  })
  async seedDemoData(
    input: { days: number; includeToday: boolean },
    ctx: ExecutionContext,
  ) {
    store.clearOperationalData();

    const created: Array<{ date: string; employee: string }> = [];
    const startOffset = input.includeToday ? 0 : 1;

    // Walk backwards from the most recent day so dayOffset 0 is the freshest.
    for (let i = 0; i < input.days; i++) {
      const offset = startOffset + i;
      const date = daysAgo(offset);

      for (const entry of seedScript(i)) {
        const employee = store.getEmployee(entry.employeeId);
        if (!employee) continue;

        const sentences = splitClaims(entry.text);
        const blockers = sentences.filter(looksLikeBlocker);

        const report: EODReport = {
          id: `rep-${employee.id}-${date}`,
          employeeId: employee.id,
          date,
          rawText: entry.text,
          confidence: entry.confidence,
          submittedAt: new Date(`${date}T18:30:00`).toISOString(),
          claims: sentences
            .filter((s) => !blockers.includes(s))
            .map((text) => ({ text, assertsCompletion: assertsCompletion(text) })),
          blockers,
          sentiment: scoreSentiment(entry.text),
        };

        store.addReport(report);
        created.push({ date, employee: employee.name });
      }
    }

    ctx.logger.info('Seeded demo history', {
      days: input.days,
      reports: created.length,
      includeToday: input.includeToday,
    });

    return {
      seeded: true,
      days: input.days,
      reportsCreated: created.length,
      dateRange: {
        from: daysAgo(startOffset + input.days - 1),
        to: daysAgo(startOffset),
      },
      todayLeftEmpty: !input.includeToday,
      narratives: [
        'Aarav Menon — claims completed work daily, same staging-credentials blocker every day, confidence sliding. The escalation case.',
        'Divya Raghavan — consistent and healthy. Should produce no alert.',
        'Karthik Iyer — review, pairing, and design work that leaves almost no commits. Low match score with an innocent explanation; alerting here would be a false positive.',
        'Meera Nair — no claim mismatch, but confidence and tone are deteriorating. A signal about the person rather than the code.',
      ],
      nextStep: input.includeToday
        ? 'Run review_team_day to have the agent work through all four.'
        : "Submit today's report via open_eod_form, then run review_eod_submission.",
    };
  }

  @Tool({
    name: 'reset_demo_data',
    description:
      'Delete all reports, cross-checks, and alerts, keeping the team roster. ' +
      'Use to get back to a clean slate between demo runs.',
    inputSchema: z.object({}),
  })
  async resetDemoData(_input: unknown, ctx: ExecutionContext) {
    store.clearOperationalData();
    ctx.logger.info('Demo data reset');
    return {
      reset: true,
      employeesKept: store.listEmployees().length,
      message: 'All reports, cross-checks, and alerts cleared. Roster intact.',
    };
  }

  @Tool({
    name: 'set_employee_github',
    description:
      "Point an employee at a real GitHub username so their commits can be verified. " +
      'Use this during demo setup instead of editing the seed file, then re-run crosscheck_activity.',
    inputSchema: z.object({
      employeeId: z.string().describe('Employee id, full name, or current GitHub username'),
      githubUsername: z.string().describe('The GitHub login to attribute commits to'),
    }),
  })
  async setEmployeeGithub(
    input: { employeeId: string; githubUsername: string },
    ctx: ExecutionContext,
  ) {
    const employee = store.resolveEmployee(input.employeeId);
    if (!employee) {
      throw new Error(
        `No employee matches "${input.employeeId}". Read team://employees for valid ids.`,
      );
    }

    const updated = store.setGithubUsername(employee.id, input.githubUsername);
    ctx.logger.info('Updated GitHub username', {
      employee: employee.name,
      githubUsername: input.githubUsername,
    });

    return {
      updated: true,
      employee: { id: updated!.id, name: updated!.name },
      githubUsername: updated!.githubUsername,
    };
  }
}
