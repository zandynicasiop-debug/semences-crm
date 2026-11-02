/**
 * Cola de avisos por WhatsApp y push, guardada en MySQL (tabla cola_avisos).
 *
 * Quien avisa no espera a Meta ni a los servicios push: los mensajes se encolan y la app responde
 * enseguida. Un repaso cada pocos segundos los envía; si fallan un rato (429, 5xx, red), se reintenta con espera creciente
 * (30 s, 1 min, 2 min, 4 min…, más un poco al azar) hasta INTENTOS veces. Lo que se rechaza para siempre (número
 * inválido, plantilla mal configurada, suscripción push dada de baja) queda como fallido con el motivo, sin repetirse.
 *
 * destino: el teléfono (whatsapp) o la huella de la suscripción (push).
 *
 * Está en MySQL y no en Redis porque el hosting compartido no trae Redis; además sobrevive a reinicios:
 * si el proceso se para, lo pendiente sale en el siguiente repaso.
 */
import crypto from 'node:crypto';
import { esPasajero, conVariacion } from './reintentos.js';
import { textoWhatsapp } from './avisos.js';

export const INTENTOS = 6;
const LOTE = 10;              // Mensajes por repaso (Meta admite muchos más; así no se satura nada)
const ESPERA_BASE_S = 30;
const BLOQUEO_MIN = 5;        // Lo que lleva tanto "enviando" se da por perdido (el proceso se cayó) y se repite

export async function encolar(pool, canal, destinos, mensaje) {
    const texto = String(mensaje || '').trim().slice(0, 1000);
    if (!texto || !destinos.length) return 0;
    await pool.query('INSERT INTO cola_avisos (canal, destino, texto) VALUES ?', [destinos.map(d => [canal, d, texto])]);
    return destinos.length;
}

// Lo que muestra el aviso push: título, texto y la página que abre al tocarlo
function contenidoPush(texto) {
    const [primera, ...resto] = texto.split('\n');
    return resto.length
        ? { titulo: primera.slice(0, 120), texto: resto.join('\n').slice(0, 500) }
        : { titulo: 'Semences del Caribe · Aviso del equipo', texto: texto.slice(0, 500) };
}

async function enviarUno(pool, avisos, fila) {
    if (fila.canal === 'whatsapp') return avisos.whatsappUno(fila.destino, textoWhatsapp(fila.texto));
    const [subs] = await pool.query('SELECT endpoint, p256dh, auth FROM push_suscripciones WHERE huella = ?', [fila.destino]);
    if (!subs.length) throw Object.assign(new Error('La suscripción push ya no existe'), { definitivo: true });
    try {
        await avisos.pushUno(subs[0], contenidoPush(fila.texto));
    } catch (error) {
        // 404/410: el navegador anuló la suscripción (se desinstaló la app, se quitó el permiso…)
        if ([404, 410].includes(Number(error.statusCode))) {
            await pool.query('DELETE FROM push_suscripciones WHERE huella = ?', [fila.destino]);
            error.message = `Suscripción push caducada (${error.statusCode}): borrada`;
        }
        throw error;
    }
}

// Un repaso: reclama lo que toca enviar, lo envía y anota el resultado. Devuelve { enviados, reintentar, fallidos }
export async function repasar(pool, avisos) {
    const resultado = { enviados: 0, reintentar: 0, fallidos: 0 };
    const canales = [avisos.whatsappActivo && 'whatsapp', avisos.pushActivo && 'push'].filter(Boolean);
    if (!canales.length) return resultado;
    const marca = crypto.randomUUID();
    // Reclamar con un UPDATE atómico: dos procesos a la vez no se llevan el mismo mensaje
    await pool.query(
        `UPDATE cola_avisos SET estado = 'enviando', marca = ?, reclamado = UTC_TIMESTAMP()
         WHERE canal IN (?) AND ((estado = 'pendiente' AND proximo <= UTC_TIMESTAMP())
            OR (estado = 'enviando' AND reclamado < UTC_TIMESTAMP() - INTERVAL ${BLOQUEO_MIN} MINUTE))
         ORDER BY id LIMIT ${LOTE}`, [marca, canales]);
    const [filas] = await pool.query('SELECT id, canal, destino, texto, intentos FROM cola_avisos WHERE marca = ? AND estado = \'enviando\'', [marca]);
    for (const fila of filas) {
        const intentos = fila.intentos + 1;
        try {
            await enviarUno(pool, avisos, fila);
            await pool.query("UPDATE cola_avisos SET estado = 'enviado', intentos = ?, error = '', enviado = UTC_TIMESTAMP() WHERE id = ?", [intentos, fila.id]);
            resultado.enviados++;
        } catch (error) {
            const motivo = `${error.message}${error.detalle ? ` · ${String(error.detalle).slice(0, 300)}` : ''}`.slice(0, 500);
            if (!error.definitivo && esPasajero(error) && intentos < INTENTOS) {
                const espera = conVariacion(ESPERA_BASE_S * 2 ** (intentos - 1));
                await pool.query(
                    `UPDATE cola_avisos SET estado = 'pendiente', intentos = ?, error = ?, proximo = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ?`,
                    [intentos, motivo, espera, fila.id]);
                resultado.reintentar++;
            } else {
                await pool.query("UPDATE cola_avisos SET estado = 'fallido', intentos = ?, error = ? WHERE id = ?", [intentos, motivo, fila.id]);
                resultado.fallidos++;
            }
        }
    }
    // Limpieza: lo enviado o fallido hace más de 30 días ya no hace falta
    await pool.query("DELETE FROM cola_avisos WHERE estado IN ('enviado', 'fallido') AND creado < UTC_TIMESTAMP() - INTERVAL 30 DAY");
    return resultado;
}

// Repaso periódico en el propio proceso. Devuelve la función para pararlo
export function iniciarCola(pool, avisos, { cadaMs = 5000, registrar = console } = {}) {
    let ocupado = false;
    const temporizador = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try {
            const r = await repasar(pool, avisos);
            if (r.fallidos) registrar.error(`Avisos: ${r.fallidos} no se pudieron enviar (ver tabla cola_avisos)`);
        } catch (error) {
            registrar.error('Cola de avisos:', error.message);
        } finally {
            ocupado = false;
        }
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}

// Resumen para /api/salud y para los administradores ({ whatsapp: { enviado: 3, … }, push: { … } })
export async function estadoCola(pool) {
    const [filas] = await pool.query('SELECT canal, estado, COUNT(*) n FROM cola_avisos GROUP BY canal, estado');
    const estado = {};
    for (const f of filas) (estado[f.canal] = estado[f.canal] || {})[f.estado] = Number(f.n);
    return estado;
}
