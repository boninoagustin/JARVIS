import os
import csv
import glob

log_dir = "/home/agustinbonino/Descargas/JARVIS/logs"

def get_tf_from_message(msg):
    parts = msg.split('|')
    for part in parts:
        if "TF:" in part:
            return part.split(':')[1].strip()
    return None

csv_files = glob.glob(os.path.join(log_dir, '**', '*.csv'), recursive=True)

deleted_files = []
kept_files = []

for filepath in csv_files:
    # Skip the new unified files
    if "pine-logs-TF3-unified.csv" in filepath or "pine-logs-TF15-unified.csv" in filepath:
        continue
    
    file_tfs = set()
    try:
        with open(filepath, 'r', encoding='utf-8') as infile:
            reader = csv.reader(infile)
            next(reader, None) # skip header
            for row in reader:
                if not row or len(row) < 2:
                    continue
                tf = get_tf_from_message(row[1])
                if tf:
                    file_tfs.add(tf)
                
                # if we found a TF, let's just break early assuming 1 file = 1 TF,
                # but to be extremely safe, we can read the whole file or first few rows.
                # Actually, TradingView pine logs for a single export are usually single TF.
                # Let's break after finding the first valid TF to be fast.
                if len(file_tfs) > 0:
                    break
                    
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
        continue

    # If the file contains TF 60 or 240, keep it. 
    # If it contains TF 3 or 15, delete it (since we already merged them).
    # If no TF found, let's keep it to be safe.
    
    if '60' in file_tfs or '240' in file_tfs:
        kept_files.append((filepath, file_tfs))
        print(f"Keeping {os.path.basename(filepath)} (TF: {file_tfs})")
    elif '3' in file_tfs or '15' in file_tfs:
        deleted_files.append((filepath, file_tfs))
        os.remove(filepath)
        print(f"Deleted {os.path.basename(filepath)} (TF: {file_tfs})")
    else:
        # Keep it if we don't know
        kept_files.append((filepath, file_tfs))
        print(f"Keeping {os.path.basename(filepath)} (Unknown or other TF: {file_tfs})")

print(f"\nResumen: Se eliminaron {len(deleted_files)} archivos y se conservaron {len(kept_files)} archivos.")
