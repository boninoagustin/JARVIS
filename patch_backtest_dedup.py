import re

with open('jarvis-os/src/services/backtestEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("const seen = new Set<string>();", "const seen = new Set<number>();")

target = """      // Guardamos una subcadena o hash simple en memoria en vez de la línea completa de 300 chars
      // para reducir drásticamente el uso de RAM del Set.
      // Como las duplicaciones suelen ser exactas, un prefijo + TS suele bastar.
      const dedupKey = line.substring(0, 60);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);"""

replacement = """      // Usamos un hash barato para deduplicar sin gastar demasiada memoria
      let h = 5381; 
      for (let i = 0; i < line.length; i++) h = ((h << 5) + h + line.charCodeAt(i)) | 0;
      if (seen.has(h)) continue; 
      seen.add(h);"""

content = content.replace(target, replacement)

with open('jarvis-os/src/services/backtestEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)
