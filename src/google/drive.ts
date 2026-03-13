import { google } from 'googleapis';
import { config } from '../config.js';

import fs from 'fs';

let authClient: any = null;

function getAuthClient() {
    if (authClient) return authClient;

    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not defined');
    }

    try {
        let credentials;
        if (credPath.startsWith('{')) {
            credentials = JSON.parse(credPath);
        } else if (fs.existsSync(credPath)) {
            credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        }

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        authClient = auth;
        return authClient;
    } catch (err: any) {
        throw new Error('Error parseando credenciales para Google Drive: ' + err.message);
    }
}

/**
 * Sube un archivo de texto/markdown a Google Drive.
 * @param filename El nombre del archivo (ej: 'Idea_Trading.md')
 * @param content El contenido de texto del archivo.
 * @param folderId (Opcional) El ID de la carpeta donde se guardará.
 * @returns La URL webView del archivo creado.
 */
export async function uploadToDrive(filename: string, content: string): Promise<string> {
    const auth = getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const folderId = config.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
        throw new Error('GOOGLE_DRIVE_FOLDER_ID is not defined in config.');
    }

    const fileMetadata: any = {
        name: filename,
        mimeType: 'text/markdown',
        parents: [folderId]
    };

    const media = {
        mimeType: 'text/markdown',
        body: content,
    };

    try {
        const file = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
        });

        console.log(`[DRIVE] Archivo subido exitosamente: ${file.data.webViewLink}`);
        return file.data.webViewLink || '';
    } catch (err: any) {
        console.error('[DRIVE] Error subiendo archivo a Drive:', err);
        throw err;
    }
}
