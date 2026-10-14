import json, glob

# Snapshot pre-tune (21 ago) vs dump actual (31 ago)
snap_path = sorted(glob.glob('/opt/JARVIS/backups/firestore_snapshot_*.json'))[-1]
snap = json.load(open(snap_path))
# estructura del snapshot: ver claves
print("Snapshot keys:", list(snap.keys())[:20])
# puede ser {coleccion: {docid: {...}}} o {docid: {...}}
if 'asset_configs' in snap:
    old = snap['asset_configs']
else:
    old = snap
new = json.load(open('/opt/JARVIS/logs/asset_configs_dump.json'))

print(f"Comparando {snap_path.split('/')[-1]} vs hoy")
print()

def min_scores(doc):
    out = {}
    sessions = doc.get('sessions') or {}
    for sess, trigs in sessions.items():
        if isinstance(trigs, dict):
            for trig, v in trigs.items():
                if isinstance(v, dict) and v.get('enabled') is True:
                    out[(sess, trig)] = v.get('minScore')
    return out

for ticker in ['GBPJPY','USDJPY','EURUSD','USDCAD','USOIL','AUDJPY','GBPUSD','AUDCAD']:
    o = min_scores(old.get(ticker) or {})
    n = min_scores(new.get(ticker) or {})
    if not o and not n: continue
    print(f"=== {ticker} ===  (gatillos enabled: {len(o)} → {len(n)})")
    allk = sorted(set(o) | set(n))
    for k in allk:
        ov, nv = o.get(k), n.get(k)
        mark = '' if ov == nv else ('  ← CAMBIO' if ov is not None else '  ← NUEVO')
        print(f"  {k[0]:<8}{k[1]:<14} {str(ov):>5} → {str(nv):>5}{mark}")
    print()
