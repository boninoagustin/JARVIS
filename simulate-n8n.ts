import { processUserMessage } from './src/agent/loop.js';
import * as dotenv from 'dotenv';
dotenv.config();

const testUser = 1348898450;
const prompt = "Jarvis, ahora sí, tienes permiso. Usa tus herramientas de N8N para borrar los workflows 'Balance del día' y 'Trading_Bot_EURUSD' por favor.";

console.log(`--- SIMULANDO MENSAJE EN TELEGRAM ---`);
console.log(`Usuario: ${prompt}\n`);

try {
    const response = await processUserMessage(testUser, prompt);
    console.log(`\nJARVIS responde:\n${response}`);
    process.exit(0);
} catch (err) {
    console.error("Error en la simulación:", err);
    process.exit(1);
}
