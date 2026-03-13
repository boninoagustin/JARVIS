import fetch from 'node-fetch';

async function test() {
    const urls = [
        'https://google.com',
        'https://api.telegram.org/bot8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk/getMe'
    ];

    for (const url of urls) {
        console.log(`\nTesting ${url}...`);
        try {
            const start = Date.now();
            const res = await fetch(url, { 
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            console.log(`Status: ${res.status} (${Date.now() - start}ms)`);
            const text = await res.text();
            console.log(`Response length: ${text.length}`);
        } catch (e: any) {
            console.error(`FAILED: [${e.code}] ${e.message}`);
            if (e.cause) console.error(`Cause: ${e.cause.message}`);
        }
    }
}

test();
