import os
import csv
import glob
from datetime import datetime

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs/Eurusd balanceado"
output_file = os.path.join("/home/agustinbonino/Descargas/JARVIS/logs", "pine-logs-Eurusd-balanceado-TF3-unified.csv")

csv_files = glob.glob(os.path.join(log_dir, "*.csv"))

header = None
# Usar un set para evitar filas duplicadas (basado en tupla de la fila entera)
unique_rows = set()
rows_data = []

min_date = None
max_date = None

for filepath in csv_files:
    if not os.path.exists(filepath):
        continue
    
    print(f"Leyendo: {filepath}")
    with open(filepath, 'r', encoding='utf-8') as infile:
        reader = csv.reader(infile)
        file_header = next(reader, None)
        if not header and file_header:
            header = file_header
            
        for row in reader:
            if not row:
                continue
            
            row_tuple = tuple(row)
            if row_tuple not in unique_rows:
                unique_rows.add(row_tuple)
                
                date_str = row[0]
                dt = None
                try:
                    dt = datetime.fromisoformat(date_str)
                    if min_date is None or dt < min_date:
                        min_date = dt
                    if max_date is None or dt > max_date:
                        max_date = dt
                except ValueError:
                    pass
                
                rows_data.append((dt, row))

# Ordenar por fecha si existe
def get_sort_key(item):
    dt = item[0]
    # Si no hay fecha válida, se pone al principio o final. Pondremos al principio (min datetime).
    return dt if dt is not None else datetime.min

rows_data.sort(key=get_sort_key)

with open(output_file, 'w', encoding='utf-8', newline='') as outfile:
    writer = csv.writer(outfile)
    if header:
        writer.writerow(header)
    for dt, row in rows_data:
        writer.writerow(row)

print(f"\nArchivos unificados en: {output_file}")
print(f"Total de filas unicas: {len(rows_data)}")
if min_date and max_date:
    print(f"Fecha de inicio: {min_date}")
    print(f"Fecha de fin: {max_date}")

# Eliminar archivos originales
for filepath in csv_files:
    if os.path.exists(filepath):
        os.remove(filepath)
        print(f"Eliminado: {os.path.basename(filepath)}")

# Intentar eliminar la carpeta si quedó vacía
try:
    os.rmdir(log_dir)
    print(f"Carpeta eliminada: {log_dir}")
except OSError:
    print(f"La carpeta no se pudo eliminar (probablemente no esté vacía): {log_dir}")
