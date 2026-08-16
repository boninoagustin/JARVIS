import re, json
from datetime import datetime, timezone

def load(ticker, t0, t1):
    p = []
    with open(f'/opt/JARVIS/logs/{ticker.lower()}/history_exported/pine-logs-SMC Master_M15.csv') as f:
        for line in f:
            if 'PING_PRICE' not in line:
                continue
            m = re.search(r'TS: (\d+)', line)
            if not m:
                continue
            ts = int(m.group(1))
            if t0 <= ts <= t1:
                pm = re.search(r'Precio: ([\d.]+)', line)
                if pm:
                    p.append((ts, float(pm.group(1))))
    return p

# ventana del DD de EURUSD: 2026-06-18 → 2026-08-03 (ART = UTC-3)
def ts(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)

t0 = ts(2026, 6, 18)   # pico
t1 = ts(2026, 8, 3, 4, 45)  # valle

for tk in ['EURUSD', 'GBPUSD']:
    p = load(tk, t0, t1)
    if not p:
        print(f'{tk}: sin datos')
        continue
    first = p[0][1]; last = p[-1][1]
    lo = min(x[1] for x in p); hi = max(x[1] for x in p)
    net = (last - first) / first * 100
    rng = (hi - lo) / first * 100
    print(f'{tk}: 18-jun={first:.5f} → 03-ago={last:.5f}  net={net:+.2f}%  rango={rng:.2f}%  (min={lo:.5f} max={hi:.5f})')
    # dirección dominante: muestrear cada 1 día
    samples = {}
    for ts_, pr in p:
        d = datetime.fromtimestamp(ts_/1000, tz=timezone.utc).date()
        samples.setdefault(d, []).append(pr)
    days = sorted(samples)
    up = down = 0
    prev = None
    for d in days:
        close = samples[d][-1]
        if prev is not None:
            if close > prev: up += 1
            elif close < prev: down += 1
        prev = close
    print(f'   días al alza={up} días a la baja={down} (de {len(days)} días con datos)')
