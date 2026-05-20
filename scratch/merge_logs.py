import os
import csv
import glob
from datetime import datetime

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs"

def get_tf_from_message(msg):
    parts = msg.split('|')
    for part in parts:
        if "TF:" in part:
            return part.split(':')[1].strip()
    return None

tf_records = {} # tf -> set of tuples
tf_headers = {}

# Recursively find all csv files
csv_files = glob.glob(os.path.join(log_dir, '**', '*.csv'), recursive=True)

for filepath in csv_files:
    if os.path.basename(filepath).startswith("pine-logs-TF"):
        # We might want to include existing unified files (e.g. from BTC Ultra Conservador)
        # But we'll let it process everything safely since we just removed the root unified files.
        pass
    print(f"Reading {filepath}...")
    try:
        with open(filepath, 'r', encoding='utf-8') as infile:
            reader = csv.reader(infile)
            header = next(reader, None)
            for row in reader:
                if not row or len(row) < 2:
                    continue
                date_str = row[0]
                msg = row[1]
                tf = get_tf_from_message(msg)
                if tf in ['3', '15']:
                    if tf not in tf_records:
                        tf_records[tf] = set()
                        tf_headers[tf] = header
                    
                    tf_records[tf].add(tuple(row))
    except Exception as e:
        print(f"Error reading {filepath}: {e}")

for tf, records in tf_records.items():
    output_file = os.path.join(log_dir, f"pine-logs-TF{tf}-unified.csv")
    print(f"Writing {len(records)} unique records for TF {tf} to {output_file}...")
    
    # Sort records by date
    def parse_date(row):
        try:
            return datetime.fromisoformat(row[0].replace('Z', '+00:00'))
        except Exception:
            return datetime.min
    
    sorted_records = sorted(list(records), key=parse_date)
    
    with open(output_file, 'w', encoding='utf-8', newline='') as outfile:
        writer = csv.writer(outfile)
        if tf_headers.get(tf):
            writer.writerow(tf_headers[tf])
        writer.writerows(sorted_records)
        
print("Done.")
