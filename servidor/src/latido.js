// @ts-check
/**
 * Despertador del servidor para el Cron de cPanel, y alerta al Master de los flujos que fallaron.
 *
 * En FastComet (Passenger) el proceso de Node se duerme cuando nadie lo usa un rato, y con él se paran los
 * temporizadores del propio proceso (eventos, cola de avisos, Borja, clientes dormidos). El Cron de cPanel llama
 * cada 5 minutos a GET /api/latido:
 *
 *   - la llamada despierta el proceso (si dormía, Passenger lo arranca y vuelven todos los temporizadores);
 *   - y además hace AHÍ MISMO una vuelta de todo lo pendiente, por si el proceso se vuelve a dormir enseguida:
 *     flujos (eventos), avisos encolados (WhatsApp y push), el resumen de Borja, los clientes dormidos y el
 *     recordatorio del viernes. Todo es idempotente: repetirlo no duplica nada.
 *   - Si un flujo quedó 'fallido' (definitivo: ya no se reintenta), avisa a cada Master en su campana y por correo,
 *     una sola vez por evento (columna eventos.avisado).
 *
 * Es pública (el Cron no tiene sesión) pero ligera y sin datos: como mucho una vuelta por minuto y proceso; lo demás
 * responde al momento. No hace falta ninguna clave.
 */
import { procesarEventos } from './eventos.js';
import { repasar } from './cola.js';
import { enviarResumenes } from './resumen.js';
import { revisarDormidos } from './campo.js';
import { recordarReportes } from './reportes.js';
import { registrarAviso } from './campana.js';
import { avisarPorCorreo, enSegundoPlano } from './workspace.js';

export const LATIDO_MINIMO_S = 60;      // Una vuelta completa como mucho cada minuto por proceso
export const LOTES_POR_LATIDO = 4;       // Hasta 4 lotes de 5 eventos por llamada (el resto, en la siguiente o en el temporizador)
const MAX_FALLIDOS_POR_AVISO = 20;

/**
 * Los Master: los de ADMINS y quien tenga el cargo master aprobado.
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool @param {any} config
 * @returns {Promise<{ id: number, email: string }[]>}
 */
export async function mastersDe(pool, config) {
    const [filas] = await pool.query(
        "SELECT id, email FROM usuarios WHERE email IN (?) OR (estado = 'aprobado' AND cargo = 'master') ORDER BY id",
        [config.google.admins.length ? config.google.admins : ['']]);
    return filas.map((/** @type {any} */ f) => ({ id: Number(f.id), email: String(f.email) }));
}

/**
 * Avisa a los Master de los eventos 'fallido' que aún no se avisaron: un aviso en la campana de cada uno y un correo
 * (desde la cuenta del sistema, si está). Cada evento se marca antes de avisar (UPDATE atómico con una marca), así que
 * dos procesos a la vez no avisan dos veces. Devuelve cuántos eventos se avisaron.
 * @param {{ pool: any, config: any, google?: any }} contexto
 * @param {{ registrar?: Pick<Console, 'error'> }} [opciones]
 */
export async function avisarFallidos(contexto, { registrar = console } = {}) {
    const { pool, config } = contexto;
    const marca = crypto.randomUUID();
    const [r] = await pool.query(
        `UPDATE eventos SET avisado = UTC_TIMESTAMP(), marca = ? WHERE estado = 'fallido' AND avisado IS NULL ORDER BY id LIMIT ${MAX_FALLIDOS_POR_AVISO}`, [marca]);
    if (!r.affectedRows) return 0;
    const [fallidos] = await pool.query("SELECT id, tipo, clave, error, intentos FROM eventos WHERE marca = ? AND estado = 'fallido' ORDER BY id", [marca]);
    if (!fallidos.length) return 0;
    const masters = await mastersDe(pool, config);
    const lineas = fallidos.map((/** @type {any} */ f) => `• ${f.tipo} (${f.clave}) tras ${f.intentos} intento(s): ${String(f.error || 'sin motivo').slice(0, 200)}`);
    const titulo = fallidos.length === 1 ? 'Un flujo automático falló y ya no se reintenta' : `${fallidos.length} flujos automáticos fallaron y ya no se reintentan`;
    const texto = `⚠️ ${titulo}. Revísalo en la Torre de control (o en /api/salud › eventos):\n${lineas.join('\n')}`;
    try {
        if (masters.length) await registrarAviso(pool, masters.map(m => m.id), 'sistema', texto.replace(/\n/g, ' '));
    } catch (error) {
        // Sin campana, se deja sin marcar para el próximo latido (el correo no sale solo)
        await pool.query('UPDATE eventos SET avisado = NULL WHERE marca = ?', [marca]).catch(() => {});
        throw error;
    }
    // El correo, en segundo plano: si Gmail falla, la campana ya quedó y el aviso no se repite
    if (contexto.google && masters.length) {
        enSegundoPlano(avisarPorCorreo(/** @type {any} */ (contexto), { para: masters.map(m => m.email), asunto: titulo, texto }), /** @type {any} */ (registrar));
    }
    return fallidos.length;
}

