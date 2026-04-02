import { Bot } from 'grammy';
import https from 'https';

const ipv4Agent = new https.Agent({ family: 4 });
const bot = new Bot('8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk', {
    client: {
        baseFetchConfig: {
            // @ts-ignore
            agent: ipv4Agent
        }
    }
});

async function run() {
    try {
        const info = await bot.api.getMe();
        console.log('Success:', info);
        process.exit(0);
    } catch (e: any) {
        console.error('Failure:', e.message || e);
        process.exit(1);
    }
}
run();
