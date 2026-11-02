/**
 * Arranque del backend. En FastComet (cPanel › Setup Node.js App) este es el "Application startup file".
 * Lee la configuración (variables de entorno o .env), conecta con MySQL, crea las tablas y escucha.
 */
import { leerConfig, comprobarConfig } from './src/config.js';
import { conectar } from './src/db.js';
import { crearGoogle } from './src/google.js';
import { crearAvisos } from './src/avisos.js';
import { crearApp } from './src/aplicacion.js';
import { iniciarCola } from './src/cola.js';
import { iniciarResumenes } from './src/resumen.js';
import { crearTransportistas, iniciarRastreo } from './src/envios.js';
import { crearInstagram } from './src/instagram.js';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch (e) { /* Sin .env: se usan las variables del panel */ }

const config = leerConfig();
const faltan = comprobarConfig(config);
if (faltan.length) {
    console.error(`Falta configurar: ${faltan.join('; ')}. Ver .env.ejemplo.`);
    process.exit(1);
}

const pool = await conectar(config.mysql);
const avisos = crearAvisos(config);
const google = crearGoogle(config);
const transportistas = crearTransportistas(config);
const app = crearApp({ config, pool, google, avisos, transportistas, instagram: crearInstagram(config) });
iniciarCola(pool, avisos); // Envía los avisos pendientes (WhatsApp y push) cada 5 segundos
iniciarResumenes({ pool, config, google, avisos }); // "Borja": el resumen de la mañana de cada persona
iniciarRastreo({ pool, config, avisos, transportistas }); // Guías de DHL y FedEx (si están sus claves)
app.listen(config.puerto, () => console.log(`Backend de Semences escuchando en el puerto ${config.puerto}`));
