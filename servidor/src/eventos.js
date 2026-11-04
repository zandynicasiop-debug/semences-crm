// @ts-check
/**
 * Motor de eventos del CRM: arquitectura orientada a eventos con "outbox transaccional".
 *
 * 1. Disparadores (patrón Observer): cada regla mira los registros que se acaban de guardar y, si su
 *    condición se cumple (p. ej. un cliente pasa a la etapa "Reunión"), emite un evento. El evento se
 *    escribe DENTRO de la misma transacción que el cambio: si la transacción se deshace, el evento
 *    tampoco existe, y si se confirma, el evento no se pierde aunque el proceso se caiga justo después.
 * 2. Idempotencia: cada evento lleva una clave única (p. ej. "reunion:<cliente>:<día>"). Guardar dos
 *    veces el mismo cambio, o un reintento de la app, no encola dos veces la misma acción.
 * 3. Trabajador en segundo plano: reclama lotes con un UPDATE atómico (vale igual en MySQL 8.4 y en
 *    MariaDB 10.11, como la cola de avisos) y ejecuta el manejador de cada tipo.
 * 4. Pasos con punto de control: un manejador hace su trabajo con paso('nombre', tarea). El resultado
 *    de cada paso se guarda al terminar; si el evento se reintenta, los pasos hechos no se repiten
 *    (no se crean dos PDF, ni dos carpetas, ni dos avisos).
 * 5. Errores: lo pasajero (429, 5xx, red, tiempo agotado: reintentos.js) se reintenta con espera
 *    exponencial y variación al azar (30 s, 1, 2, 4… min); lo definitivo, o el sexto intento, queda como
 *    'fallido' con su motivo (cola de mensajes muertos, visible en /api/salud). Un evento que se quedó
 *    'procesando' más de BLOQUEO_MIN (el proceso se cayó) se vuelve a reclamar.
 */
import crypto from 'node:crypto';
import { esPasajero, conVariacion } from './reintentos.js';

/** @typedef {'pendiente' | 'procesando' | 'hecho' | 'fallido'} EstadoEvento */

/**
 * @typedef {Object} Evento
 * @property {number} id
 * @property {string} tipo
 * @property {string} clave
 * @property {number | null} usuarioId
 * @property {Record<string, any>} carga
 * @property {number} intentos  Intentos contando el actual
 */

/** @typedef {<T>(nombre: string, tarea: () => Promise<T>) => Promise<T>} Paso */

/** @typedef {(evento: Evento, herramientas: { paso: Paso, contexto: any }) => Promise<void>} Manejador */

/**
 * @typedef {Object} EventoNuevo
 * @property {string} tipo        MAYÚSCULAS_CON_GUIONES
 * @property {string} clave       Única: el mismo hecho, la misma clave
 * @property {number | null} [usuarioId]
 * @property {Record<string, any>} [carga]
 * @property {number} [retrasoS]  Segundos de espera antes de procesarlo
 */

/**
 * @typedef {Object} Regla
 * @property {string} nombre
 * @property {string} modulo
 * @property {(registro: Record<string, any>, anterior: Record<string, any> | null) => boolean} cuando
 * @property {(registro: Record<string, any>, anterior: Record<string, any> | null, contexto: { usuario: { id: number }, hoy: string }) => EventoNuevo} evento
 */

/** @typedef {{ query: (sql: string, valores?: any) => Promise<any> }} Consultable */

export const INTENTOS_EVENTO = 6;
const ESPERA_BASE_S = 30;
const BLOQUEO_MIN = 10;
const MAX_CARGA = 20000;

