import json

cfg = json.load(open('/opt/JARVIS/logs/asset_configs_dump.json'))
print("Docs:", sorted(cfg.keys()))
print()

def g(t, *path):
    d = cfg.get(t, {})
    for p in path:
        if not isinstance(d, dict): return None
        d = d.get(p)
    return d

print(f"{'ticker':<9}{'enabled':<8}{'timesfm.en':<10}{'timesfm.dry':<11}{'corr?':<8}{'sesiones'}")
for t in sorted(cfg):
    enabled = g(t, 'enabled')
    tf_en = g(t, 'timesfm', 'enabled')
    tf_dry = g(t, 'timesfm', 'dryRun')
    corr = g(t, 'correlation') or g(t, 'corrEnabled')
    sessions = g(t, 'sessions')
    nsess = len(sessions) if isinstance(sessions, dict) else '?'
    print(f"{t:<9}{str(enabled):<8}{str(tf_en):<10}{str(tf_dry):<11}{str(corr):<8}{str(nsess)}")

# detalle de gatillos enabled por sesión (conteo)
print("\n=== Gatillos enabled:true por activo (total y por sesión) ===")
for t in sorted(cfg):
    sessions = g(t, 'sessions') or {}
    if not isinstance(sessions, dict): continue
    total_on = 0
    per_sess = {}
    for sess, trigs in sessions.items():
        if isinstance(trigs, dict):
            on = [k for k,v in trigs.items() if isinstance(v,dict) and v.get('enabled') is True]
            per_sess[sess] = len(on)
            total_on += len(on)
    if total_on:
        print(f"  {t:<9} {per_sess}  total={total_on}")

# minScore ejemplo por gatillo (EURUSD, GBPJPY, USDJPY)
print("\n=== minScore por gatillo (sesión LONDON) ===")
for t in ['EURUSD','GBPUSD','USDJPY','GBPJPY','AUDJPY','GER40','AUDCAD','XAUUSD','US500','NZDUSD']:
    sessions = g(t, 'sessions') or {}
    lon = sessions.get('LONDON') or {}
    row = []
    for trig, v in sorted(lon.items()):
        if isinstance(v, dict):
            row.append(f"{trig}:{v.get('minScore')}")
    print(f"  {t:<9} {' '.join(row[:8])}")

# killswitch maestro + campos clave
print("\n=== enabled por activo (maestro) ===")
for t in sorted(cfg):
    print(f"  {t:<9} enabled={g(t,'enabled')} autoTrading={g(t,'autoTrading')}")
