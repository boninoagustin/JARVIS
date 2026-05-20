import json
import datetime
import statistics
import itertools

with open('/home/agustinbonino/Descargas/JARVIS/logs/jarvis_bt_EURUSD_1779162156312.json', 'r') as f:
    data = json.load(f)

trades = data.get('trades', [])

# Agrupar trades por día
from collections import defaultdict
days = defaultdict(list)

for t in trades:
    res = t.get('result')
    if res and res != 'TIMEOUT':
        ts = t.get('closeTimestamp', t.get('timestamp'))
        date_str = datetime.datetime.fromtimestamp(ts/1000).strftime('%Y-%m-%d')
        days[date_str].append(t)

def simular(max_daily_loss, max_cons_loss, max_trades, trail_dd):
    new_pnl = 0
    new_trades = 0
    for d, day_trades in sorted(days.items()):
        day_trades.sort(key=lambda x: x.get('closeTimestamp', x.get('timestamp')))
        current_pnl = 0
        peak_pnl = 0
        cons_losses = 0
        trades_count = 0
        is_killed = False
        
        for t in day_trades:
            if is_killed: continue
                
            trades_count += 1
            new_trades += 1
            r = t.get('rMultiple', 0)
            res = t.get('result')
            current_pnl += r
            new_pnl += r
            
            if res == 'WIN': cons_losses = 0
            elif res == 'LOSS': cons_losses += 1
                
            if current_pnl > peak_pnl:
                peak_pnl = current_pnl
                
            # Check Killswitches
            if max_daily_loss and current_pnl <= -max_daily_loss: is_killed = True
            elif max_cons_loss and cons_losses >= max_cons_loss: is_killed = True
            elif max_trades and trades_count >= max_trades: is_killed = True
            elif trail_dd and (peak_pnl - current_pnl) >= trail_dd: is_killed = True

    return new_pnl, new_trades

# Original
pnl_orig, trades_orig = simular(0, 0, 0, 0)
print(f"ORIGINAL: {trades_orig} trades, PnL = {pnl_orig:.2f}R")

# Probar aislando
print(f"Solo Max Daily Loss 2.0R: PnL = {simular(2.0, 0, 0, 0)[0]:.2f}R ({simular(2.0, 0, 0, 0)[1]} trades)")
print(f"Solo Max Cons Losses 2: PnL = {simular(0, 2, 0, 0)[0]:.2f}R ({simular(0, 2, 0, 0)[1]} trades)")
print(f"Solo Max Trades 4: PnL = {simular(0, 0, 4, 0)[0]:.2f}R ({simular(0, 0, 4, 0)[1]} trades)")
print(f"Solo Max Trades 6: PnL = {simular(0, 0, 6, 0)[0]:.2f}R ({simular(0, 0, 6, 0)[1]} trades)")
print(f"Solo Trailing DD 2.0R: PnL = {simular(0, 0, 0, 2.0)[0]:.2f}R ({simular(0, 0, 0, 2.0)[1]} trades)")
print(f"Solo Trailing DD 3.0R: PnL = {simular(0, 0, 0, 3.0)[0]:.2f}R ({simular(0, 0, 0, 3.0)[1]} trades)")

