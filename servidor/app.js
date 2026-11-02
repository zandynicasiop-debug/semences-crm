/**
 * Arranque del backend. En FastComet (cPanel › Setup Node.js App) este es el "Application startup file".
 * Lee la configuración (variables de entorno o .env), conecta con MySQL, crea las tablas y escucha.
 */
import { leerConfig, comprobarConfig, validarEntorno } from './src/config.js';
import { conectar } from './src/db.js';
import { crearGoogle } from './src/google.js';
import { crearAvisos } from './src/avisos.js';
import { crearApp } from './src/aplicacion.js';
import { iniciarCola } from './src/cola.js';
import { iniciarResumenes } from './src/resumen.js';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch (e) { /* Sin .env: se usan las variables del panel */ }

const config = leerConfig();
const { errores, avisos: avisosConfig } = validarEntorno(process.env);
const faltan = [...comprobarConfig(config), ...errores];
if (faltan.length) {
    console.error(`Falta configurar o está mal: ${faltan.join('; ')}. Ver .env.example.`);
    process.exit(1);
}
for (const aviso of avisosConfig) console.warn(`Configuración: ${aviso}`);

const pool = await conectar(config.mysql);
const avisos = crearAvisos(config);
const google = crearGoogle(config);
const app = crearApp({ config, pool, google, avisos });
iniciarCola(pool, avisos); // Envía los avisos pendientes (WhatsApp y push) cada 5 segundos
iniciarResumenes({ pool, config, google, avisos }); // "Borja": el resumen de la mañana de cada persona
app.listen(config.puerto, () => console.log(`Backend de Semences escuchando en el puerto ${config.puerto}`));
