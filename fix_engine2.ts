import * as fs from 'fs';

let content = fs.readFileSync('src/engine/smc/SMCEngine.ts', 'utf8');

content = content.replace(
`        // Generate Structural OBs on BOS or CHoCH
        for (const ev of structEvents) {
            if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                const newOBs = this.orderBlocks.createStructuralOB(ev, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }`,
`        // Generate Structural OBs on BOS or CHoCH
        for (const ev of structEvents) {
            if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                const newOBs = this.orderBlocks.createStructuralOB(ev, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }

        // Generate Legacy OBs for new FVGs
        for (const ev of fvgEvents) {
            if (ev.type === 'EVENT_FVG_CREATED') {
                const newOBs = this.orderBlocks.createLegacyOB(ev.fvg, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }`
);

fs.writeFileSync('src/engine/smc/SMCEngine.ts', content);
