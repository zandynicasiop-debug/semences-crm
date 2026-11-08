// @ts-check
/**
 * Verificación del servidor ya publicado (prueba de humo), para después de subirlo a FastComet:
 *
 *   node herramientas/verificar.js https://api.semillasdata.com
 *   npm run verificar -- https://api.semillasdata.com --origen=https://semillasdata.com
 *
 * No entra con ninguna cuenta. Lo único que puede escribir es lo que haría el Cron de cPanel con /api/latido (una vuelta
 * de lo pendiente, idempotente). Comprueba, con las rutas reales del servidor:
 *   1. /api/salud responde, con la base conectada, y en cuánto tiempo (avisa si pasa de 1 s).
 *   2. Los webhooks de Meta (WhatsApp e Instagram) rechazan con 401 lo que llega sin firma.
 *   3. La verificación GET de los webhooks no acepta un token equivocado (403, sin devolver el reto).
 *   4. Sin sesión, la API no da datos (401).
 *   5. La web (semillasdata.com y GitHub Pages) puede llamar a la API (CORS) y un origen ajeno no.
 *   6. Cabeceras de seguridad de helmet, y HTTPS fuera de este equipo.
 *   7. El latido del Cron de cPanel (/api/latido) responde y su vuelta no falla.
 * También enseña qué integraciones están activas y si hay flujos o avisos fallidos. Sale con código 1 si algo falla.
 */
import { pathToFileURL } from 'node:url';

const ORIGENES_WEB = ['https://semillasdata.com', 'https://zandynicasiop-debug.github.io'];
const ORIGEN_AJENO = 'https://ejemplo-ajeno.invalid';
const LENTO_MS = 1000;

/**
 * @typedef {{ nombre: string, ok: boolean, detalle: string, aviso?: boolean }} Resultado
 */

/**
 * @param {string} url
 * @param {RequestInit} [opciones]
 */
async function pedir(url, opciones = {}) {
    const inicio = Date.now();
    const respuesta = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...opciones });
    const texto = await respuesta.text();
    /** @type {any} */
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no era JSON */ }
    return { estado: respuesta.status, cabeceras: respuesta.headers, texto, json, ms: Date.now() - inicio };
}

/**
 * Suma los 'fallido' de un resumen por tipo y estado ({ CLIENTE_EN_REUNION: { hecho: 3, fallido: 1 } }).
 * @param {any} resumen
 */
function fallidos(resumen) {
    if (!resumen || typeof resumen !== 'object') return 0;
    return Object.values(resumen).reduce((total, estados) => total + Number((estados && estados.fallido) || 0), 0);
}

/**
 * Ejecuta todas las comprobaciones contra el servidor publicado.
 * @param {string} urlBase  p. ej. https://api.semillasdata.com
 * @param {{ origenes?: string[], latido?: boolean }} [opciones]  latido: false para no llamar a /api/latido
 * @returns {Promise<{ ok: boolean, resultados: Resultado[], integraciones: Record<string, unknown> | null }>}
 */
