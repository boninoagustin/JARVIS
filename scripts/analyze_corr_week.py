import json, datetime
from collections import Counter

def ts(x):
    return datetime.datetime.fromtimestamp(x/1000, tz=datetime.timezone(datetime.timedelta(hours=2)))

entries = [json.loads(l) for l in open('/opt/JARVIS/logs/correlation_audit.jsonl') if l.strip()]
print("Total audit entries:", len(entries))
print("Rango:", ts(entries[0].get('ts')), "→", ts(entries[-1].get('ts')))
print()
print("Campos ejemplo:", sorted(entries[0].keys()))
print()

start = datetime.datetime(2026,8,24,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))
end   = datetime.datetime(2026,8,31,0,0, tzinfo=datetime.timezone(datetime.timedelta(hours=2)))

sem = [e for e in entries if start <= ts(e.get('ts')) < end]
print(f"Entradas semana 24-30 ago: {len(sem)}")
print()
print(f"{'fecha':<17}{'ticker':<9}{'dir':<5}{'shadow':<7}{'degraded':<9}{'riskMult':>8}{'wouldBlock':>10}  blockedBy")
for e in sem:
    d = ts(e.get('ts'))
    bb = e.get('blockedBy') or []
    rules = ",".join(f"{b.get('rule')}[{b.get('otherTicker')}]" for b in bb)
    print(f"{d.strftime('%m-%d %H:%M'):<17}{str(e.get('ticker')):<9}{str(e.get('direction')):<5}{str(e.get('shadow')):<7}{str(e.get('degraded')):<9}{str(e.get('riskMult')):>8}{str(e.get('wouldBlock')):>10}  {rules}")

# ¿qué cubre el audit? correlacionar con trades del journal
print("\n=== Resumen semana ===")
print("wouldBlock:", sum(1 for e in sem if e.get('wouldBlock')))
print("riskParity (riskMult<1):", sum(1 for e in sem if (e.get('riskMult') or 1) < 1))
print("degraded:", sum(1 for e in sem if e.get('degraded')))
for e in sem:
    if e.get('wouldBlock'):
        for b in (e.get('blockedBy') or []):
            print(f"  → {e.get('ticker')} {e.get('direction')} bloqueado por {b.get('rule')} vs {b.get('otherTicker')}")