export const ESQUEMA_EVENTOS = [
    `CREATE TABLE IF NOT EXISTS eventos (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tipo VARCHAR(50) NOT NULL,
        clave VARCHAR(190) NOT NULL,
        usuario_id INT UNSIGNED NULL,
        carga TEXT NOT NULL,
        pasos MEDIUMTEXT NULL,
        estado ENUM('pendiente', 'procesando', 'hecho', 'fallido') NOT NULL DEFAULT 'pendiente',
        intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
        proximo DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        marca CHAR(36) NULL,
        reclamado DATETIME NULL,
        terminado DATETIME NULL,
        error VARCHAR(500) NOT NULL DEFAULT '',
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY clave (clave),
        INDEX (estado, proximo)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

/**
 * Encola un evento. Con la conexión de la transacción que hizo el cambio, el evento y el cambio se
 * confirman (o se deshacen) juntos. Devuelve true si se encoló y false si ya había uno con esa clave.
 * @param {Consultable} conexion
 * @param {EventoNuevo} evento
 * @returns {Promise<boolean>}
 */
export async function emitirEvento(conexion, { tipo, clave, usuarioId = null, carga = {}, retrasoS = 0 }) {
    if (!/^[A-Z][A-Z_]{2,49}$/.test(tipo)) throw new Error(`Tipo de evento no válido: ${tipo}`);
    if (!clave || clave.length > 190) throw new Error('La clave del evento tiene que tener entre 1 y 190 caracteres');
    const texto = JSON.stringify(carga);
    if (texto.length > MAX_CARGA) throw new Error('La carga del evento es demasiado grande');
    try {
        await conexion.query(
            'INSERT INTO eventos (tipo, clave, usuario_id, carga, proximo) VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND)',
            [tipo, clave, usuarioId, texto, Math.max(0, Math.trunc(retrasoS))]);
        return true;
    } catch (error) {
        // Clave repetida: el mismo hecho ya estaba encolado (en InnoDB solo falla esta sentencia, no la transacción)
        if (/** @type {any} */ (error).errno === 1062) return false;
        throw error;
    }
}

/**
 * Patrón Observer: las reglas cuyo disparador se cumple para alguno de los registros guardados.
 * @param {Regla[]} reglas
 * @param {{ modulo: string, registro: Record<string, any>, anterior: Record<string, any> | null }[]} guardados
 * @param {{ usuario: { id: number }, hoy: string }} contexto
 * @returns {EventoNuevo[]}
 */
export function eventosDeCambios(reglas, guardados, contexto) {
    const eventos = [];
    for (const { modulo, registro, anterior } of guardados) {
        for (const regla of reglas) {
            if (regla.modulo === modulo && regla.cuando(registro, anterior)) eventos.push(regla.evento(registro, anterior, contexto));
        }
    }
    return eventos;
}

/**
 * Emite, dentro de la transacción, los eventos de los registros guardados. Devuelve cuántos se encolaron.
 * @param {Consultable} conexion
 * @param {Regla[]} reglas
 * @param {Parameters<typeof eventosDeCambios>[1]} guardados
 * @param {Parameters<typeof eventosDeCambios>[2]} contexto
 */
export async function emitirEventosDeCambios(conexion, reglas, guardados, contexto) {
    let n = 0;
    for (const evento of eventosDeCambios(reglas, guardados, contexto)) if (await emitirEvento(conexion, evento)) n++;
    return n;
}

/**
 * Error que no tiene sentido reintentar (el evento queda 'fallido' al momento).
 * @param {string} mensaje
 */
export function errorDefinitivo(mensaje) {
    return Object.assign(new Error(mensaje), { definitivo: true });
}

/** @type {<T>(texto: string | null | undefined, defecto: T) => T} */
const leerJson = (texto, defecto) => { try { return texto ? JSON.parse(texto) : defecto; } catch (e) { return defecto; } };

/**
 * Un repaso: reclama hasta `lote` eventos y los procesa uno a uno. Devuelve { hechos, reintentar, fallidos }.
 * @param {{ pool: Consultable } & Record<string, any>} contexto
 * @param {Record<string, Manejador>} manejadores
 * @param {{ lote?: number, registrar?: Pick<Console, 'error'> }} [opciones]
 */
export async function procesarEventos(contexto, manejadores, { lote = 5, registrar = console } = {}) {
    const { pool } = contexto;
    const resultado = { hechos: 0, reintentar: 0, fallidos: 0 };
    const marca = crypto.randomUUID();
    // Reclamar con un UPDATE atómico: dos procesos a la vez no se llevan el mismo evento. El intento se
    // cuenta al reclamar: si el proceso muere a medias, ese intento también cuenta (no hay bucles eternos)
    await pool.query(
        `UPDATE eventos SET estado = 'procesando', marca = ?, reclamado = UTC_TIMESTAMP(), intentos = intentos + 1
         WHERE (estado = 'pendiente' AND proximo <= UTC_TIMESTAMP())
            OR (estado = 'procesando' AND reclamado < UTC_TIMESTAMP() - INTERVAL ${BLOQUEO_MIN} MINUTE)
         ORDER BY id LIMIT ${Math.max(1, Math.trunc(lote))}`, [marca]);
    const [filas] = await pool.query(
        "SELECT id, tipo, clave, usuario_id, carga, pasos, intentos FROM eventos WHERE marca = ? AND estado = 'procesando' ORDER BY id", [marca]);

    for (const fila of filas) {
        // Todas las escrituras van con la marca: si otro proceso lo reclamó (se pasó el tiempo), esta ya no cuenta
        /** @type {(sql: string, valores: unknown[]) => Promise<any>} */
        const actualizar = (sql, valores) => pool.query(`${sql} WHERE id = ? AND marca = ?`, [...valores, fila.id, marca]);
        const pasos = leerJson(fila.pasos, /** @type {Record<string, any>} */ ({}));
        /** @type {Paso} */
        const paso = async (nombre, tarea) => {
            if (Object.hasOwn(pasos, nombre)) return pasos[nombre];
            const valor = await tarea();
            pasos[nombre] = valor === undefined ? null : valor;
            await actualizar('UPDATE eventos SET pasos = ?', [JSON.stringify(pasos)]);
            return pasos[nombre];
        };
        /** @type {Evento} */
        const evento = { id: Number(fila.id), tipo: fila.tipo, clave: fila.clave, usuarioId: fila.usuario_id === null ? null : Number(fila.usuario_id), carga: leerJson(fila.carga, {}), intentos: Number(fila.intentos) };
        try {
            const manejador = Object.hasOwn(manejadores, evento.tipo) ? manejadores[evento.tipo] : null;
            if (!manejador) throw errorDefinitivo(`No hay manejador para ${evento.tipo}`);
            await manejador(evento, { paso, contexto });
            await actualizar("UPDATE eventos SET estado = 'hecho', terminado = UTC_TIMESTAMP(), error = ''", []);
            resultado.hechos++;
        } catch (fallo) {
            const error = /** @type {Error & { definitivo?: boolean }} */ (fallo);
            const motivo = String((error && error.message) || error).slice(0, 500);
            const definitivo = Boolean(error && error.definitivo) || !esPasajero(error);
            if (!definitivo && evento.intentos < INTENTOS_EVENTO) {
                const espera = conVariacion(ESPERA_BASE_S * 2 ** (evento.intentos - 1));
                await actualizar("UPDATE eventos SET estado = 'pendiente', error = ?, proximo = UTC_TIMESTAMP() + INTERVAL ? SECOND", [motivo, espera]);
                resultado.reintentar++;
            } else {
                await actualizar("UPDATE eventos SET estado = 'fallido', error = ?, terminado = UTC_TIMESTAMP()", [motivo]);
                registrar.error(`Evento ${evento.tipo} (${evento.clave}) fallido:`, motivo);
                resultado.fallidos++;
            }
        }
    }
    // Limpieza: lo hecho hace más de 30 días ya no hace falta (lo fallido se queda 90 días para revisarlo)
    await pool.query("DELETE FROM eventos WHERE (estado = 'hecho' AND creado < UTC_TIMESTAMP() - INTERVAL 30 DAY) OR (estado = 'fallido' AND creado < UTC_TIMESTAMP() - INTERVAL 90 DAY)");
    return resultado;
}

/**
 * Trabajador periódico en el propio proceso. Nunca se queda bloqueado: cualquier fallo (incluso sin
 * conexión con la base) se registra y el siguiente repaso lo vuelve a intentar. Devuelve la función para pararlo.
 * @param {Parameters<typeof procesarEventos>[0]} contexto
 * @param {Record<string, Manejador>} manejadores
 * @param {{ cadaMs?: number, registrar?: Pick<Console, 'error'> }} [opciones]
 */
export function iniciarEventos(contexto, manejadores, { cadaMs = 3000, registrar = console } = {}) {
    let ocupado = false;
    const temporizador = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try {
            await procesarEventos(contexto, manejadores, { registrar });
        } catch (error) {
            registrar.error('Eventos:', /** @type {Error} */ (error).message);
        } finally {
            ocupado = false;
        }
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}

/**
 * Resumen por tipo y estado, para /api/salud: { CLIENTE_EN_REUNION: { hecho: 3, fallido: 1 } }
 * @param {Consultable} pool
 */
export async function estadoEventos(pool) {
    const [filas] = await pool.query('SELECT tipo, estado, COUNT(*) n FROM eventos GROUP BY tipo, estado');
    /** @type {Record<string, Record<string, number>>} */
    const estado = {};
    for (const f of filas) (estado[f.tipo] = estado[f.tipo] || {})[f.estado] = Number(f.n);
    return estado;
}
