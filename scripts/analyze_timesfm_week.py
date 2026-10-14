import json, datetime
from collections import Counter

def ts(x):
    return datetime.datetime.fromtimestamp(x/1000, tz=datetime.timezone(datetime.timedelta(hours=2)))

entries = [json.loads(l) for l in open('/opt/JARVIS/logs/timesfm_audit.jsonl') if l.strip()]
start = datetime.datetime(2026,8,24,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))
end   = datetime.datetime(2026,8,31,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))
sem = [e for e in entries if start <= ts(e.get('ts')) < end]
print(f"Eventos TimesFM semana 24-30 ago: {len(sem)}\n")

print(f"{'fecha':<17}{'ticker':<9}{'dir':<5}{'action':<9}{'riskMult':>8}{'fDir':<6}{'spreadAtr':>9}  reason")
for e in sem:
    d = ts(e.get('ts'))
    print(f"{d.strftime('%m-%d %H:%M'):<17}{str(e.get('ticker')):<9}{str(e.get('direction')):<5}{str(e.get('action')):<9}{str(e.get('riskMult')):>8}{str(e.get('forecastDir')):<6}{str(round(e.get('spreadAtr') or 0,2)):>9}  {e.get('reason','')[:70]}")

print("\n=== Resumen ===")
c = Counter(str(e.get('action')) for e in sem)
print("Acciones:", dict(c))
red = [e for e in sem if e.get('action') in ('REJECT','REDUCE')]
print(f"Habría filtrado (REJECT+REDUCE): {len(red)} de {len(sem)}")
for e in red:
    print(f"  {ts(e.get('ts')).strftime('%m-%d %H:%M')} {e.get('ticker')} {e.get('direction')} → {e.get('action')} riskMult={e.get('riskMult')}")

# cruce con trades del journal ejecutados (LOSS/WIN/BREAKEVEN)
trades = json.load(open('/opt/JARVIS/logs/trade_journal_export.json'))
print("\n=== CRUCE: trades EJECUTADOS vs decisión TimesFM más cercana (mismo ticker+dir, ±10min) ===")
ejec = []
for t in trades:
    ets = t.get('timestamp')
    if ets is None: continue
    d = ts(ets)
    if start <= d < end and t.get('result') in ('WIN','LOSS','BREAKEVEN','REVERSAL'):
        ejec.append((d, t))
ejec.sort(key=lambda x: x[0])

for d, t in ejec:
    # buscar evento timesfm del mismo ticker/dirección dentro de ±15 min
    best = None
    for e in sem:
        ed = ts(e.get('ts'))
        if e.get('ticker') == t.get('ticker') and e.get('direction') == t.get('direction') and abs((ed-d).total_seconds()) < 900:
            best = (e, abs((ed-d).total_seconds()))
            break
    if best:
        e, diff = best
        print(f"{d.strftime('%m-%d %H:%M')} {str(t.get('ticker')):<8} {str(t.get('direction')):<5} result={str(t.get('result')):<10} TIMESFM={e.get('action'):<8} riskMult={e.get('riskMult')} (Δ{int(diff)}s)")
    else:
        print(f"{d.strftime('%m-%d %H:%M')} {str(t.get('ticker')):<8} {str(t.get('direction')):<5} result={str(t.get('result')):<10} TIMESFM=sin evento auditado")
