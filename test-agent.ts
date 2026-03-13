import fetch from 'node-fetch';
import https from 'https';

const agent = new https.Agent({ keepAlive: false });

try {
    const res = await fetch('https://api.telegram.org/bot8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk/getMe', { agent });
    const data = await res.json();
    console.log('Success with agent:', data);
    process.exit(0);
} catch (err) {
    console.error('Failed with agent:', err);
    process.exit(1);
}
