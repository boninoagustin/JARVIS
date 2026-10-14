#!/usr/bin/env python3
"""Lista los RECOMMEND de la corrida pasada (reports/*.json) para el shadow scan DSR."""
import glob
import json
import os

recs = []
statuses = {}
for p in sorted(glob.glob("reports/*.json")):
    name = os.path.basename(p).replace(".json", "")
    try:
        d = json.load(open(p))
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    status = d.get("status", "?")
    statuses[status] = statuses.get(status, 0) + 1
    if status == "RECOMMEND":
        mc = d.get("montecarlo")
        mc_n = mc.get("n") if isinstance(mc, dict) else None
        po = d.get("production_oos") or {}
        recs.append({"ticker": name, "mc_n": mc_n,
                     "prod_oos_trades": po.get("trade_count") if isinstance(po, dict) else None,
                     "delta": (d.get("delta") or {}).get("d_exp_oos") if isinstance(d.get("delta"), dict) else None})

print("STATUSES:", statuses)
print()
print(f"RECOMMEND ({len(recs)}):")
for r in recs:
    print(f"  {r['ticker']}: MC n={r['mc_n']}, prod OOS trades={r['prod_oos_trades']}, d_exp_oos={r['delta']}")
