const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Mock environment variables to match what JARVIS would have
require('dotenv').config();

const { updateFundamentals } = require('./build/services/finnhub.js'); // Assuming it's compiled, but maybe it's in ts?

