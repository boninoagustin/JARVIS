# Active ML gate monitoring — policy v1

## Scope and safety

This is a periodic **post-registration replay**, not a claim that the bot received/applied every requested gate setting, nor a report of broker fills. The dashboard explicitly shows runtime acknowledgment as unknown. No monitor action changes trading configs, thresholds, active model files, risk, orders, or positions. Recommendations require manual decisions; candidate fitting remains a separate manual operation.

## Activation registration

A manual dashboard activation transaction writes the existing asset gate/deployment fields plus:

- Immutable-by-application `ml_gate_activations/{activationId}`: exact deployment, canonical strategy/config snapshot, server request timestamp and `dashboard_requested` provenance.
- `ml_gate_monitor_refs/{ticker}`: current activation pointer/enabled state. Manual OFF changes this pointer to disabled without rewriting the old activation record.

The UI also reads the current pointer: an OFF/ON reactivation of the exact same model cannot reuse an old epoch's metrics. Permission failures abort the entire activation transaction rather than leaving a partly registered gate.

No mtime, inferred training date, or guessed activation date is accepted. Legacy ON settings without matching registration show missing provenance, not invented performance.

## Model and epoch

The server verifies the current own-ticker model file against the deployment's raw SHA256; it never falls back to a generic model. Exact bytes are archived outside active model paths. Authoritative `train_end_ms` and `available_at_ms` are mandatory. Epoch identity binds activation, model, fixed threshold, full strategy config, replay engine and policy version. The start is at least the first verified observation, request time, and model availability; it is never backdated to claim missing history. Config/model/engine mismatches are flagged or start a new clearly identified observation epoch, without mixing old confirmation history.

## Paired evaluation

New current five-timeframe datasets are snapshotted, not restricted to model training files. Full-strategy active/OFF replays run in isolated Node processes with identical config, warmup and bounds. Model, source, auxiliary-file and dataset hashes are checked before/after. Closed finite-R trades exclude terminal censoring and open/unlabelled records. Comparing filtered baseline trades after the fact is not equivalent and is not used.

The report includes cumulative results since monitoring started and the latest 28 available days, with actual dates/data coverage. Data older than 7 days or samples below 30 completed trades in either arm of either window give insufficient evidence. Overlapping cumulative/recent windows are not two independent confirmations. The UI additionally hides expired/mismatched metrics if a timer or API stops refreshing.

## Fixed recommendations

These defaults are established before evaluating data:

- **Maintain:** positive contribution in both windows, with active drawdown no greater than `1.25 * baseline DD + 1R`.
- **Recalibrate signal:** delta no greater than `-2R` in both windows.
- **Disable signal:** delta no greater than `-5R` and active drawdown greater than `baseline DD + 2R` in both windows.
- Other outcomes: observe or insufficient data.

Recalibrate/disable **recommendations** require two same-epoch assessments separated by at least 7 days, increasing data coverage, and new completed trades in both cumulative arms. Multiple manual refreshes cannot manufacture confirmations. Hysteresis resets when evidence/epoch becomes incompatible. Signals never execute actions.

## Candidate versus active versus OFF

Retrospective calibration PnL is never placed beside forward-monitor PnL as if comparable. A compatible candidate needs exact identity/config/feature provenance and a known fixed chosen threshold. Its shared window starts no earlier than model availability, threshold-selection timestamp, and first verified observation of that selection. All three arms must share bounds/context and the baseline must match. Missing provenance, no later data or insufficient samples are explicit; no candidate replacement is automatic.

## Scheduling and operation

- `scripts/ml_gate_monitor.py refresh` runs the serialized monitor, sharing the calibration worker lock.
- `GET /api/ml-gate/monitor/status` reads cached monitoring state.
- `POST /api/ml-gate/monitor/refresh` requests a bounded review, using the existing trusted-Origin/custom-header CSRF guard and rate limit.
- The systemd timer runs Mondays at **09:00 UTC (06:00 Argentina)**, with persistent catch-up. It does not depend on the dashboard being open.
- Runtime archives/history/cache live under ignored `data/ml_gate_monitor/` and must be backed up through private operational backups, not the public source repository.

The installation has no dashboard login; Origin checks are not authentication. The existing remote Firestore rules were inspected read-only and currently allow broad read/write. This task does not change those rules or claim immutable records are cryptographically authenticated. Network/Firestore access hardening requires a separately reviewed change.

## Verification

Tests cover exact identity/availability, current datasets, non-backdating, real production loader behavior using local fixtures, sample/staleness rules, epoch/weekly hysteresis, candidate common-window integrity and UI registration/binding guards. An all-OFF production scan verifies idle behavior without activating or fitting a model. A successful Vite bundle is not a clean full typecheck: pre-existing unrelated TypeScript errors are documented separately.
