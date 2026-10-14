import json, datetime
from collections import Counter

trades = json.load(open('/opt/JARVIS/logs/trade_journal_export.json'))
print("Total:", len(trades))
print("Campos ejemplo:", sorted(trades[0].keys()))
print()

def ts(x):
    if x is None: return None
    return datetime.datetime.fromtimestamp(x/1000, tz=datetime.timezone(datetime.timedelta(hours=2)))

start = datetime.datetime(2026,8,24,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))
end   = datetime.datetime(2026,8,31,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))

semana = []
for t in trades:
    ets = t.get('entryTs') or t.get('timestamp') or t.get('createdAt')
    if ets is None: continue
    d = ts(ets)
    if d and start <= d < end:
        semana.append((d, t))

semana.sort(key=lambda x: x[0])
print(f"Trades semana 24-30 ago: {len(semana)}")
print()
print(f"{'fecha':<17}{'ticker':<9}{'dir':<5}{'result':<8}{'rMult':>7}{'pnlR':>8}{'trigger':<24}{'riskMult':>8}")
for d, t in semana:
    trig = t.get('triggerKey') or t.get('trigger') or ''
    res = t.get('result') or 'ABIERTO'
    rm = t.get('rMultiple')
    pnl = t.get('pnlR') if t.get('pnlR') is not None else t.get('pnl')
    print(f"{d.strftime('%m-%d %H:%M'):<17}{str(t.get('ticker')):<9}{str(t.get('direction')):<5}{str(res):<8}{str(rm):>7}{str(pnl):>8}{str(trig)[:24]:<24}{str(t.get('riskMult')):>8}")

wins = [t for _,t in semana if t.get('result')=='WIN']
losses = [t for _,t in semana if t.get('result')=='LOSS']
open_ = [t for _,t in semana if t.get('result') not in ('WIN','LOSS')]
print()
print(f"WIN: {len(wins)}, LOSS: {len(losses)}, sin cerrar: {len(open_)}")
if wins or losses:
    total_r = sum((t.get('pnlR') or t.get('pnl') or 0) for t in wins+losses)
    print(f"PnL total cerradas: {total_r:+.2f}R")
    c = Counter(str(t.get('ticker')) for t in wins+losses)
    for k,v in sorted(c.items()):
        kt = [t for t in wins+losses if str(t.get('ticker'))==k]
        r = sum((t.get('pnlR') or t.get('pnl') or 0) for t in kt)
        w = sum(1 for t in kt if t.get('result')=='WIN')
        print(f"  {k:<9} {v:>2} trades, {w}W/{v-w}L, PnL {r:+.2f}R")

# los sin cerrar
if open_:
    print("\nSin cerrar aún:")
    for d,t in semana:
        if t in open_:
            print(f"  {d.strftime('%m-%d %H:%M')} {t.get('ticker')} {t.get('direction')} result={t.get('result')} reopened={t.get('reopened')}")
