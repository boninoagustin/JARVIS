#!/usr/bin/env python3
"""Shadow scan DSR (10-oct-2026) sobre los RECOMMEND de la corrida 3-4 oct.

Espera a que el dominical de HOY termine (proceso run_weekly.py), re-corre
eval_production.ts por ticker RECOMMEND (serie oos_r real de producción),
calcula el DSR con los n_trials del opt_out correspondiente y escribe
reports/dsr_shadow_scan.json.

NO muta nada: solo lee y calcula.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = Path("/opt/JARVIS")
RECOMMEND = ["EUROPE50", "FRA40", "NL25", "USDCAD", "USOIL"]
DEADLINE_H = 14  # dominical peor caso 12h; tope extra


def dominical_vivo() -> bool:
    r = subprocess.run(["pgrep", "-f", "run_weekly.py"], capture_output=True, text=True)
    return r.returncode == 0


def main() -> int:
    deadline = time.time() + DEADLINE_H * 3600
    print(f"Esperando fin del dominical (tope {DEADLINE_H}h)...", flush=True)
    while dominical_vivo() and time.time() < deadline:
        time.sleep(120)
    if dominical_vivo():
        print("TOPE alcanzado y el dominical sigue vivo — aborto el scan (sin interferir).", flush=True)
        return 1
    print("Dominical terminado. Corriendo eval_production por ticker RECOMMEND...", flush=True)

    sys.path.insert(0, str(HERE))
    from dsr import deflated_sharpe

    results = {}
    for t in RECOMMEND:
        try:
            opt = json.load(open(HERE / "opt_out" / f"{t}.json"))
            trials = int(opt.get("n_trials") or 0)
        except Exception:
            trials = 0
        print(f"\n== {t} (n_trials={trials}) ==", flush=True)
        r = subprocess.run(
            ["npx", "tsx", str(HERE / "eval_production.ts"), t],
            cwd=str(REPO), capture_output=True, text=True, timeout=45 * 60,
        )
        log = HERE / "reports" / f"dsr_scan_eval_{t}.log"
        log.write_text((r.stdout or "") + (r.stderr or ""))
        line = None
        for ln in reversed((r.stdout or "").splitlines()):
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    line = json.loads(ln)
                    break
                except json.JSONDecodeError:
                    pass
        if not line or "oos_r" not in line:
            results[t] = {"error": f"eval_production sin oos_r (exit={r.returncode}); log en {log.name}"}
            print(f"  ERROR: {results[t]['error']}", flush=True)
            continue
        oos_r = [float(x) for x in (line.get("oos_r") or [])]
        d = deflated_sharpe(oos_r, trials)
        results[t] = {"trials": trials, **d}
        if d.get("skip"):
            print(f"  skip: {d.get('note')}", flush=True)
        else:
            print(f"  sr={d['sr']} | barra={d['selection_bar']} | dsr={d['dsr']} → {d['verdict']}", flush=True)

    out = HERE / "reports" / "dsr_shadow_scan.json"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    killed = [t for t, v in results.items() if not v.get("skip") and not v.get("error") and v.get("verdict") == "BELOW"]
    skipped = [t for t, v in results.items() if v.get("skip")]
    errored = [t for t, v in results.items() if v.get("error")]
    print("\n════ RESULTADO SHADOW SCAN ════", flush=True)
    print(f"RECOMMEND que el DSR habría degradado: {len(killed)} de {len(RECOMMEND)}", flush=True)
    if killed:
        print(f"  → {killed}", flush=True)
    if skipped:
        print(f"Skip (muestra chica): {skipped}", flush=True)
    if errored:
        print(f"Errores: {errored}", flush=True)
    print(f"Detalle: {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
