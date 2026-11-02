/**
 * Arranque del backend. En FastComet (cPanel › Setup Node.js App) este es el "Application startup file".
 * Lee la configuración (variables de entorno o .env), conecta con MySQL, crea las tablas y escucha.
 */
import { leerConfig, comprobarConfig } from './src/config.js';
import { conectar } from './src/db.js';
import { crearGoogle } from './src/google.js';
import { crearAvisos } from './src/avisos.js';
import { crearApp } from './src/aplicacion.js';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch (e) { /* Sin .env: se usan las variables del panel */ }

const config = leerConfig();
const faltan = comprobarConfig(config);
if (faltan.length) {
    console.error(`Falta configurar: ${faltan.join('; ')}. Ver .env.ejemplo.`);
    process.exit(1);
}

const pool = await conectar(config.mysql);
const app = crearApp({ config, pool, google: crearGoogle(config), avisos: crearAvisos(config) });
app.listen(config.puerto, () => console.log(`Backend de Semences escuchando en el puerto ${config.puerto}`));
