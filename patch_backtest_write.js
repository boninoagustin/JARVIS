const fs = require('fs');
let content = fs.readFileSync('src/db/trading.ts', 'utf8');

// Add safeSet helper
content = content.replace(
    "const docRef = db.collection('radar_states').doc(ticker);",
    "const docRef = db.collection('radar_states').doc(ticker);\n    const safeSet = (data: any, options?: any) => {\n        if (isBacktest) return Promise.resolve();\n        return docRef.set(data, options);\n    };"
);

// Replace docRef.set(state with safeSet(state ONLY INSIDE processAlert (after line 576)
// To be safe, we just replace docRef.set(state with safeSet(state globally in the file since docRef is only used in processAlert for radar_states.
content = content.replace(/docRef\.set\(state/g, "safeSet(state");

fs.writeFileSync('src/db/trading.ts', content, 'utf8');
console.log("Patch applied!");
