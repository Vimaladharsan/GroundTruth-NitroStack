# GroundTruth

**AI agent for EOD-driven team intelligence in IT companies.**

Employees write one honest paragraph a day. GroundTruth's MCP agent verifies it against what actually happened in GitHub, and tells managers only what really matters — before they have to ask.

Built for the **NitroStack × Amrita University Hackathon** — Track: Enterprise AI & Workplace Automation.

---

## Overview

Every IT company runs on End-of-Day (EOD) reports, and the process is broken: reports are scattered, managers skim without verifying, and what an employee *claims* ("finished the login module") often doesn't match what actually happened in GitHub. By the time a blocker surfaces in standup, days of productivity are already lost.

GroundTruth is an MCP (Model Context Protocol) server, built on the NitroStack TypeScript SDK, that:

1. Accepts free-text EOD reports from employees (via a widget-backed tool).
2. Extracts structured claims from the report (tasks, blockers, sentiment).
3. Cross-checks those claims against real GitHub commit/PR activity.
4. Lets the connected AI agent *reason* about whether anything needs a manager's attention — not a hardcoded threshold, a live model decision.
5. Surfaces a ranked daily digest to managers, and proactively alerts on repeated or significant mismatches.

## Architecture

```
Employee submits EOD  ──►  submit_eod_report (tool + form widget)
                                     │
                                     ▼
                          extract_eod_summary (tool)
                                     │
                                     ▼
                          crosscheck_activity (tool)
                          — pulls live GitHub commits/PRs —
                                     │
                                     ▼
                 review_eod_submission (MCP Prompt)
                 — agent reasons over claims vs. activity —
                                     │
                            reasoning decides
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                                ▼
            send_manager_alert (tool)        generate_daily_digest
                                              (tool + dashboard widget)
```

**Resources:** `eod://reports/{employeeId}/{date}`, `github://commits/{employeeId}`, `github://pull-requests/{employeeId}`, `alerts://team/{teamId}`

**Tools:** `submit_eod_report`, `extract_eod_summary`, `crosscheck_activity`, `send_manager_alert`, `generate_daily_digest`

**Prompt:** `review_eod_submission` — runs the perceive → reason → decide → act loop

## Environment Setup

Requires Node.js 20.x (18+ minimum), npm, and the NitroStack CLI.

```bash
node -v   # confirm 18+ (20.x recommended)
npm install -g @nitrostack/cli
```

Copy the example env file and fill in your own values — **never commit `.env`**:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token, `repo` read scope — used by `crosscheck_activity` to pull real commit/PR data |
| `GITHUB_ORG` | GitHub org/username the team's repos live under |

## Installation

```bash
git clone https://github.com/<your-org>/GroundTruth-NitroStack.git
cd GroundTruth-NitroStack
npm install
npm run dev
```

This starts the MCP server and widget dev server. Connect the project in **NitroStudio** via *Add Server → Nitro Project* and open it in **Studio App Canvas** to explore Tools, Resources, and Prompts.

## Usage

1. Submit an EOD report through the `submit_eod_report` widget (or call the tool directly from Studio's Tools page).
2. In Studio's **AI Chat**, run the `review_eod_submission` prompt for an employee/date — watch the agent call `extract_eod_summary` and `crosscheck_activity`, reason over the result, and decide whether to alert.
3. Open `generate_daily_digest` to see the ranked team summary for the day.

## Deployment

Deployed via NitroCloud, connected to this repository's default branch for auto-deploy on push. See the NitroStack Studio Handbook for the Studio → Deploy flow and GitHub auto-deploy setup.

## License

MIT — see [LICENSE](LICENSE).
