import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/index.css'
with open(file_path, 'r') as f:
    text = f.read()

new_css = """
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  background: transparent;
}

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: var(--accent-gold);
  cursor: pointer;
  margin-top: -6px;
}

input[type="range"]::-moz-range-thumb {
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: var(--accent-gold);
  cursor: pointer;
  border: none;
}

input[type="range"]::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

input[type="range"]::-moz-range-track {
  width: 100%;
  height: 4px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}
"""

old_css = """input[type="range"] {
  -webkit-appearance: none;
  width: 100%;
  background: transparent;
}

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: var(--accent-gold);
  cursor: pointer;
  margin-top: -6px;
}

input[type="range"]::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  cursor: pointer;
  background: var(--border-color);
  border-radius: 2px;
}"""

if old_css in text:
    text = text.replace(old_css, new_css.strip())
else:
    print("Old CSS not found perfectly, trying regex")
    text = re.sub(r'input\[type="range"\].*?border-radius: 2px;\n\}', new_css.strip(), text, flags=re.DOTALL)


with open(file_path, 'w') as f:
    f.write(text)
print("done CSS update")