/**
 * Una vuelta de todo lo pendiente (lo que hacen los temporizadores del proceso). Cada parte por separado: un fallo
 * en una (p. ej. Google caído) no frena las demás. Devuelve lo hecho y los fallos, sin datos de nadie.
 * @param {{ pool: any, config: any, google: any, avisos: any }} contexto
 * @param {Record<string, any>} manejadores
 * @param {{ ahora?: Date, registrar?: Pick<Console, 'error'> }} [opciones]
 */
export async function vueltaCompleta(contexto, manejadores, { ahora = new Date(), registrar = console } = {}) {
    /** @type {Record<string, unknown>} */
    const hecho = {};
    /** @type {string[]} */
    const fallos = [];
    /** @param {string} nombre @param {() => Promise<unknown>} tarea */
    const parte = async (nombre, tarea) => {
        try {
            hecho[nombre] = await tarea();
        } catch (error) {
            fallos.push(nombre);
            registrar.error(`Latido · ${nombre}:`, /** @type {Error} */ (error).message);
        }
    };
    await parte('eventos', async () => {
        const total = { hechos: 0, reintentar: 0, fallidos: 0 };
        for (let i = 0; i < LOTES_POR_LATIDO; i++) {
            const r = await procesarEventos(contexto, manejadores, { registrar });
            total.hechos += r.hechos; total.reintentar += r.reintentar; total.fallidos += r.fallidos;
            if (r.hechos + r.reintentar + r.fallidos < 5) break; // No quedaba un lote entero
        }
        return total;
    });
    await parte('fallidosAvisados', () => avisarFallidos(contexto, { registrar }));
    await parte('avisos', () => repasar(contexto.pool, contexto.avisos));
    await parte('borja', () => enviarResumenes(contexto, ahora));
    await parte('dormidos', () => revisarDormidos(contexto));
    await parte('recordatorio', () => recordarReportes(contexto, ahora));
    return { hecho, fallos };
}

/**
 * El manejador de GET /api/latido, con su propio freno (una vuelta por minuto y proceso).
 * @param {{ pool: any, config: any, google: any, avisos: any }} contexto
 * @param {Record<string, any>} manejadores
 * @param {{ ahora?: () => number, registrar?: Pick<Console, 'error'> }} [opciones]
 */
export function crearLatido(contexto, manejadores, { ahora = Date.now, registrar = console } = {}) {
    let ultima = 0;
    /** @type {Promise<any> | null} */
    let enCurso = null;
    const arranque = ahora();
    return async (/** @type {any} */ req, /** @type {any} */ res) => {
        const despierto = Math.round((ahora() - arranque) / 1000);
        const minimoS = Number.isFinite(contexto.config.latidoMinimoS) ? contexto.config.latidoMinimoS : LATIDO_MINIMO_S;
        if (enCurso || ahora() - ultima < minimoS * 1000) {
            return res.json({ ok: true, vuelta: 'reciente', despiertoS: despierto });
        }
        ultima = ahora();
        enCurso = vueltaCompleta(contexto, manejadores, { registrar });
        try {
            const { hecho, fallos } = await enCurso;
            const eventos = /** @type {any} */ (hecho.eventos) || null;
            res.json({ ok: !fallos.length, vuelta: 'hecha', despiertoS: despierto, eventos, fallidosAvisados: hecho.fallidosAvisados ?? null, fallos });
        } finally {
            enCurso = null;
        }
    };
}
