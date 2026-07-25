/**
 * Single-file JSON store.
 *
 * A hackathon MVP does not need a database: the whole dataset is a few dozen
 * records. Reads are served from memory, writes flush the file synchronously so
 * a crash never loses a submitted report.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ActivityCheck,
  Alert,
  Employee,
  EODReport,
  GroundTruthData,
} from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'groundtruth.json');

/**
 * Seed team.
 *
 * Only emp-1 is wired to a real GitHub account — point it at yours with
 * `set_employee_github`, and commit as that account during the demo so
 * crosscheck_activity has genuine activity to compare against.
 *
 * The other three keep deliberately fictional logins so they return no commits.
 * That is the point: giving everyone the same real username would attribute the
 * same commits to all four, and Karthik — whose whole role in the demo is to be
 * the person who legitimately has no commits — would suddenly appear to have
 * them, collapsing the false-positive case the agent is supposed to recognise.
 */
const SEED: GroundTruthData = {
  employees: [
    {
      id: 'emp-1',
      name: 'Aarav Menon',
      role: 'Backend Engineer',
      teamId: 'team-platform',
      // Replace with a real login via set_employee_github before demoing.
      githubUsername: 'Vimaladharsan',
    },
    {
      id: 'emp-2',
      name: 'Divya Raghavan',
      role: 'Frontend Engineer',
      teamId: 'team-platform',
      githubUsername: 'divya-raghavan-demo',
    },
    {
      id: 'emp-3',
      name: 'Karthik Iyer',
      role: 'Full-stack Engineer',
      teamId: 'team-platform',
      githubUsername: 'karthik-iyer-demo',
    },
    {
      id: 'emp-4',
      name: 'Meera Nair',
      role: 'QA Engineer',
      teamId: 'team-platform',
      githubUsername: 'meera-nair-demo',
    },
  ],
  reports: [],
  activityChecks: [],
  alerts: [],
};

class Store {
  private data: GroundTruthData;

  constructor() {
    this.data = this.load();
  }

  private load(): GroundTruthData {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        // Tolerate a file written by an older shape.
        return {
          employees: parsed.employees ?? SEED.employees,
          reports: parsed.reports ?? [],
          activityChecks: parsed.activityChecks ?? [],
          alerts: parsed.alerts ?? [],
        };
      }
    } catch {
      // A corrupt file should not stop the server mid-demo; fall back to seed.
    }
    const seeded = structuredClone(SEED);
    this.persist(seeded);
    return seeded;
  }

  private persist(data: GroundTruthData = this.data): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ---- Employees ----

  listEmployees(teamId?: string): Employee[] {
    return teamId
      ? this.data.employees.filter((e) => e.teamId === teamId)
      : [...this.data.employees];
  }

  getEmployee(employeeId: string): Employee | undefined {
    return this.data.employees.find((e) => e.id === employeeId);
  }

  /** Resolves by id, then by exact name, then by GitHub login — callers are often LLMs. */
  resolveEmployee(identifier: string): Employee | undefined {
    const needle = identifier.trim().toLowerCase();
    return this.data.employees.find(
      (e) =>
        e.id.toLowerCase() === needle ||
        e.name.toLowerCase() === needle ||
        e.githubUsername.toLowerCase() === needle,
    );
  }

  // ---- Reports ----

  addReport(report: EODReport): EODReport {
    // One report per person per day: a resubmission replaces the earlier one.
    const existing = this.data.reports.findIndex(
      (r) => r.employeeId === report.employeeId && r.date === report.date,
    );
    if (existing >= 0) {
      this.data.reports[existing] = report;
    } else {
      this.data.reports.push(report);
    }
    this.persist();
    return report;
  }

  updateReport(reportId: string, patch: Partial<EODReport>): EODReport | undefined {
    const report = this.data.reports.find((r) => r.id === reportId);
    if (!report) return undefined;
    Object.assign(report, patch);
    this.persist();
    return report;
  }

  getReport(employeeId: string, date: string): EODReport | undefined {
    return this.data.reports.find(
      (r) => r.employeeId === employeeId && r.date === date,
    );
  }

  getReportById(reportId: string): EODReport | undefined {
    return this.data.reports.find((r) => r.id === reportId);
  }

  listReports(date?: string): EODReport[] {
    return date
      ? this.data.reports.filter((r) => r.date === date)
      : [...this.data.reports];
  }

  /** Reports for one person, newest first — used to spot a blocker repeating. */
  historyFor(employeeId: string, limit = 7): EODReport[] {
    return this.data.reports
      .filter((r) => r.employeeId === employeeId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  // ---- Activity checks ----

  addActivityCheck(check: ActivityCheck): ActivityCheck {
    const existing = this.data.activityChecks.findIndex(
      (c) => c.reportId === check.reportId,
    );
    if (existing >= 0) {
      this.data.activityChecks[existing] = check;
    } else {
      this.data.activityChecks.push(check);
    }
    this.persist();
    return check;
  }

  getActivityCheck(reportId: string): ActivityCheck | undefined {
    return this.data.activityChecks.find((c) => c.reportId === reportId);
  }

  // ---- Alerts ----

  addAlert(alert: Alert): Alert {
    this.data.alerts.push(alert);
    this.persist();
    return alert;
  }

  listAlerts(teamId?: string, includeResolved = false): Alert[] {
    return this.data.alerts.filter(
      (a) =>
        (teamId ? a.teamId === teamId : true) &&
        (includeResolved ? true : !a.resolved),
    );
  }

  resolveAlert(alertId: string): Alert | undefined {
    const alert = this.data.alerts.find((a) => a.id === alertId);
    if (!alert) return undefined;
    alert.resolved = true;
    this.persist();
    return alert;
  }

  // ---- Maintenance ----

  /** Drops reports, checks, and alerts but keeps the roster. Used by the demo tools. */
  clearOperationalData(): void {
    this.data.reports = [];
    this.data.activityChecks = [];
    this.data.alerts = [];
    this.persist();
  }

  /**
   * Restore the roster to the seed definition.
   *
   * An existing data file keeps whatever employees it already had, so a change
   * to SEED has no effect on a machine that has run before. This is the escape
   * hatch for that.
   */
  resetRoster(): Employee[] {
    this.data.employees = structuredClone(SEED.employees);
    this.persist();
    return this.listEmployees();
  }

  /** Overwrite an employee's GitHub login, so a demo can attribute commits to a real account. */
  setGithubUsername(employeeId: string, githubUsername: string): Employee | undefined {
    const employee = this.data.employees.find((e) => e.id === employeeId);
    if (!employee) return undefined;
    employee.githubUsername = githubUsername;
    this.persist();
    return employee;
  }
}

/** Shared instance — the store is infrastructure, so it is not a DI provider. */
export const store = new Store();

/** Format a Date as YYYY-MM-DD in local time. */
export function toDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today in YYYY-MM-DD, local time. */
export function today(): string {
  return toDateString(new Date());
}

/** The date `n` days before today, in YYYY-MM-DD. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateString(d);
}
