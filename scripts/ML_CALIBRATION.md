# ML calibration panel

AUDCAD gate was disabled through a single-field Firestore merge (`mlGateEnabled: false`) and read back as false. No model was deployed.

## Eligibility and counter

The dashboard keeps the ML section for the union of the official roster and stored asset configs. Collection runs only for TRADE assets: `enabled === true` and no nonempty `disabledReason`. Existing model files do not restrict the roster.

The backend uses the production config mapper and the trainer's existing temporal collector. Counts are accepted, labelled, closed trades in the actual Train/Validation partitions, after overlap/unlabelled exclusions. It requires at least 50 Train samples (the existing MLFilter runtime loading floor), 20 Validation samples, AND both WIN/LOSS classes in EACH partition. A total trade count is not sufficient by itself. The trainer's base floor of 20 Train samples alone would produce candidates that the live runtime rejects. Counts are refreshed at most every 15 minutes while the dashboard requests status; the browser polls every 30 seconds. The timestamp is displayed. These are replay training-data counts, not a raw count of live journal documents.

Missing history/errors are shown as unavailable, not zero. Assets outside TRADE remain visible but cannot recalibrate.

## Recalibrate

`GET /api/ml-gate/status` returns cached progress and schedules a serialized refresh. `POST /api/ml-gate/recalibrate?ticker=T` rechecks production eligibility and current data. Only isolated candidate artifacts are written; no active model, asset config, risk, minScore, or order is changed. New candidates still require separate return-based validation before activation; training accuracy is not evidence of profitability.

Unknown legacy data provenance / first calibration requires explicit bootstrap confirmation. This only permits initializing a new freshness reference; partition and label guards remain enforced. Known insufficient freshness / identical datasets must not be bypassed.

The installation has no dashboard login. The endpoints use the existing trusted-dashboard deployment model with an allowed Origin, custom POST header, strict ticker validation, rate limits and worker serialization. Origin checks are CSRF protection, NOT authentication or internet access control. Network access should be restricted to trusted operators.

## Verification

- `node --import tsx --test jarvis-os/src/services/mlCalibration.test.ts`
- Vite production build.
- Backend unit tests and exact production readiness refresh.
- Existing full TypeScript build has nine unrelated pre-existing errors; a successful Vite bundle is not a clean typecheck.

Prior comparisons on nine legacy models were exploratory and do not prove all models unprofitable. Differences in historical sample counts / baseline win rates alone do not prove the old training data were broken. Exact production model-loading behavior was not established solely by the absence of a deployment field.
