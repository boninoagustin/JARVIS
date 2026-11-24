import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cycleCloseHeader, isoCycleWeek, selectCycleInvocation, validateCycleEvidence } from './weekly_digest.js';

// Importing weekly_digest must be side-effect-free: no Firestore initialization,
// systemctl, file reads, Telegram sends or process.exit occurs in these tests.
const START = Date.parse('2026-11-20T22:49:46Z');
const END = Date.parse('2026-11-21T20:00:00Z');
function fixture() {
  const tickers = ['JP225', 'USDCAD'];
  const context = { version: 1, week: '2026-W47', run_id: 'a276ef59-9637-407f-a9fa-afcd6d3146ac', started_at: START, tickers, invocation_id: 'a'.repeat(32) };
  const summary = { version: 1, cycle_week: context.week, cycle_run_id: context.run_id,
    started_at: START, completed_at: END, status: 'completed', tickers,
    counts: { evaluated: 2, skipped: 0, failed: 0 }, errors: [],
    outcomes: tickers.map(ticker => ({ ticker, timestamp: END - 1000, outcome: 'evaluated', status: 'HOLD', deployment_error: null })) };
  const summaryRaw = JSON.stringify(summary);
  const receipt = { version: context.version, week: context.week, run_id: context.run_id, started_at: START, tickers,
    completed_at: END, summary_sha256: createHash('sha256').update(summaryRaw).digest('hex') };
  return { context, receipt, summaryRaw, roster: [...tickers], seal: context.week + '\n', invocationId: context.invocation_id, serviceWeek: context.week, serviceRunId: context.run_id, now: END + 1000 };
}
function rewrite(f: ReturnType<typeof fixture>, change: (s: any) => void) {
  const summary = JSON.parse(f.summaryRaw); change(summary);
  f.summaryRaw = JSON.stringify(summary);
  f.receipt.summary_sha256 = createHash('sha256').update(f.summaryRaw).digest('hex');
}
function invalid(f: ReturnType<typeof fixture>, reason?: RegExp) {
  const result = validateCycleEvidence(f);
  assert.equal(result.complete, false);
  assert.equal(cycleCloseHeader(result.complete), '⚠️ JARVIS — ciclo semanal incompleto');
  if (reason) assert.match(result.reason, reason);
}

test('valid invocation-bound context + receipt + exact summary + full current roster', () => {
  const result = validateCycleEvidence(fixture());
  assert.equal(result.complete, true);
  assert.equal(result.week, '2026-W47');
  assert.match(cycleCloseHeader(result.complete), /finalizado/);
});
test('Friday cycle finishing Monday remains Friday week, not current ISO week', () => {
  const f = fixture(); const monday = Date.parse('2026-11-23T09:00:00Z');
  f.receipt.completed_at = monday;
  rewrite(f, s => { s.completed_at = monday; });
  f.now = monday + 1000;
  assert.equal(isoCycleWeek(f.now), '2026-W48');
  assert.equal(validateCycleEvidence(f).complete, true);
});
test('all skipped is valid only with fully joined current-run proof and complete pool', () => {
  const f = fixture();
  rewrite(f, s => { for (const o of s.outcomes) o.outcome = 'skipped'; s.counts = { evaluated: 0, skipped: 2, failed: 0 }; });
  assert.equal(validateCycleEvidence(f).complete, true);
  f.invocationId = 'b'.repeat(32);
  invalid(f);
});
test('post-only retry may update invocation binding without altering stable receipt identity', () => {
  const f = fixture(); f.context.invocation_id = 'b'.repeat(32); f.invocationId = f.context.invocation_id;
  f.now = Date.parse('2026-11-23T10:00:00Z');
  assert.equal(validateCycleEvidence(f).complete, true);
});
test('successful jobs cannot legitimize prior run context in a new service invocation', () => {
  const f = fixture(); f.invocationId = 'b'.repeat(32); invalid(f, /invocación/);
});
test('missing invocation attribution fails closed', () => { const f = fixture(); f.invocationId = ''; invalid(f); });
test('missing context, receipt, legacy empty marker, and malformed summary fail closed', () => {
  for (const key of ['context', 'receipt'] as const) { const f = fixture(); (f as any)[key] = null; invalid(f); }
  const f = fixture(); (f as any).receipt = ''; invalid(f);
  const g = fixture(); g.summaryRaw = '{'; invalid(g);
});
test('wrong week or run on receipt fails closed', () => {
  for (const [key, value] of [['week', '2026-W46'], ['run_id', 'another-run']] as const) {
    const f = fixture(); f.receipt[key] = value; invalid(f);
  }
});
test('wrong week or run on rehashed summary fails closed', () => {
  for (const key of ['cycle_week', 'cycle_run_id']) { const f = fixture(); rewrite(f, s => { s[key] = 'wrong'; }); invalid(f); }
});
test('context week must match start timestamp; wall-clock weekday cannot bless stale week', () => {
  const f = fixture(); f.context.week = '2026-W46'; f.serviceWeek = '2026-W46'; invalid(f, /Semana/);
});
test('wrong seal is incomplete even with valid Python evidence', () => { const f = fixture(); f.seal = '2026-W46'; invalid(f, /Sello/); });
test('summary byte hash binds exact artifact, not reparsed JSON', () => { const f = fixture(); f.summaryRaw += '\n'; invalid(f, /Hash/); });
test('missing current roster ticker USDCAD is explicitly diagnosed', () => {
  const f = fixture(); f.roster.push('EURUSD');
  // W46 regression: a 44-ticker receipt cannot certify a current 45-ticker roster.
  rewrite(f, s => { s.tickers = ['JP225']; s.outcomes = [s.outcomes[0]]; s.counts.evaluated = 1; });
  f.context.tickers = ['JP225']; f.receipt.tickers = ['JP225'];
  invalid(f, /USDCAD/);
});
test('missing/empty roster fails closed', () => { const f = fixture(); f.roster = []; invalid(f, /Roster/); });
test('summary timestamp must join context start and receipt completion exactly', () => {
  for (const key of ['started_at', 'completed_at']) { const f = fixture(); rewrite(f, s => { s[key] += 1; }); invalid(f); }
});
test('future, inverted, and older than 21d timestamps fail closed', () => {
  const f = fixture(); f.now = START - 1; invalid(f);
  const g = fixture(); g.receipt.completed_at = START - 1; invalid(g);
  const h = fixture(); h.now = START + 22 * 864e5; invalid(h);
});
test('partial outcomes, duplicate tickers, counts mismatch and per-outcome stale timestamps fail closed', () => {
  const changes = [
    (s: any) => { s.outcomes.pop(); },
    (s: any) => { s.outcomes[1].ticker = 'JP225'; },
    (s: any) => { s.counts.evaluated = 1; },
    (s: any) => { s.outcomes[0].timestamp = START - 1; },
    (s: any) => { s.outcomes[0].timestamp = END + 1; },
    (s: any) => { s.outcomes[0].deployment_error = 'write failed'; },
    (s: any) => { s.errors = ['failure']; },
    (s: any) => { s.error = 'runner failed'; },
    (s: any) => { s.status = 'failed'; },
    (s: any) => { s.outcomes[0].status = 'ERROR'; },
    (s: any) => { s.outcomes[0].status = ''; },
    (s: any) => { s.outcomes[0].outcome = 'failed'; s.counts = { evaluated: 1, skipped: 0, failed: 1 }; },
  ];
  for (const change of changes) { const f = fixture(); rewrite(f, change); invalid(f); }
});

