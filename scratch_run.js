const { execSync } = require('child_process');
const fs = require('fs');

try {
    const stdout = execSync('npx tsx optimize.ts', { cwd: '/home/bon/Descargas/JARVIS', encoding: 'utf8' });
    fs.writeFileSync('/home/bon/Descargas/JARVIS/out.txt', "STDOUT:\n" + stdout);
} catch (err) {
    fs.writeFileSync('/home/bon/Descargas/JARVIS/out.txt', "ERROR:\n" + err.message + "\nSTDERR:\n" + err.stderr + "\nSTDOUT:\n" + err.stdout);
}