export async function verificarServidor(urlBase, { origenes = ORIGENES_WEB, latido = true } = {}) {
    const base = urlBase.replace(/\/+$/, '');
    /** @type {Resultado[]} */
    const resultados = [];
    /** @param {string} nombre @param {boolean} ok @param {string} detalle @param {boolean} [aviso] */
    const anotar = (nombre, ok, detalle, aviso = false) => { resultados.push({ nombre, ok, detalle, aviso }); };
    /** @param {string} nombre @param {() => Promise<void>} prueba */
    const comprobar = async (nombre, prueba) => {
        try { await prueba(); } catch (error) {
            const causa = error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
            anotar(nombre, false, `no responde (${causa})`);
        }
    };

    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);
    anotar('HTTPS', base.startsWith('https://') || local, base.startsWith('https://') ? 'la API va cifrada' : (local ? 'servidor local' : 'la API debe ir por https://'));

    /** @type {Record<string, unknown> | null} */
    let integraciones = null;
    await comprobar('Salud (/api/salud)', async () => {
        const r = await pedir(`${base}/api/salud`, { headers: { Accept: 'application/json' } });
        const bien = r.estado === 200 && r.json && r.json.ok === true && r.json.base === 'ok';
        anotar('Salud (/api/salud)', bien, bien ? `base conectada, ${r.ms} ms` : `HTTP ${r.estado}: ${r.texto.slice(0, 200)}`);
        if (!bien) return;
        integraciones = r.json.integraciones || null;
        anotar('Tiempo de respuesta', r.ms <= LENTO_MS, `${r.ms} ms (máximo ${LENTO_MS} ms)`, true);
        const eventos = fallidos(r.json.eventos);
        anotar('Flujos automáticos', eventos === 0, eventos ? `${eventos} fallido(s): revisar la tabla eventos` : 'ninguno fallido', true);
        const avisos = fallidos(r.json.colaAvisos);
        anotar('Cola de avisos', avisos === 0, avisos ? `${avisos} aviso(s) fallido(s)` : 'ninguno fallido', true);
        const cabeceras = r.cabeceras;
        const helmet = cabeceras.get('x-content-type-options') === 'nosniff' && Boolean(cabeceras.get('content-security-policy'));
        anotar('Cabeceras de seguridad', helmet, helmet ? 'helmet activo' : 'faltan X-Content-Type-Options o Content-Security-Policy');
    });

    for (const [nombre, ruta] of [['WhatsApp', '/api/whatsapp/webhook'], ['Instagram', '/api/instagram/webhook']]) {
        await comprobar(`Webhook de ${nombre} sin firma`, async () => {
            const r = await pedir(`${base}${ruta}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ object: nombre === 'WhatsApp' ? 'whatsapp_business_account' : 'instagram', entry: [] })
            });
            anotar(`Webhook de ${nombre} sin firma`, r.estado === 401, r.estado === 401 ? 'rechazado (401)' : `HTTP ${r.estado}: debería ser 401`);
        });
        await comprobar(`Verificación de ${nombre} con token falso`, async () => {
            const reto = 'reto-de-prueba-123';
            const r = await pedir(`${base}${ruta}?hub.mode=subscribe&hub.verify_token=token-falso-de-prueba&hub.challenge=${reto}`);
            const bien = r.estado === 403 && !r.texto.includes(reto);
            anotar(`Verificación de ${nombre} con token falso`, bien, bien ? 'rechazada (403)' : `HTTP ${r.estado}: debería ser 403`);
        });
    }

    // El despertador del Cron de cPanel (latido.js): responde y su vuelta no falla (frenada si ya se hizo hace poco)
    if (latido) await comprobar('Latido del Cron (/api/latido)', async () => {
        const r = await pedir(`${base}/api/latido`);
        const bien = r.estado === 200 && r.json && r.json.ok === true;
        const detalle = !bien
            ? `HTTP ${r.estado}${r.json && r.json.fallos && r.json.fallos.length ? `; falló: ${r.json.fallos.join(', ')}` : ''}`
            : r.json.vuelta === 'hecha' ? `vuelta hecha${r.json.fallidosAvisados ? `; ${r.json.fallidosAvisados} flujo(s) fallido(s) avisados al Master` : ''}` : 'responde (vuelta reciente)';
        anotar('Latido del Cron (/api/latido)', bien, detalle);
    });

    await comprobar('Datos sin sesión', async () => {
        const r = await pedir(`${base}/api/yo`);
        anotar('Datos sin sesión', r.estado === 401, r.estado === 401 ? 'pide entrar (401)' : `HTTP ${r.estado}: debería ser 401`);
    });

    for (const origen of origenes) {
        await comprobar(`CORS ${origen}`, async () => {
            const r = await pedir(`${base}/api/accion`, {
                method: 'OPTIONS',
                headers: { Origin: origen, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' }
            });
            const bien = r.estado === 204 && r.cabeceras.get('access-control-allow-origin') === origen;
            anotar(`CORS ${origen}`, bien, bien ? 'la web puede llamar a la API' : `HTTP ${r.estado}: falta ${origen} en ORIGENES`);
        });
    }
    await comprobar('CORS de un origen ajeno', async () => {
        const r = await pedir(`${base}/api/accion`, { method: 'OPTIONS', headers: { Origin: ORIGEN_AJENO, 'Access-Control-Request-Method': 'POST' } });
        const bien = r.estado === 403 && !r.cabeceras.get('access-control-allow-origin');
        anotar('CORS de un origen ajeno', bien, bien ? 'rechazado (403)' : `HTTP ${r.estado}: una web ajena podría llamar a la API`);
    });

    return { ok: resultados.every(r => r.ok || r.aviso), resultados, integraciones };
}

async function principal() {
    const argumentos = process.argv.slice(2);
    const url = argumentos.find(a => !a.startsWith('--')) || process.env.SEMENCES_API || 'https://api.semillasdata.com';
    const elegidos = argumentos.filter(a => a.startsWith('--origen=')).map(a => a.slice('--origen='.length));
    console.log(`Verificando ${url} …\n`);
    const { ok, resultados, integraciones } = await verificarServidor(url, elegidos.length ? { origenes: elegidos } : {});
    for (const r of resultados) console.log(`${r.ok ? '✔' : (r.aviso ? '⚠' : '✘')} ${r.nombre}: ${r.detalle}`);
    if (integraciones) {
        const activas = Object.entries(integraciones).map(([nombre, activa]) => `${nombre} ${activa ? 'sí' : 'no'}`).join(' · ');
        console.log(`\nIntegraciones: ${activas}`);
    }
    console.log(ok ? '\nTodo correcto.' : '\nHay comprobaciones que fallan (✘): revisa el detalle de arriba.');
    process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    principal().catch((error) => { console.error(error); process.exitCode = 1; });
}
