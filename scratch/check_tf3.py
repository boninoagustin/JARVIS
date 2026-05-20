import os
import csv
from datetime import datetime

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs"
files = [
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_5d094.csv",
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_69c1b.csv"
]

for filename in files:
    filepath = os.path.join(log_dir, filename)
    if not os.path.exists(filepath):
        continue
    
    min_date = None
    max_date = None
    count = 0
    with open(filepath, 'r', encoding='utf-8') as infile:
        reader = csv.reader(infile)
        next(reader, None)
        for row in reader:
            if not row:
                continue
            count += 1
            date_str = row[0]
            try:
                dt = datetime.fromisoformat(date_str)
                if min_date is None or dt < min_date:
                    min_date = dt
                if max_date is None or dt > max_date:
                    max_date = dt
            except ValueError:
                pass
    print(f"{filename}: {count} rows, {min_date} to {max_date}")
