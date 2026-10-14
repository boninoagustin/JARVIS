import json, datetime
from collections import Counter

trades = json.load(open('/opt/JARVIS/logs/trade_journal_export.json'))

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

# PnL real de cTrader
print("=== PnL REAL cTrader (ctrader_real_pnl) por trade ===")
total = 0.0
for d, t in semana:
    p = t.get('ctrader_real_pnl')
    if p is not None:
        total += float(p)
    r = t.get('result') or '-'
    print(f"{d.strftime('%m-%d %H:%M')} {str(t.get('ticker')):<8} {str(t.get('direction')):<5} {r:<10} rMult={t.get('rMultiple')} ctraderPnL={p}")
print(f"\nTOTAL cTrader PnL semana: {total:+.2f}")

# ¿cuáles son las SKIP? ¿qué campos?
print("\n=== Detalle SKIP/REVERSAL ===")
for d, t in semana:
    if t.get('result') in ('SKIP','REVERSAL'):
        print(f"{d.strftime('%m-%d %H:%M')} {t.get('ticker')} {t.get('direction')} result={t.get('result')} ctraderStatus={t.get('ctraderStatus')} kronos={t.get('kronosVerdict')} grade={t.get('grade')}")

# campos timesfm / correlación en journal?
print("\n=== ¿Hay campos de filtros en el journal? ===")
allkeys = set()
for d,t in semana:
    allkeys.update(t.keys())
print(sorted(allkeys))
for d,t in semana:
    if any('timesfm' in k.lower() or 'corr' in k.lower() for k in t.keys()):
        print({k:v for k,v in t.items() if 'timesfm' in k.lower() or 'corr' in k.lower()})

# sessions
print("\n=== Por sesión ===")
c = Counter(str(t.get('session')) for _,t in semana)
print(dict(c))

# mixtureConsensus / macroContext (filtros LLM?)
print("\n=== mixtureConsensus ===")
c2 = Counter(str(t.get('mixtureConsensus')) for _,t in semana)
print(dict(c2))
