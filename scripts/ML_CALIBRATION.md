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

## Candidate return comparison

Recalibration now evaluates the saved candidate against ML OFF in its declared Validation window, using the same immutable strategy config, dataset and pre-validation warmup. Each arm runs in a separate Node process. The ON arm must load the exact candidate raw SHA256 through the production loader and prove the gate/threshold are active; missing or rejected models cannot silently pass as a no-op. The threshold stays fixed at 0.65; this comparison does not tune it.

The status worker also supports `compare --ticker JP225` to evaluate an existing candidate without fitting again. The candidate remains immutable. Results are stored separately in the calibration cache and survive status refresh only while candidate, data, replay source and current config remain compatible.

The panel shows **only the current candidate's comparison**, bound to both its path and raw SHA256. Legacy `ml_gate_evals` PnL and model names are not displayed in this section. Stored old evidence is retained for audit, not deleted or reinterpreted as evidence for a new model.

Return metrics use genuinely completed finite-R replay trades including BE/TIMEOUT/REVERSAL, excluding OPEN/unlabelled and terminal-censored trades. Thus sample counts can differ from training's WIN/LOSS-only labels. This runs the full strategy for both arms rather than filtering baseline trades after the fact, so blocked entries can affect subsequent strategy decisions.

This is a **retrospective Validation diagnostic**, not prospective execution evidence or an untouched final Test. The candidate was trained in the present; historical inference is deliberately reconstructed after its declared training cutoff, not claimed to have been available then. Accuracy or positive validation PnL alone never authorizes deployment. Activation still requires valid, separate evidence for the exact candidate, threshold and current config. No deployment/config/order changes are part of comparison.

## Verification

- `node --import tsx --test jarvis-os/src/services/mlCalibration.test.ts`
- Vite production build.
- Backend unit tests and exact production readiness refresh.
- Existing full TypeScript build has nine unrelated pre-existing errors; a successful Vite bundle is not a clean typecheck.

Prior comparisons on nine legacy models were exploratory and do not prove all models unprofitable. Differences in historical sample counts / baseline win rates alone do not prove the old training data were broken. Exact production model-loading behavior was not established solely by the absence of a deployment field.
