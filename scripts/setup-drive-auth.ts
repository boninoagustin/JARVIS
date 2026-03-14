import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import readline from 'readline';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const CREDENTIALS_PATH = './client_secret.json';

async function authorize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error("No se encontró client_secret.json en la carpeta principal.");
        return;
    }

    const { client_secret, client_id, redirect_uris } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')).installed || JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')).web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob');

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });

    console.log('Autoriza esta app visitando esta URL:', authUrl);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question('Pega el código que te da esa página aquí: ', async (code) => {
        rl.close();
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            console.log("\n--- COPIA Y PEGA ESTO EN TU ARCHIVO .env ---");
            console.log(`GOOGLE_DRIVE_REFRESH_TOKEN="${tokens.refresh_token}"`);
            console.log(`GOOGLE_OAUTH_CLIENT_ID="${client_id}"`);
            console.log(`GOOGLE_OAUTH_CLIENT_SECRET="${client_secret}"`);
            console.log("--------------------------------------------\n");
            console.log("Asegúrate de poner esas tres variables en tu Vercel también.");
        } catch (err) {
            console.error('Error al recuperar token:', err);
        }
    });
}

authorize();
