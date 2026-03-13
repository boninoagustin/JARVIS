try {
    const res = await fetch('https://api.telegram.org/bot8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk/getMe');
    const data = await res.json();
    console.log('Fetch result:', data);
    process.exit(0);
} catch (err) {
    console.error('Fetch failed:', err);
    process.exit(1);
}
