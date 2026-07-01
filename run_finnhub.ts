import * as dotenv from 'dotenv';
dotenv.config();
import { updateFundamentals } from './src/services/finnhub.js';
console.log("Running finnhub...");
updateFundamentals().then(() => console.log("Done"));
