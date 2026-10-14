import json, datetime
from collections import Counter

trades = json.load(open('/opt/JARVIS/logs/trade_journal_export.json'))

def ts(x):
    if x is None: return None
    if isinstance(x, str):
        try:
            x = float(x)
        except ValueError:
            return None
    try:
        return datetime.datetime.fromtimestamp(x/1000, tz=datetime.timezone(datetime.timedelta(hours=2)))
    except (TypeError, OSError, ValueError):
        return None

be = [t for t in trades if t.get('result') == 'BREAKEVEN']
print(f"Total BREAKEVEN en el journal: {len(be)}")

fuga = sum(float(t['ctrader_real_pnl']) for t in be if t.get('ctrader_real_pnl') is not None)
neg = [t for t in be if t.get('ctrader_real_pnl') is not None and float(t['ctrader_real_pnl']) < 0]
pos = [t for t in be if t.get('ctrader_real_pnl') is not None and float(t['ctrader_real_pnl']) > 0]
zero = [t for t in be if t.get('ctrader_real_pnl') == 0]
print(f"Suma real cTrader de los BE: {fuga:+.2f} USD  (negativos {len(neg)}: {sum(float(t['ctrader_real_pnl']) for t in neg):.2f} | positivos {len(pos)}: {sum(float(t['ctrader_real_pnl']) for t in pos):.2f} | 0 exacto: {len(zero)})")

print(f"\n{'fecha':<17}{'ticker':<9}{'dir':<5}{'pnlReal':>9}{'entry':>12}{'slPrice':>12}{'tp1PartPnl':>10}{'tp1Pct':>8}")
for t in sorted(be, key=lambda x: x.get('timestamp') or 0):
    if t.get('ctrader_real_pnl') is None: continue
    d = ts(t.get('timestamp'))
    dstr = d.strftime('%m-%d %H:%M') if d else '?'
    print(f"{dstr:<17}{str(t.get('ticker')):<9}{str(t.get('direction')):<5}{float(t.get('ctrader_real_pnl')):>9.2f}{str(t.get('entryPrice')):>12}{str(t.get('slPrice')):>12}{str(t.get('tp1PartialPnlUsd')):>10}{str(t.get('tp1PartialPct')):>8}")

with_tp1 = [t for t in be if t.get('tp1PartialPnlUsd') is not None]
print(f"\nBE con TP1 parcial cobrado: {len(with_tp1)} / {len(be)}")

print("\nFuga media por activo (negativos):")
c = Counter(); s = Counter()
for t in neg:
    k = str(t.get('ticker')); c[k] += 1; s[k] += float(t['ctrader_real_pnl'])
for k in sorted(c):
    print(f"  {k:<9} {c[k]:>2} trades, suma {s[k]:+.2f} USD, media {s[k]/c[k]:+.3f} USD")

# Todos los negativos: entry vs slPrice
print("\nNegativos en detalle (entry vs slPrice):")
for t in sorted(neg, key=lambda x: x.get('timestamp') or 0):
    d = ts(t.get('timestamp'))
    dstr = d.strftime('%m-%d %H:%M') if d else '?'
    print(f"  {dstr} {t.get('ticker'):<8} {t.get('direction'):<5} pnl={float(t['ctrader_real_pnl']):+.2f} entry={t.get('entryPrice')} slPrice={t.get('slPrice')} lots={t.get('ctraderLots')}")
