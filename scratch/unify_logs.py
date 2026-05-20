import os
import csv
from datetime import datetime

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs"
files = [
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_67b34.csv",
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_bf693.csv",
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_0bbf7.csv"
]

output_file = os.path.join(log_dir, "pine-logs-TF15-unified.csv")

first_file = True
min_date = None
max_date = None

with open(output_file, 'w', encoding='utf-8', newline='') as outfile:
    for filename in files:
        filepath = os.path.join(log_dir, filename)
        if not os.path.exists(filepath):
            continue
            
        with open(filepath, 'r', encoding='utf-8') as infile:
            reader = csv.reader(infile)
            header = next(reader, None)
            
            if first_file and header:
                writer = csv.writer(outfile)
                writer.writerow(header)
                first_file = False
                
            for row in reader:
                if not row:
                    continue
                
                date_str = row[0]
                try:
                    # ISO 8601 parsing, handle 'Z' or timezone offset
                    dt = datetime.fromisoformat(date_str)
                    if min_date is None or dt < min_date:
                        min_date = dt
                    if max_date is None or dt > max_date:
                        max_date = dt
                except ValueError:
                    pass
                
                writer.writerow(row)

print(f"Archivos unificados en: {output_file}")
print(f"Fecha de inicio: {min_date}")
print(f"Fecha de fin: {max_date}")

# Eliminar archivos originales
for filename in files:
    filepath = os.path.join(log_dir, filename)
    if os.path.exists(filepath):
        os.remove(filepath)
        print(f"Eliminado: {filename}")
