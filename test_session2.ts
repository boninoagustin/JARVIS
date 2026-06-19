const now = new Date(1718816400000); 
const arStr = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', minute: 'numeric', hour12: false });
console.log("String:", arStr);
