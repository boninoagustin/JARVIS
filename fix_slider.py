import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/index.css'
with open(file_path, 'r') as f:
    text = f.read()

# Replace the input range css block
old_css = r'''input\[type="range"\] \{.*?\}'''
new_css = '''input[type="range"] {
  -webkit-appearance: none !important;
  appearance: none !important;
  width: 100% !important;
  background: transparent !important;
  height: 24px !important;
  margin: 0 !important;
}

input[type="range"]:focus {
  outline: none;
}'''

text = re.sub(old_css, new_css, text, flags=re.DOTALL)

with open(file_path, 'w') as f:
    f.write(text)
