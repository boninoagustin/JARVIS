const { updateFundamentals } = require('./build/services/finnhub.js');
console.log("running updateFundamentals...");
updateFundamentals().then(() => console.log("done"));
