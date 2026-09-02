import subprocess, re

out = subprocess.run(['journalctl', '-u', 'jarvis-tf-ab', '--no-pager'], capture_output=True, text=True).stdout
rows = []
for line in out.splitlines():
    m = re.search(r'(base|solo5m|solo15m)\s+\|\s+(\d+)\s+\|\s+(\d+)\s+\|\s+([-\d.]+)\s+\|\s+([-\d.]+)\s+\|\s+([-\d.]+)\s+\|\s+([\d.]+|∞)\s+\|\s+(\d+)\s+\|\s+(\d+)\s*$', line)
    if m:
        v, n, wr, avg, tot, dd, pf, tp1, big = m.groups()
        rows.append(dict(v=v, n=int(n), wr=int(wr), avg=float(avg), tot=float(tot), dd=float(dd),
                         pf=float(pf) if pf != '∞' else 99.0, tp1=int(tp1), big=int(big)))
print(f"filas: {len(rows)}")
tickers = ['EURUSD','GBPUSD','AUDCAD','US500','XAUUSD','USDJPY','NZDUSD','GBPJPY','AUDJPY','GER40']
variants = ['base','solo5m','solo15m']
assert len(rows) == 30, f"esperaba 30, hay {len(rows)}"

print(f"{'ticker':<9} | {'base R':>7} {'dd':>5} | {'solo5m R':>8} {'dd':>5} | {'solo15m R':>9} {'dd':>5}")
print('-' * 70)
tot = {v: 0.0 for v in variants}
for i, t in enumerate(tickers):
    r = rows[i*3:(i+1)*3]
    line = f"{t:<9} |"
    for j, v in enumerate(variants):
        line += f" {r[j]['tot']:>7.1f}R {r[j]['dd']:>4.1f} |"
        tot[v] += r[j]['tot']
    print(line)
print('-' * 70)
print(f"{'TOTAL':<9} |" + ''.join(f" {tot[v]:>7.1f}R      |" for v in variants))
print()
print("Δ vs base:")
for i, t in enumerate(tickers):
    r = rows[i*3:(i+1)*3]
    print(f"  {t:<9} solo5m:{r[1]['tot']-r[0]['tot']:+.1f}R   solo15m:{r[2]['tot']-r[0]['tot']:+.1f}R")
print(f"  {'TOTAL':<9} solo5m:{tot['solo5m']-tot['base']:+.1f}R   solo15m:{tot['solo15m']-tot['base']:+.1f}R")
print()
print("N trades:")
for i, t in enumerate(tickers):
    r = rows[i*3:(i+1)*3]
    print(f"  {t:<9} base:{r[0]['n']}  solo5m:{r[1]['n']}  solo15m:{r[2]['n']}")
