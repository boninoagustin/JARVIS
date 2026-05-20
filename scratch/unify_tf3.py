import os
import csv

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs/eurusd ultra conservador 03-31 a 04-18"

files_to_unify = [
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_38565.csv",
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_3ad23.csv",
    "pine-logs-SMC Master 5.1 [JARVIS v5.4]_480b3.csv"
]

output_file = os.path.join(log_dir, "pine-logs-TF3-unified.csv")

unique_rows = {}
header = None

for filename in files_to_unify:
    filepath = os.path.join(log_dir, filename)
    if not os.path.exists(filepath):
        print(f"File {filepath} not found.")
        continue
        
    with open(filepath, 'r', encoding='utf-8') as infile:
        reader = csv.reader(infile)
        current_header = next(reader, None)
        if not header and current_header:
            header = current_header
            
        for row in reader:
            if not row:
                continue
            
            date_str = row[0]
            msg = row[1]
            if "TF: 3" in msg:
                unique_rows[(date_str, msg)] = row

# Sort rows by date string
sorted_rows = sorted(unique_rows.values(), key=lambda x: x[0])

min_date = sorted_rows[0][0] if sorted_rows else None
max_date = sorted_rows[-1][0] if sorted_rows else None

with open(output_file, 'w', encoding='utf-8', newline='') as outfile:
    writer = csv.writer(outfile)
    if header:
        writer.writerow(header)
    for row in sorted_rows:
        writer.writerow(row)

print(f"Archivos unificados en: {output_file}")
print(f"Total de filas: {len(sorted_rows)}")
print(f"Fecha de inicio: {min_date}")
print(f"Fecha de fin: {max_date}")

# Eliminar archivos originales
for filename in files_to_unify:
    filepath = os.path.join(log_dir, filename)
    if os.path.exists(filepath):
        os.remove(filepath)
        print(f"Eliminado: {filename}")
