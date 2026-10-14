import json, glob, os

def fmt(x, nd=2):
    if isinstance(x, (int, float)):
        return f"{x:.{nd}f}"
    return str(x)

print(f"{'ticker':<9} | {'split':<6} | {'trades':>7} | {'PF':>7} | {'netPnL R':>9} | {'MaxDD':>7} | {'WR%':>6} | {'exp R':>7}")
print("-" * 82)

tot = {}
for p in sorted(glob.glob('/opt/JARVIS/scripts/timesfm/ab_out/*/ab_report.json')):
    t = os.path.basename(os.path.dirname(p)).replace('_15', '').upper()
    r = json.load(open(p))
    b, f = r.get('baseline', {}), r.get('timesfm', {})
    for split, key in [('train', 'metrics'), ('oos', 'metrics_oos')]:
        bm = b.get(key) or {}
        fm = f.get(key) or {}
        if not bm and not fm:
            continue
        row = f"{t:<9} | {split:<6} | {str(b.get('trade_count','?')):>7} | {fmt(bm.get('profit_factor')):>7} | {fmt(bm.get('net_pnl_r')):>9} | {fmt(bm.get('max_drawdown_r')):>7} | {fmt(bm.get('win_rate', 1)*100, 1):>6} | {fmt(bm.get('expectancy'), 3):>7}   ← baseline"
        print(row)
        row2 = f"{'':<9} | {split:<6} | {str(f.get('trade_count','?')):>7} | {fmt(fm.get('profit_factor')):>7} | {fmt(fm.get('net_pnl_r')):>9} | {fmt(fm.get('max_drawdown_r')):>7} | {fmt(fm.get('win_rate', 1)*100, 1):>6} | {fmt(fm.get('expectancy'), 3):>7}   ← filtrado"
        print(row2)
        nb = bm.get('net_pnl_r'); nf = fm.get('net_pnl_r')
        if isinstance(nb, (int, float)) and isinstance(nf, (int, float)):
            tot.setdefault(t, []).append((split, nf - nb))
    fa = r.get('filter_actions') or {}
    deg = r.get('degraded', 0)
    print(f"{'':<9} | acciones: {fa} | degradados: {deg}")
    print("-" * 82)

print("\n=== Δ netPnL (filtrado − baseline) por activo ===")
for t in sorted(tot):
    parts = " ".join(f"{s}:{d:+.1f}R" for s, d in tot[t])
    print(f"  {t:<9} {parts}")
