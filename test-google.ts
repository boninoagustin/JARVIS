try {
    const res = await fetch('https://google.com');
    console.log('Google status:', res.status);
    process.exit(0);
} catch (err) {
    console.error('Google fetch failed:', err);
    process.exit(1);
}
