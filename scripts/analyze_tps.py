import json
from collections import Counter

trades = json.load(open('/opt/JARVIS/logs/trade_journal_export.json'))
closed = [t for t in trades if t.get('result') in ('WIN', 'LOSS', 'BREAKEVEN')]
print(f"Cerradas (WIN/LOSS/BE): {len(closed)} de {len(trades)}")

tp1 = [t for t in closed if t.get('tp1Hit')]
tp2 = [t for t in closed if t.get('tp2Hit')]
wins = [t for t in closed if t.get('result') == 'WIN']
print(f"Tocaron TP1 (parcial): {len(tp1)} ({100*len(tp1)/max(1,len(closed)):.0f}%)")
print(f"Tocaron TP2 (o cerraron por TP2): {len(tp2)} ({100*len(tp2)/max(1,len(closed)):.0f}%)")
print(f"WINs: {len(wins)} ({100*len(wins)/max(1,len(closed)):.0f}%)")

# R de los wins
rs = [t.get('rMultiple') for t in wins if t.get('rMultiple') is not None]
print(f"\nR de los WINs: {sorted(round(r,2) for r in rs)}")
if rs:
    print(f"  media {sum(rs)/len(rs):.2f}R, max {max(rs):.2f}R")

# ¿de los wins, cuántos llegaron a TP2 vs salieron antes (ROI/parcial)?
wins_tp2 = [t for t in wins if t.get('tp2Hit')]
print(f"WINs que llegaron a TP2: {len(wins_tp2)}/{len(wins)}")

# parciales cobrados
part = [t for t in closed if t.get('tp1PartialPnlUsd') is not None]
print(f"\nParciales TP1 cobrados (USD): {len(part)}")
if part:
    vals = [t.get('tp1PartialPnlUsd') for t in part]
    print(f"  valores: {sorted(round(v,2) for v in vals if v is not None)}")

# distribución de rMultiple
rs_all = [t.get('rMultiple') for t in closed if t.get('rMultiple') is not None]
print(f"\nDistribución rMultiple ({len(rs_all)} cerradas):")
bins = Counter()
for r in rs_all:
    if r <= -1: bins['≤ -1R'] += 1
    elif r < 0: bins['-1..0R'] += 1
    elif r == 0: bins['0 (BE)'] += 1
    elif r < 0.5: bins['0..0.5R'] += 1
    elif r < 1.5: bins['0.5..1.5R'] += 1
    elif r < 2.5: bins['1.5..2.5R'] += 1
    else: bins['> 2.5R'] += 1
for k in ['≤ -1R','-1..0R','0 (BE)','0..0.5R','0.5..1.5R','1.5..2.5R','> 2.5R']:
    print(f"  {k:<10} {bins.get(k,0)}")

# distancia TP2 vs entry en R, y cuánto corre el trade antes de cerrar (slPrice final vs entry cuando gana)
print("\nTP2 distance (R) de los wins:", end=" ")
for t in wins[:12]:
    e, tp2, sl = t.get('entryPrice'), t.get('tp2Price'), t.get('slPrice')
    if e and tp2 and sl:
        dist = abs(tp2-e)/abs(e-sl) if abs(e-sl)>0 else None
        print(f"{t.get('ticker')}:{round(dist,1) if dist else '?'}R", end=" ")
print()
