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
import { iniciarWorkspace } from './src/workspace.js';
import { iniciarEventos } from './src/eventos.js';
import { MANEJADORES } from './src/flujos.js';
import { crearTransportistas, iniciarRastreo } from './src/envios.js';
import { crearInstagram } from './src/instagram.js';
import { iniciarRecordatorios } from './src/reportes.js';
import { crearIA } from './src/ia.js';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch (e) { /* Sin .env: se usan las variables del panel */ }

const config = leerConfig();
const { errores, avisos: avisosConfig } = validarEntorno(process.env);
const faltan = [...comprobarConfig(config), ...errores];
if (faltan.length) {
    console.error(`Falta configurar o está mal: ${faltan.join('; ')}. Ver .env.example.`);
    process.exit(1);
}
for (const aviso of avisosConfig) console.warn(`Configuración: ${aviso}`);

// Red de seguridad: una promesa rechazada que nadie atiende (un fallo en un aviso, un evento de Google) queda en
// stderr.log en vez de detener el servidor; Node la convertiría en un cierre del proceso entero
process.on('unhandledRejection', (motivo) => {
    console.error('Error sin atender (el servidor sigue en marcha):', motivo instanceof Error ? motivo.stack : motivo);
});

const pool = await conectar(config.mysql);
const avisos = crearAvisos(config);
const google = crearGoogle(config);
const transportistas = crearTransportistas(config);
const ia = crearIA(config); // Revisión de los reportes semanales con Claude (solo con ANTHROPIC_API_KEY)
const app = crearApp({ config, pool, google, avisos, transportistas, instagram: crearInstagram(config), ia });
iniciarCola(pool, avisos); // Envía los avisos pendientes (WhatsApp y push) cada 5 segundos
iniciarResumenes({ pool, config, google, avisos }); // "Borja": el resumen de la mañana de cada persona
iniciarWorkspace({ pool, config, google, avisos }); // Respaldo diario en Drive y agenda del CRM en Google Calendar
iniciarEventos({ pool, config, google, avisos }, MANEJADORES); // Flujos automáticos (p. ej. cliente en Reunión), cada 3 s
iniciarRastreo({ pool, config, avisos, transportistas }); // Guías de DHL y FedEx (si están sus claves)
iniciarRecordatorios({ pool, config, avisos, ia }); // Reporte semanal: recordatorio del viernes; con IA, revisiones y resumen del lunes
app.listen(config.puerto, () => console.log(`Backend de Semences escuchando en el puerto ${config.puerto}`));
