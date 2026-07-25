/**
 * Deterministic text helpers.
 *
 * These produce *signals*, never verdicts. The agent reading the tool output is
 * what decides whether something matters — see eod.prompts.ts. Keeping the
 * judgement out of here is the whole point of the architecture.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'is', 'was', 'were', 'be', 'been', 'am', 'are', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'we', 'my', 'our', 'you', 'your', 'as', 'but',
  'so', 'then', 'than', 'up', 'out', 'about', 'into', 'over', 'after', 'today',
  'yesterday', 'also', 'just', 'still', 'some', 'more', 'most', 'not', 'no',
  'did', 'do', 'does', 'doing', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'got', 'get', 'work', 'worked', 'working', 'day',
]);

/** Words signalling the writer claims something is finished. */
const COMPLETION_WORDS = [
  'done', 'finished', 'completed', 'complete', 'shipped', 'merged', 'deployed',
  'closed', 'fixed', 'resolved', 'delivered', 'wrapped', 'finalised',
  'finalized', 'landed',
];

/** Words signalling something is in the way. */
const BLOCKER_WORDS = [
  'blocked', 'blocker', 'stuck', 'waiting', 'pending', 'issue', 'problem',
  'broken', 'failing', 'error', 'cannot', "can't", 'unable', 'delayed',
  'held up', 'depends on', 'need help', 'no access', 'access denied',
];

const NEGATIVE_WORDS = [
  'blocked', 'stuck', 'frustrated', 'exhausted', 'tired', 'overwhelmed',
  'confused', 'broken', 'failing', 'struggling', 'behind', 'delayed', 'worried',
  'burnt out', 'burned out', 'stressed',
];

const POSITIVE_WORDS = [
  'done', 'finished', 'shipped', 'great', 'good', 'smooth', 'ahead', 'clean',
  'solved', 'progress', 'happy', 'productive', 'unblocked', 'on track',
];

/** Lowercase content words, stop-words and short tokens removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Splits free text into sentence-ish units suitable for one claim each. */
export function splitClaims(text: string): string[] {
  return text
    .split(/[.!?\n;]+|(?:,\s*(?:and|then)\s+)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

export function assertsCompletion(text: string): boolean {
  const lower = text.toLowerCase();
  return COMPLETION_WORDS.some((w) => lower.includes(w));
}

export function looksLikeBlocker(text: string): boolean {
  const lower = text.toLowerCase();
  return BLOCKER_WORDS.some((w) => lower.includes(w));
}

export function scoreSentiment(text: string): 'positive' | 'neutral' | 'negative' {
  const lower = text.toLowerCase();
  const neg = NEGATIVE_WORDS.filter((w) => lower.includes(w)).length;
  const pos = POSITIVE_WORDS.filter((w) => lower.includes(w)).length;
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

/**
 * Whether two blocker descriptions are the same underlying problem.
 *
 * Exact string equality is useless here. Nobody retypes a blocker identically
 * day after day — "blocked on staging credentials" one day becomes "still
 * waiting on the staging DB credentials from infra" the next. Requiring an exact
 * match meant a blocker stuck for a week read as four unrelated one-day
 * blockers, which silently disables the single most valuable signal this product
 * has: that someone has been stuck for days and nobody noticed.
 *
 * Compares content words and asks whether the shorter description is largely
 * contained in the longer one, so an elaborated retelling still matches.
 */
export function sameBlocker(a: string, b: string): boolean {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return false;

  const [smaller, larger] =
    aTokens.size <= bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens];
  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared++;

  // 0.6 tolerates rewording and added detail without merging distinct blockers.
  return shared / smaller.size >= 0.6;
}

/**
 * Groups blocker descriptions that describe the same problem.
 * Returns one entry per distinct blocker, with the dates it appeared on and the
 * most recent wording — which is the version worth showing a manager.
 */
export function groupBlockerRuns(
  entries: Array<{ date: string; blocker: string }>,
): Array<{ blocker: string; dates: string[] }> {
  const runs: Array<{ blocker: string; dates: string[] }> = [];

  // Oldest first, so the newest wording ends up as the label.
  for (const { date, blocker } of [...entries].sort((x, y) => x.date.localeCompare(y.date))) {
    const existing = runs.find((r) => sameBlocker(r.blocker, blocker));
    if (existing) {
      existing.blocker = blocker;
      if (!existing.dates.includes(date)) existing.dates.push(date);
    } else {
      runs.push({ blocker, dates: [date] });
    }
  }

  return runs;
}

/**
 * Fraction of the claim's content words that appear in the evidence text.
 * A blunt instrument by design — the agent interprets it, and a low score on
 * its own is not proof of anything.
 */
export function overlapRatio(claim: string, evidence: string): number {
  const claimTokens = [...new Set(tokenize(claim))];
  if (claimTokens.length === 0) return 0;
  const evidenceTokens = new Set(tokenize(evidence));
  const hits = claimTokens.filter((t) => evidenceTokens.has(t)).length;
  return hits / claimTokens.length;
}
