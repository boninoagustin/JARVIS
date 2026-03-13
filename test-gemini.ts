import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

console.log("Testing Gemini connectivity...");
try {
    const result = await genAI.models.generateContent({
        model: "gemini-flash-latest",
        contents: [{ role: "user", parts: [{ text: "Hello, say 'connected' if you can read this." }] }]
    });
    console.log("Gemini Response:", result.text);
    process.exit(0);
} catch (err) {
    console.error("Gemini failed:", err);
    process.exit(1);
}
