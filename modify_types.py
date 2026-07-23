import re

with open('src/engine/Types.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = "    zones: RadarZone[];"
replacement = """    zones: RadarZone[];
    zoneConfluence?: Map<RadarZone, string[]>;"""
content = content.replace(target, replacement)

with open('src/engine/Types.ts', 'w', encoding='utf-8') as f:
    f.write(content)
