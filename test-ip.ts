import fetch from 'node-fetch';

async function test() {
    const url = 'https://149.154.166.110/bot8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk/getMe';
    console.log(`Testing direct IP: ${url}...`);
    try {
        const start = Date.now();
        const res = await fetch(url, { 
            timeout: 10000,
            headers: { 
                'Host': 'api.telegram.org',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        console.log(`Status: ${res.status} (${Date.now() - start}ms)`);
        const text = await res.text();
        console.log(`Response: ${text}`);
    } catch (e: any) {
        console.error(`FAILED: ${e.message}`);
    }
}

test();
