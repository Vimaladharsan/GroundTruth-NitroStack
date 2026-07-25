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
 * Seed team. Replace githubUsername values with your own team's real GitHub
 * logins before the demo — crosscheck_activity attributes commits by these.
 */
const SEED: GroundTruthData = {
  employees: [
    {
      id: 'emp-1',
      name: 'Aarav Menon',
      role: 'Backend Engineer',
      teamId: 'team-platform',
      githubUsername: 'Vimaladharsan',
    },
    {
      id: 'emp-2',
      name: 'Divya Raghavan',
      role: 'Frontend Engineer',
      teamId: 'team-platform',
      githubUsername: 'Vimaladharsan',
    },
    {
      id: 'emp-3',
      name: 'Karthik Iyer',
      role: 'Full-stack Engineer',
      teamId: 'team-platform',
      githubUsername: 'Vimaladharsan',
    },
    {
      id: 'emp-4',
      name: 'Meera Nair',
      role: 'QA Engineer',
      teamId: 'team-platform',
      githubUsername: 'Vimaladharsan',
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
}

/** Shared instance — the store is infrastructure, so it is not a DI provider. */
export const store = new Store();

/** Today in YYYY-MM-DD, local time. */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
