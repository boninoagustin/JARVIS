import { uploadToDrive } from '../src/google/drive.js';

async function test() {
    console.log("Creando prueba de archivo en Google Drive...");
    try {
        const url = await uploadToDrive("Test_JARVIS.md", "# ¡Hola desde JARVIS!\nEste es un archivo de prueba.");
        console.log("ÉXITO! Enlace:", url);
    } catch (err: any) {
        console.error("Falló la prueba:", err.message);
    }
}
test();
