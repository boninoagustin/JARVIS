const now = new Date(1718816400000); // just some timestamp
const artTimeString = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false });
console.log("String:", artTimeString);
