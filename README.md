# GroundTruth

**AI agent for EOD-driven team intelligence in IT companies.**

Employees write one honest paragraph a day. GroundTruth's MCP agent verifies it against what actually happened in GitHub, and tells managers only what really matters — before they have to ask.

Built for the **NitroStack × Amrita University Hackathon** — Track: Enterprise AI & Workplace Automation.

---

## The problem

Every IT company runs on End-of-Day reports, and the process is broken. Reports scatter across Slack, email, and spreadsheets. Managers skim ten to twenty a day without verifying any of them. What someone *claims* — "finished the login module" — often doesn't match what actually landed in GitHub, and nobody checks. By the time a recurring blocker surfaces in a standup, three or four days of productivity are already gone.

There is no system that verifies self-reported work against real activity, and none that proactively tells a manager what needs their attention instead of making them dig for it.

## The solution

GroundTruth is an MCP server that reads daily EOD reports, cross-checks them against live GitHub activity, and surfaces only what genuinely needs a manager's attention.

The important design decision: **every tool in this project is deterministic.** They fetch, diff, store, and notify. Not one of them decides whether something matters. That judgement lives in the `review_eod_submission` prompt, where the connected model reasons over the evidence and chooses its own next action. A scoring function with hardcoded thresholds would be an if-statement wearing a costume — this is what makes GroundTruth an agent rather than a report parser.

### The agent loop

For each submitted report, the model works through:

1. **Perceive** — read the report and the claims parsed out of it (`extract_eod_summary`)
2. **Verify** — pull the employee's real commits and PRs for that date (`crosscheck_activity`)
3. **Reason** — weigh claimed work against real activity, and against prior days' blockers
4. **Decide** — nothing to raise / worth noting / raise at standup / needs attention today
5. **Act** — call `send_manager_alert` only where it judged one warranted

The prompt explicitly instructs the model that a low match score is *not* on its own a reason to alert: meetings, design work, pairing, and code review all legitimately leave no commit trail. An agent that stays quiet when nothing is wrong is more useful than one that cries wolf.

## Architecture

```
src/
├── app.module.ts            # registers the three feature modules
├── index.ts                 # bootstrap
├── lib/
│   ├── text.ts              # claim / blocker / sentiment extraction (deterministic)
│   └── uri.ts               # URI-template parameter matching for resources
├── store/
│   ├── store.ts             # single-file JSON persistence
│   └── types.ts             # domain types
└── modules/
    ├── eod/                 # what people say they did, + the agent loop prompts
    ├── github/              # what actually happened, per the GitHub API
    └── alerts/              # how the agent escalates to a human
```

### Tools

| Tool | Purpose |
|---|---|
| `open_eod_form` | Renders the submission form widget |
| `submit_eod_report` | Stores a report and pre-parses claims, blockers, sentiment |
| `extract_eod_summary` | Re-parses a stored report into structured claims |
| `crosscheck_activity` | Pulls live GitHub commits/PRs and scores claim support |
| `send_manager_alert` | Raises an alert — called only when the agent decides to |
| `resolve_manager_alert` | Clears a handled alert |
| `generate_daily_digest` | Builds the manager's dashboard, ordered by attention needed |

### Resources

| URI | Contents |
|---|---|
| `team://employees` | Team roster with GitHub usernames |
| `eod://reports/{employeeId}/{date}` | One report plus its cross-check result |
| `github://commits/{employeeId}` | Today's commits, live from GitHub |
| `github://pull-requests/{employeeId}` | Today's PRs, live from GitHub |
| `alerts://team/{teamId}` | Open alerts for a team |

### Prompts

| Prompt | Purpose |
|---|---|
| `review_eod_submission` | The core agent loop for one employee |
| `review_team_day` | Runs the loop across a whole team, then renders the digest |

### Widgets

| Widget | Shown by |
|---|---|
| `eod-form` | `open_eod_form` — employee submission form |
| `crosscheck-result` | `crosscheck_activity` — claimed vs. actual, side by side |
| `team-digest` | `generate_daily_digest` — manager dashboard |

## Environment setup

Requires Node.js 20.x (18+ minimum) and npm.

```bash
npm install -g @nitrostack/cli
```

Copy the example env file and fill in your own values — **never commit `.env`**:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | yes | GitHub Personal Access Token (classic), `repo` read scope. Used by `crosscheck_activity`. |
| `GITHUB_ORG` | yes | GitHub org or username owning the repos to inspect |
| `GITHUB_REPOS` | no | Comma-separated repos to restrict the check to. Blank scans the org's 30 most recently pushed repos. |
| `NITRO_LOG_LEVEL` | no | Defaults to `info` |

Before demoing, set each employee's `githubUsername` in `src/store/store.ts` to a real GitHub login, so commits attribute to the right person.

## Installation

```bash
git clone https://github.com/Vimaladharsan/GroundTruth-NitroStack.git
cd GroundTruth-NitroStack
npm install
npm run dev
```

Then connect the project in **NitroStudio**: *Add Server → Nitro Project*, browse to this folder, and open it in **Studio App Canvas**.

## Usage

1. Run `open_eod_form` and submit a report through the widget — try a deliberately vague claim like "worked on auth, mostly done".
2. In Studio's **AI Chat**, run the `review_eod_submission` prompt for that employee. Watch the agent call `crosscheck_activity`, reason about the gap out loud, and decide whether to alert.
3. Run `generate_daily_digest` to see the manager's dashboard, worst row first.

## Testing

```bash
npm run verify
```

Builds the project, then drives the running MCP server over stdio through the full path — registration, submission, extraction, cross-check, alerting, digest ordering, and prompt retrieval. 18 assertions; exits non-zero on any failure.

`crosscheck_activity` passes with or without a token: with one it hits the real GitHub API, without one it must return a clear configuration error rather than crashing.

## Deployment

Deployed to NitroCloud, with this repository's default branch connected for auto-deploy on push. See the NitroStack Studio Handbook for the Studio deploy flow and GitHub auto-deploy setup.

## License

MIT — see [LICENSE](LICENSE).
