# Weekly cycle identity and completion evidence

Fix 2026-11-24: the W46 recovery selected W46 after constructing a W47 PYDONE filename.
That empty file later suppressed the actual W47 Python run. Postprocessors reused the
W46 sidecar, sealed W46 again and the digest incorrectly announced a full new cycle.

## Contract

- `weekly_cycle_context.json`: version 1, original ISO UTC `week`, UUID `run_id`,
  `started_at` milliseconds, explicit frozen `tickers`, latest actual service
  `invocation_id`. Updated atomically and read back before Python **or post-only retry**.
- `run_weekly.py` receives the exact context roster via `--tickers` and the context
  path via `JARVIS_WEEKLY_CONTEXT`. Progress/summary carry `cycle_run_id`, `cycle_week`
  and the original `started_at`; mismatched resume identities are rejected.
- `weekly_python_done_<week>` is JSON, NOT an empty marker: original cycle fields,
  completion time and SHA256 of exact `weekly_selection_summary.json` bytes.
- A successful Python exit alone is insufficient. The helper validates the summary
  coverage, outcome dates/counts/statuses and absence of errors before writing receipt.
- The seal/tune producer validates context+receipt+summary again. No completion-week
  fallback; `weekly_cycle_week` is compatibility information only, never proof.
- Continuation uses the SAME UUID as the cycle, does not overwrite an outstanding
  different run, and does not enqueue a duplicate completed/started run.
- Digest checks the frozen roster against the current actual Firestore roster,
  receipt/hash, cycle seal, and the last invocation that emitted `cycle-context:`.
  A later fallback ExecCondition skip must not replace the real work invocation.
- The unsafe per-ticker timestamp/status-only resume shortcut was removed. Resume
  uses the original input-aware certified selection freshness path. This may take
  longer when inputs changed, intentionally; it does not certify live/replay parity.

## Recovery behavior

Empty legacy PYDONE files are ignored, never migrated into receipts without evidence.
Old summaries are retained as historical evidence and are never relabelled to a newer
week. Corrupt/future context, inconsistent ordering, changed roster during an unfinished
cycle, unbound legacy progress, or context older than 21 days require operator inspection
(fail closed). This deliberately prefers a visible recovery requirement over a false
successful cycle after long downtime. A complete unsealed cycle can retry postprocessors
with its own original identity even across Monday. A sealed prior cycle allows creation
of a fresh current-week context. There is no automatic backdated W47 replay.

## Production repair on 2026-11-24

Archive the empty legacy W45/W47 receipts with the old week sidecar and summary in a
separate dated directory under `/var/lib/jarvis`. Keep the historical W46 seal. Do not
invent a W47 context/receipt, edit candidate/asset configs, restart the bot or start
optimization as part of this repair. `run_weekly_guard.sh --check` and helper `plan`
are safe read-only dry checks of the new decision (check still ensures state dir exists).
A missed cycle remains missed until an operator explicitly starts a new real run.
The repaired scripts are read fresh on the next service start; no bot restart is needed.

## Isolated regression suites

```bash
cd /opt/JARVIS/scripts/periodic_opt
python3 -m unittest test_weekly_cycle_state test_weekly_main test_weekly_rollout_dispatch test_selection_freshness test_weekly_integrity
cd /opt/JARVIS
bash scripts/ops/test_weekly_continuation.sh
node --import tsx --test scripts/ops/weekly_digest.test.ts
```

All tests use synthetic metrics and temporary state; they prove orchestration safety,
not profitability. No trading engine thresholds or optimizer search parameters change.
