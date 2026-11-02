/**
 * Cola de avisos por WhatsApp, guardada en MySQL (tabla cola_avisos).
 *
 * Quien avisa no espera a Meta: los mensajes se encolan y la app responde enseguida. Un repaso cada
 * pocos segundos los envía; si Meta falla un rato (429, 5xx, red), se reintenta con espera creciente
 * (30 s, 1 min, 2 min, 4 min…) hasta INTENTOS veces. Lo que Meta rechaza para siempre (número
 * inválido, plantilla mal configurada) queda como fallido con el motivo, sin repetirse.
 *
 * Está en MySQL y no en Redis porque el hosting compartido no trae Redis; además sobrevive a reinicios:
 * si el proceso se para, lo pendiente sale en el siguiente repaso.
 */
import crypto from 'node:crypto';
import { esPasajero } from './reintentos.js';
import { textoWhatsapp } from './avisos.js';

export const INTENTOS = 6;
const LOTE = 10;              // Mensajes por repaso (Meta admite muchos más; así no se satura nada)
const ESPERA_BASE_S = 30;
const BLOQUEO_MIN = 5;        // Lo que lleva tanto "enviando" se da por perdido (el proceso se cayó) y se repite

export async function encolarWhatsapp(pool, telefonos, mensaje) {
    const texto = textoWhatsapp(mensaje);
    if (!texto || !telefonos.length) return 0;
    await pool.query('INSERT INTO cola_avisos (telefono, texto) VALUES ?', [telefonos.map(t => [t, texto])]);
    return telefonos.length;
}

// Un repaso: reclama lo que toca enviar, lo envía y anota el resultado. Devuelve { enviados, reintentar, fallidos }
export async function repasar(pool, avisos) {
    const resultado = { enviados: 0, reintentar: 0, fallidos: 0 };
    if (!avisos.whatsappActivo) return resultado;
    const marca = crypto.randomUUID();
    // Reclamar con un UPDATE atómico: dos procesos a la vez no se llevan el mismo mensaje
    await pool.query(
        `UPDATE cola_avisos SET estado = 'enviando', marca = ?, reclamado = UTC_TIMESTAMP()
         WHERE (estado = 'pendiente' AND proximo <= UTC_TIMESTAMP())
            OR (estado = 'enviando' AND reclamado < UTC_TIMESTAMP() - INTERVAL ${BLOQUEO_MIN} MINUTE)
         ORDER BY id LIMIT ${LOTE}`, [marca]);
    const [filas] = await pool.query('SELECT id, telefono, texto, intentos FROM cola_avisos WHERE marca = ? AND estado = \'enviando\'', [marca]);
    for (const fila of filas) {
        const intentos = fila.intentos + 1;
        try {
            await avisos.whatsappUno(fila.telefono, fila.texto);
            await pool.query("UPDATE cola_avisos SET estado = 'enviado', intentos = ?, error = '', enviado = UTC_TIMESTAMP() WHERE id = ?", [intentos, fila.id]);
            resultado.enviados++;
        } catch (error) {
            const motivo = `${error.message}${error.detalle ? ` · ${String(error.detalle).slice(0, 300)}` : ''}`.slice(0, 500);
            if (esPasajero(error) && intentos < INTENTOS) {
                const espera = ESPERA_BASE_S * 2 ** (intentos - 1);
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
            if (r.fallidos) registrar.error(`WhatsApp: ${r.fallidos} aviso(s) no se pudieron enviar (ver tabla cola_avisos)`);
        } catch (error) {
            registrar.error('Cola de WhatsApp:', error.message);
        } finally {
            ocupado = false;
        }
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}

// Resumen para /api/salud y para los administradores
export async function estadoCola(pool) {
    const [filas] = await pool.query('SELECT estado, COUNT(*) n FROM cola_avisos GROUP BY estado');
    return Object.fromEntries(filas.map(f => [f.estado, Number(f.n)]));
}