function sentinel(f: ReturnType<typeof fixture>) {
  return { MESSAGE: `cycle-context: run=${f.context.run_id} week=${f.context.week} invocation=${f.context.invocation_id}`,
    _SYSTEMD_UNIT: 'jarvis-periodic-opt.service', _SYSTEMD_INVOCATION_ID: f.context.invocation_id };
}
function anchored(f: ReturnType<typeof fixture>, journal: unknown[]) {
  const work = selectCycleInvocation(journal.map(e => JSON.stringify(e)).join('\n'));
  return { ...f, invocationId: work?.invocation_id ?? '', serviceWeek: work?.week ?? '', serviceRunId: work?.run_id ?? '' };
}
test('condition-only fallback after real optimization cannot supersede the work sentinel', () => {
  const f = fixture();
  const journal = [sentinel(f), { MESSAGE: 'skip: ya corrió la semana 2026-W47',
    _SYSTEMD_UNIT: 'jarvis-periodic-opt.service', _SYSTEMD_INVOCATION_ID: 'b'.repeat(32) }];
  assert.equal(validateCycleEvidence(anchored(f, journal)).complete, true);
});
test('new real work sentinel invalidates older context even if subsequent condition is skipped', () => {
  const f = fixture(); const next = fixture();
  next.context.invocation_id = 'b'.repeat(32);
  next.context.run_id = '91cbad4a-f809-4af3-9430-2625dc58cb40';
  next.context.week = '2026-W48';
  const journal = [sentinel(f), sentinel(next), { MESSAGE: 'skip: scout trabajando', _SYSTEMD_INVOCATION_ID: 'c'.repeat(32) }];
  invalid(anchored(f, journal), /invocación/);
});
test('post retry sentinel binds new invocation to original week and stable receipt', () => {
  const f = fixture(); const old = sentinel(f);
  f.context.invocation_id = 'b'.repeat(32);
  f.now = Date.parse('2026-11-23T09:00:00Z');
  assert.equal(validateCycleEvidence(anchored(f, [old, sentinel(f)])).complete, true);
});
test('missing legacy sentinel, malformed newest sentinel and misattribution fail closed', () => {
  const f = fixture();
  invalid(anchored(f, [{ MESSAGE: 'Finished service' }]));
  for (const bad of [
    { ...sentinel(f), MESSAGE: 'cycle-context: broken' },
    { ...sentinel(f), _SYSTEMD_INVOCATION_ID: 'c'.repeat(32) },
    { ...sentinel(f), _SYSTEMD_UNIT: 'other.service' },
  ]) invalid(anchored(f, [sentinel(f), bad]));
  assert.equal(selectCycleInvocation('{'), null);
});
test('sentinel run and week must both join, not merely its invocation', () => {
  const f = fixture(); const other = fixture();
  other.context.run_id = '91cbad4a-f809-4af3-9430-2625dc58cb40';
  invalid(anchored(f, [sentinel(other)]));
  other.context.run_id = f.context.run_id; other.context.week = '2026-W48';
  invalid(anchored(f, [sentinel(other)]));
});
