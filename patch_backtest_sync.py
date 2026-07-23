import re

with open('jarvis-os/src/services/backtestEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    if (alertText.includes('Payload:')) {
      const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }"""

replacement = """    if (alertText.includes('Payload:')) {
      const afterPayload = alertText.substring(alertText.indexOf('Payload:') + 8);
      const payloadStr = afterPayload.split(/\\s*\\|\\s*TS:/)[0].trim().replace(/""/g, '"');
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }"""

content = content.replace(target, replacement)

with open('jarvis-os/src/services/backtestEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)
