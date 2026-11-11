#!/bin/bash
# Revalida TimesFM: collect triggers → forecast as-of → A/B, para los tickers activos.
# Solo lectura de config + escritura de cachés JSONL. No toca Firestore ni asset_configs.
set -u
cd /opt/JARVIS
export PATH=/root/.nvm/versions/node/v24.19.0/bin:$PATH
PY=/opt/JARVIS/scripts/timesfm/.venv/bin/python
OUT=/opt/JARVIS/scripts/timesfm/revalidate_results.jsonl

TICKERS="AUDCAD AUDJPY BTCUSD EUROPE50 EURUSD GBPJPY GBPUSD GER40 NZDUSD US500 USDCAD USDJPY USOIL XAUUSD"

for t in $TICKERS; do
  tl=$(echo "$t" | tr 'A-Z' 'a-z')
  echo "=== $t: collect triggers ==="
  node --import tsx scripts/collect_production_triggers.ts "$t" >/dev/null 2>&1 || { echo "  [$t] collect FAIL"; continue; }
  echo "=== $t: forecast as-of ==="
  "$PY" scripts/timesfm/precompute_forecasts.py --ticker "$tl" --tf M5 \
    --triggers "logs/$tl/forecasts/triggers_production.jsonl" \
    --out "logs/$tl/forecasts/forecasts_m5.jsonl" 2>&1 | tail -1
  echo "=== $t: A/B ==="
  node --import tsx scripts/timesfm_sweep.ts "$t" 2>/dev/null | grep -vE 'MLFilter|BIAS-DERIVE|TP2CAP|Train=' > "/tmp/ab_$t.json" 2>/dev/null
  python3 - "$t" <<'EOF'
import json,sys
t=sys.argv[1]
try:
    r=json.load(open(f"/tmp/ab_{t}.json"))
    if r.get("status")=="valid":
        b=r["baseline"]; c=r["candidate"]
        print(f"  [{t}] VALID  n={b['n']}/{c['n']}  pnlR={b['pnlR']:.2f}→{c['pnlR']:.2f}  delta={r['delta']:+.2f}R")
        rec={"ticker":t,"status":"valid","baseline_n":b["n"],"candidate_n":c["n"],"baseline_pnlR":b["pnlR"],"candidate_pnlR":c["pnlR"],"delta":r["delta"]}
    else:
        print(f"  [{t}] {r.get('status')} {r.get('reasons')}")
        rec={"ticker":t,"status":r.get("status"),"reasons":r.get("reasons")}
except Exception as e:
    print(f"  [{t}] ERROR {e}")
    rec={"ticker":t,"status":"error","reasons":[str(e)]}
with open("/opt/JARVIS/scripts/timesfm/revalidate_results.jsonl","a") as f:
    f.write(json.dumps(rec)+"\n")
EOF
done
echo "=== ALL DONE ==="
