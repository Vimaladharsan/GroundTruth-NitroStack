/**
 * Covers the two behaviours added to close known limitations:
 *
 *   1. crosscheck_activity accepts caller-supplied claims, so the model's own
 *      reading of the report beats keyword extraction. Extraction splits on
 *      punctuation and cannot tell "finished X" from "still finishing X".
 *   2. DEMO_AUTOSEED re-seeds history on boot when the store is empty, so a
 *      redeploy — which starts every container with an empty data file — does
 *      not silently leave a demo with nothing to show.
 *
 * Run `npm run build` first, then `npm run test:caveats`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(PROJECT, 'data', 'groundtruth.json');

const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

// A mock GitHub returning one commit that clearly matches "session handling".
const gh = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname === '/rate_limit') return json(200, { resources: { core: { remaining: 5000, limit: 5000 } } });
  if (/\/commits$/.test(url.pathname)) {
    return json(200, [{
      sha: 'f00dfacef00dfacef00dfacef00dfacef00dface',
      html_url: 'https://example.test/c/f00dface',
      author: { login: 'demo-user' },
      commit: {
        message: 'Wire up session handling for the login module',
        author: { date: new Date().toISOString(), email: 'demo@example.test', name: 'Demo User' },
      },
    }]);
  }
  if (/\/pulls$/.test(url.pathname)) return json(200, []);
  return json(404, {});
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
const GITHUB_API_URL = `http://127.0.0.1:${gh.address().port}`;

function connect(extraEnv = {}) {
  const child = spawn('node', [path.join(PROJECT, 'dist/index.js')], {
    cwd: PROJECT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MCP_TRANSPORT_TYPE: 'stdio',
      GITHUB_API_URL,
      GITHUB_TOKEN: 'test-token',
      GITHUB_ORG: 'demo-org',
      GITHUB_REPOS: 'demo-org/demo',
      ...extraEnv,
    },
  });
  const st = { buf: '', pending: new Map(), nextId: 1, stderr: [] };
  child.stdout.on('data', (chunk) => {
    st.buf += chunk.toString();
    let i;
    while ((i = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, i).trim();
      st.buf = st.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && st.pending.has(m.id)) { st.pending.get(m.id).resolve(m); st.pending.delete(m.id); }
    }
  });
  child.stderr.on('data', (d) => st.stderr.push(d.toString()));
  const send = (method, params) => {
    const id = st.nextId++;
    return new Promise((resolve, reject) => {
      st.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (st.pending.has(id)) { st.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 25000);
    });
  };
  const tool = async (name, args) => {
    const r = await send('tools/call', { name, arguments: args });
    const t = r?.result?.content?.find((c) => c.type === 'text')?.text;
    try { return JSON.parse(t); } catch { return t; }
  };
  const ready = async () => {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'caveats', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { child, send, tool, ready, st };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sessions = [];
try {
  // ---- 1. Caller-supplied claims override keyword extraction ----
  {
    const s = connect();
    sessions.push(s);
    await s.ready();
    await s.tool('reset_demo_data', { resetRoster: true });
    await s.tool('set_employee_github', {
      employeeId: 'emp-1', githubUsername: 'demo-user', githubEmail: 'demo@example.test',
    });

    // Wording keyword extraction gets wrong: it sees "finished" and calls it done.
    await s.tool('submit_eod_report', {
      employeeId: 'emp-1',
      reportText: 'Not finished with the login module yet, but I wired up session handling today.',
      confidence: 3,
    });

    const auto = await s.tool('crosscheck_activity', { employeeId: 'emp-1' });
    check('falls back to stored extraction when no claims are passed',
      auto.claimsSuppliedByCaller === false);
    check('warns that the stored extraction is unreliable',
      (auto.observations ?? []).some((o) => /keyword extraction/i.test(o)));

    const supplied = await s.tool('crosscheck_activity', {
      employeeId: 'emp-1',
      claims: [
        { text: 'Wired up session handling', assertsCompletion: true },
        { text: 'Login module still in progress', assertsCompletion: false },
      ],
    });
    check('accepts caller-supplied claims', supplied.claimsSuppliedByCaller === true);
    check('scores the supplied claims, not the stored ones',
      supplied.claimSupport.length === 2
        && supplied.claimSupport.some((c) => /session handling/i.test(c.claim)),
      `${supplied.claimSupport.length} claim(s)`);
    check('the genuinely supported claim now matches the commit',
      supplied.claimSupport.find((c) => /session handling/i.test(c.claim))?.supported === true,
      `verdict=${supplied.verdict} score=${supplied.matchScore}`);
    check('no longer warns about extraction when claims were supplied',
      !(supplied.observations ?? []).some((o) => /keyword extraction/i.test(o)));
    s.child.kill();
  }

  // ---- 2. Auto-seed on boot when the store is empty ----
  {
    fs.rmSync(DATA_FILE, { force: true });
    const s = connect({ DEMO_AUTOSEED: 'true', DEMO_AUTOSEED_DAYS: '3' });
    sessions.push(s);
    await s.ready();
    const digest = await s.tool('generate_daily_digest', { teamId: 'team-platform' });
    const search = await s.tool('search_reports', {});
    // Realistic scale: twelve people over three days, minus the deliberate gaps
    // where someone did not report.
    check('empty store is seeded on boot', search.resultCount === 34,
      `${search.resultCount} report(s)`);
    const people = new Set(search.results.map((r) => r.employee.id));
    const teams = await s.tool('generate_daily_digest', { teamId: 'team-mobile' });
    check('seeded the whole roster', people.size === 12, `${people.size} distinct people`);
    check('seeded the second team too', (teams.rows?.length ?? 0) === 6,
      `team-mobile has ${teams.rows?.length} rows`);
    check('today is still left empty for a live submission',
      digest.summary.submitted === 0, `submitted=${digest.summary.submitted}`);
    check('logged the reseed to stderr', s.st.stderr.join('').includes('[demo] Store was empty'));
    s.child.kill();
  }

  // ---- 3. Auto-seed must never clobber existing reports ----
  {
    const s = connect({ DEMO_AUTOSEED: 'true' });
    sessions.push(s);
    await s.ready();
    await s.tool('submit_eod_report', {
      employeeId: 'emp-1', reportText: 'A real submission that must survive.', confidence: 4,
    });
    s.child.kill();

    const s2 = connect({ DEMO_AUTOSEED: 'true' });
    sessions.push(s2);
    await s2.ready();
    const found = await s2.tool('search_reports', { query: 'must survive' });
    check('existing reports are never overwritten by auto-seed',
      found.resultCount === 1, `${found.resultCount} match(es)`);
    check('declined loudly rather than silently',
      s2.st.stderr.join('').includes('already exist'));
    s2.child.kill();
  }

  // ---- 4. Off by default ----
  {
    fs.rmSync(DATA_FILE, { force: true });
    const s = connect();
    sessions.push(s);
    await s.ready();
    const search = await s.tool('search_reports', {});
    check('does nothing unless DEMO_AUTOSEED is set', search.resultCount === 0,
      `${search.resultCount} report(s)`);
    s.child.kill();
  }
} catch (err) {
  check('harness completed', false, err.message);
} finally {
  for (const s of sessions) { try { s.child.kill(); } catch { /* already dead */ } }
  gh.close();
  fs.rmSync(DATA_FILE, { force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
