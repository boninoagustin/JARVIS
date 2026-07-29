import fs from 'fs';
import path from 'path';

const presetPath = path.resolve(process.cwd(), 'optimized_preset_EURUSD.json');
if (fs.existsSync(presetPath)) {
    const data = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    console.log(data);
}
