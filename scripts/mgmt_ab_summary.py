import subprocess, re, json

out = subprocess.run(['journalctl', '-u', 'jarvis-mgmt-ab', '--no-pager'], capture_output=True, text=True).stdout
rows = []
for line in out.splitlines():
    m = re.search(r'(base|A|B|C|D)\s+\|\s+(\d+)\s+\|\s+(\d+)\s+\|\s+([-\d.]+)\s+\|\s+([-\d.]+)\s+\|\s+([-\d.]+)\s+\|\s+([\d.]+|∞)\s+\|\s+(\d+)\s+\|\s+(\d+)\s+\|\s+(\d+)\s*$', line)
    if m:
        v, n, wr, avg, tot, dd, pf, tp1, be, big = m.groups()
        rows.append(dict(v=v, n=int(n), wr=int(wr), avg=float(avg), tot=float(tot), dd=float(dd),
                         pf=float(pf) if pf != '∞' else 99.0, tp1=int(tp1), big=int(big)))
print(f"filas parseadas: {len(rows)}")
assert len(rows) == 50, "esperaba 50 (10 tickers × 5 variantes)"

tickers = ['EURUSD','GBPUSD','AUDCAD','US500','XAUUSD','USDJPY','NZDUSD','GBPJPY','AUDJPY','GER40']
variants = ['base','A','B','C','D']

print(f"{'ticker':<9} | {'base totR':>9} {'dd':>5} | {'A totR':>7} {'dd':>5} | {'B totR':>7} {'dd':>5} | {'C totR':>7} {'dd':>5} | {'D totR':>7} {'dd':>5}")
print('-' * 110)
tot = {v: 0.0 for v in variants}
for i, t in enumerate(tickers):
    r = rows[i*5:(i+1)*5]
    line = f"{t:<9} |"
    for j, v in enumerate(variants):
        line += f" {r[j]['tot']:>7.1f}R {r[j]['dd']:>4.1f} |"
        tot[v] += r[j]['tot']
    print(line)
print('-' * 110)
print(f"{'TOTAL':<9} |" + ''.join(f" {tot[v]:>7.1f}R     |" for v in variants))
print()
print("Δ totalR vs base por variante (por ticker):")
for i, t in enumerate(tickers):
    r = rows[i*5:(i+1)*5]
    deltas = ' '.join(f"{v}:{r[j]['tot']-r[0]['tot']:+.1f}R" for j, v in enumerate(variants[1:], start=1))
    print(f"  {t:<9} {deltas}")
print(f"  {'TOTAL':<9} " + ' '.join(f"{v}:{tot[v]-tot['base']:+.1f}R" for v in variants[1:]))
