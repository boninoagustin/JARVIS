import json, glob, os

def fmt(x, nd=2):
    return f"{x:.{nd}f}" if isinstance(x, (int, float)) else str(x)

print(f"{'ticker':<9} | {'split':<6} | {'netPnL base':>11} | {'netPnL rej':>10} | {'Δ rej':>7} | {'netPnL def':>10} | {'Δ def':>7} | {'PF rej b→f':>11} | {'MaxDD rej b→f':>14}")
print("-" * 105)

tot_def, tot_rej = {}, {}
for p in sorted(glob.glob('/opt/JARVIS/scripts/timesfm/ab_out/*/ab_report.json')):
    t = os.path.basename(os.path.dirname(p)).replace('_15', '').upper()
    r = json.load(open(p))
    rj_path = p.replace('ab_report.json', 'ab_report_rej.json')
    rj = json.load(open(rj_path)) if os.path.exists(rj_path) else None
    b, f = r.get('baseline', {}), r.get('timesfm', {})
    bj, fj = (rj.get('baseline', {}), rj.get('timesfm', {})) if rj else (None, None)
    for split, key in [('train', 'metrics'), ('oos', 'metrics_oos')]:
        bm = b.get(key) or {}
        fm = f.get(key) or {}
        fjm = (fj or {}).get(key) or {}
        if not bm and not fm:
            continue
        nb, nf, nj = bm.get('net_pnl_r'), fm.get('net_pnl_r'), fjm.get('net_pnl_r')
        d_def = nf - nb if isinstance(nb,(int,float)) and isinstance(nf,(int,float)) else None
        d_rej = nj - nb if isinstance(nb,(int,float)) and isinstance(nj,(int,float)) else None
        pf_b, pf_r = fm.get('profit_factor'), fjm.get('profit_factor')
        dd_b, dd_r = bm.get('max_drawdown_r'), fjm.get('max_drawdown_r')
        print(f"{t:<9} | {split:<6} | {fmt(nb):>11} | {fmt(nj):>10} | {fmt(d_rej,1):>7} | {fmt(nf):>10} | {fmt(d_def,1):>7} | {fmt(pf_b)+'→'+fmt(pf_r):>11} | {fmt(dd_b)+'→'+fmt(dd_r):>14}")
        if d_def is not None: tot_def.setdefault(t, []).append((split, d_def))
        if d_rej is not None: tot_rej.setdefault(t, []).append((split, d_rej))
    print("-" * 105)

print("\n=== Resumen Δ netPnL OOS: default vs solo-REJECT ===")
print(f"{'ticker':<9} {'default':>8} {'solo-REJECT':>12}")
for t in sorted(tot_def):
    d_oos = [d for s, d in tot_def[t] if s == 'oos']
    r_oos = [d for s, d in tot_rej[t] if s == 'oos']
    if d_oos and r_oos:
        print(f"{t:<9} {d_oos[0]:>+8.1f} {r_oos[0]:>+12.1f}")
