import { google } from 'googleapis';
import { config } from '../config.js';

import fs from 'fs';

let authClient: any = null;

function getAuthClient() {
    if (authClient) return authClient;

    const credentialsPath = config.GOOGLE_APPLICATION_CREDENTIALS;

    if (!credentialsPath || !fs.existsSync(credentialsPath)) {
        throw new Error('No se encontró el archivo de credenciales de Google (service-account.json). Asegúrate de que GOOGLE_APPLICATION_CREDENTIALS esté bien configurado.');
    }

    try {
        console.log('[DRIVE] Inicializando cliente con Cuenta de Servicio...');
        const auth = new google.auth.GoogleAuth({
            keyFile: credentialsPath,
            scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
        });

        authClient = auth;
        return authClient;
    } catch (err: any) {
        throw new Error('Error inicializando Google Auth client: ' + err.message);
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
            fields: 'id, webViewLink',
            supportsAllDrives: true,
        });

        console.log(`[DRIVE] Archivo subido exitosamente: ${file.data.webViewLink}`);
        return file.data.webViewLink || '';
    } catch (err: any) {
        console.error('[DRIVE] Error subiendo archivo a Drive:', err);
        throw err;
    }
}
