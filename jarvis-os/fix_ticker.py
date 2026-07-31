import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    content = f.read()

old_block = """    if (val.includes('BTC')) {
      setSpreadPips(15.0);
      setCommissionPerLot(6.0);
    } else if (val.includes('ETH')) {
      setSpreadPips(1.5);
      setCommissionPerLot(6.0);
    } else if (val.includes('XAU') || val.includes('GOLD')) {
      setSpreadPips(1.5);
      setCommissionPerLot(6.0);
    } else if (val.includes('XAG') || val.includes('SILVER')) {
      setSpreadPips(2.0);
      setCommissionPerLot(6.0);
    } else if (['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI', 'GER', 'UK', 'FRA', 'EU50', 'WS30', 'UT100'].some(i => val.includes(i))) {
      setSpreadPips(1.5);
      setCommissionPerLot(0); // Índices suelen ser commission-free con spread ligeramente más alto en prop firms
    } else if (['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'].includes(val)) {
      setSpreadPips(0.2); // Majors tienen spreads bajísimos en raw accounts (cTrader Funding Pips)
      setCommissionPerLot(6.0); // $3 per side = $6 round turn
    } else if (['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'].some(i => val.includes(i))) {
      setSpreadPips(0.8); // Minors y cruces
      setCommissionPerLot(6.0);
    } else {
      // Default / Desconocido
      setSpreadPips(1.0);
      setCommissionPerLot(6.0);
    }"""

new_block = """    if (val.includes('BTC')) {
      setSpreadPips(15.0);
      setCommissionPerLot(0);
    } else if (val.includes('ETH')) {
      setSpreadPips(1.5);
      setCommissionPerLot(0);
    } else if (val.includes('XAU') || val.includes('GOLD')) {
      setSpreadPips(1.5);
      setCommissionPerLot(6.0);
    } else if (val.includes('XAG') || val.includes('SILVER')) {
      setSpreadPips(2.0);
      setCommissionPerLot(6.0);
    } else if (['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI', 'GER', 'UK', 'FRA', 'EU50', 'WS30', 'UT100'].some(i => val.includes(i))) {
      setSpreadPips(1.5);
      setCommissionPerLot(0);
    } else if (['USOIL', 'WTI', 'UKOIL', 'BRENT', 'NATGAS'].some(i => val.includes(i))) {
      setSpreadPips(2.5);
      setCommissionPerLot(0);
    } else if (['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'].includes(val)) {
      setSpreadPips(0.2);
      setCommissionPerLot(6.0);
    } else if (['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'].some(i => val.includes(i))) {
      setSpreadPips(0.8);
      setCommissionPerLot(6.0);
    } else {
      setSpreadPips(1.0);
      setCommissionPerLot(6.0);
    }"""

content = content.replace(old_block, new_block)

with open(file_path, 'w') as f:
    f.write(content)
