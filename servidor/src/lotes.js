// @ts-check
/**
 * Lote de operaciones hechas sin conexión: POST /api/sincronizar-lote.
 *
 * Hoy, los cambios de etapa de los clientes que la web guardó en su cola (colaEtapas.js, IndexedDB) mientras
 * no había red. Cada operación es { operacionId, clienteId, cambios: { etapa }, anterior?: { etapa } }.
 *
 * - Una sola vez: el operacionId (un UUID que crea el teléfono) queda apuntado en operaciones_lote (db.js) dentro de la
 *   misma transacción que el cambio. Si el teléfono reenvía el lote (se cortó la respuesta), esa operación
 *   contesta "duplicado" y no se vuelve a tocar nada.
 * - Solo el campo: la etapa se cambia sobre el cliente tal como está en la base en ese momento (bloqueado con
 *   FOR UPDATE). Lo que otra persona cambió mientras tanto (teléfono, notas…) se conserva: no es "el último que
 *   sube pisa el registro entero", como pasaría subiendo la copia vieja del teléfono.
 * - Sin pisar a otro: con anterior.etapa (la que veía el teléfono al cambiarla), si alguien ya movió ese cliente
 *   a otra etapa, la operación se rechaza como conflicto y no se aplica. Un cliente que en la oficina pasó a
 *   "Cliente" no vuelve a "Reunión" porque un teléfono sin señal lo movió hace tres días.
 * - Las mismas reglas que la sincronización normal (db.sincronizar): permisos por cargo, país y casa (el
 *   registro nuevo y el que había), auditoría, y los disparadores en la misma transacción: pasar a "Reunión"
 *   desde el lote prepara la reunión igual (flujos.js).
 * - Cada operación tiene su respuesta: aplicado, duplicado o rechazado (con codigo y motivo). Lo rechazado no
 *   se reintenta. La sala de espera (403) y el reporte semanal sin entregar (423) se comprueban antes, para todo
 *   el lote (aplicacion.js), como en /api/accion: con 423 no se aplica ni se pierde nada.
 */
import * as db from './db.js';
import { puedeEscribir } from './permisos.js';
import { emitirEventosDeCambios } from './eventos.js';
import { REGLAS, ETAPAS_CLIENTE } from './flujos.js';
import { enZona } from './fechas.js';
import { auditar } from './auditoria.js';

export const MAX_OPERACIONES = 100;
const ID_OPERACION = /^[A-Za-z0-9-]{8,64}$/;
const DIAS_RECUERDO = 90; // Un teléfono que reenvía algo de hace más de 90 días ya no se reconoce como repetido

/**
 * @typedef {Object} Operacion
 * @property {string} operacionId
 * @property {string} clienteId
 * @property {{ etapa: string }} cambios
 * @property {{ etapa: string }} [anterior]
 */

/**
 * @typedef {Object} Resultado
 * @property {string} operacionId
 * @property {'aplicado' | 'duplicado' | 'rechazado'} estado
 * @property {string} [codigo]   rechazado: 'datos', 'permiso', 'conflicto', 'no-existe' o 'ajena'
 * @property {string} [motivo]
 * @property {{ etapa: string }} [actual]   conflicto: la etapa que tiene ahora en el servidor
 */

/** @param {string} mensaje */
const errorDatos = (mensaje) => Object.assign(new Error(mensaje), { estado: 400, codigo: 'datos' });

/**
 * El cuerpo de la petición: { operaciones: [...] }. Lo que no es una lista, o pasa del máximo, es un 400 para
 * todo el lote; cada operación se revisa después por separado (una mala no tumba a las demás).
 * @param {unknown} cuerpo
 * @returns {unknown[]}
 */
export function comprobarLote(cuerpo) {
    const operaciones = cuerpo && typeof cuerpo === 'object' ? /** @type {{ operaciones?: unknown }} */ (cuerpo).operaciones : undefined;
    if (!Array.isArray(operaciones)) throw errorDatos('Falta la lista de operaciones');
    if (operaciones.length > MAX_OPERACIONES) throw errorDatos(`Demasiadas operaciones a la vez (máximo ${MAX_OPERACIONES})`);
    return operaciones;
}

/**
 * Qué tiene de malo una operación, o null si está bien. Solo se admite cambiar la etapa, a una que exista.
 * @param {unknown} op
 * @returns {string | null}
 */
export function motivoInvalido(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return 'La operación no es un objeto';
    const { operacionId, clienteId, cambios, anterior } = /** @type {Record<string, unknown>} */ (op);
    if (typeof operacionId !== 'string' || !ID_OPERACION.test(operacionId)) return 'operacionId no válido';
    if (typeof clienteId !== 'string' || !/^[\w-]{1,100}$/.test(clienteId)) return 'clienteId no válido';
    if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) return 'Faltan los cambios';
    const campos = Object.keys(cambios);
    if (campos.length !== 1 || campos[0] !== 'etapa') return 'Solo se puede cambiar la etapa del cliente';
    const esEtapa = (/** @type {unknown} */ v) => v === '' || (typeof v === 'string' && ETAPAS_CLIENTE.includes(v));
    if (!esEtapa(/** @type {{ etapa?: unknown }} */ (cambios).etapa)) return `Etapa desconocida (las válidas: ${ETAPAS_CLIENTE.join(', ')})`;
    if (anterior !== undefined && (!anterior || typeof anterior !== 'object' || !esEtapa(/** @type {{ etapa?: unknown }} */ (anterior).etapa))) {
        return 'anterior.etapa no válida';
    }
    return null;
}

let ultimaLimpieza = 0;

/**
 * Aplica las operaciones en orden, cada una en su transacción. Devuelve un resultado por operación.
 * Lo inesperado (base caída…) se lanza: el teléfono reintenta el lote entero y lo ya aplicado sale "duplicado".
 * @param {{ pool: any, config: any, usuario: { id: number, email: string } & Record<string, any>, ambito: any, red?: any, registrar?: Pick<Console, 'error'> }} contexto
 * @param {unknown[]} operaciones
 * @returns {Promise<Resultado[]>}
 */
export async function aplicarLote(contexto, operaciones) {
    const { pool } = contexto;
    if (Date.now() - ultimaLimpieza > 3600000) {
        ultimaLimpieza = Date.now();
        await pool.query(`DELETE FROM operaciones_lote WHERE creado < UTC_TIMESTAMP() - INTERVAL ${DIAS_RECUERDO} DAY`);
    }
    /** @type {Resultado[]} */
    const resultados = [];
    for (const op of operaciones) resultados.push(await aplicarUna(contexto, op));
    return resultados;
}

/**
 * @param {Parameters<typeof aplicarLote>[0]} contexto
 * @param {unknown} entrada
 * @returns {Promise<Resultado>}
 */
async function aplicarUna(contexto, entrada) {
    const { pool, config, usuario, ambito, red } = contexto;
    const invalido = motivoInvalido(entrada);
    const id = entrada && typeof entrada === 'object' ? String(/** @type {{ operacionId?: unknown }} */ (entrada).operacionId ?? '').slice(0, 64) : '';
    if (invalido) return { operacionId: id, estado: 'rechazado', codigo: 'datos', motivo: invalido };
    const op = /** @type {Operacion} */ (entrada);

    // ¿Ya llegó antes? (el teléfono no recibió la respuesta y la reenvía)
    const [previas] = await pool.query('SELECT usuario_id, estado, codigo, motivo FROM operaciones_lote WHERE operacion_id = ?', [op.operacionId]);
    if (previas.length) {
        if (Number(previas[0].usuario_id) !== Number(usuario.id)) return { operacionId: op.operacionId, estado: 'rechazado', codigo: 'ajena', motivo: 'Esa operación es de otra cuenta' };
        return previas[0].estado === 'aplicado'
            ? { operacionId: op.operacionId, estado: 'duplicado' }
            : { operacionId: op.operacionId, estado: 'rechazado', codigo: previas[0].codigo || 'datos', motivo: previas[0].motivo };
    }

    /**
     * @param {string} codigo
     * @param {string} motivo
     * @param {{ etapa: string }} [actual]
     * @returns {Promise<Resultado>}
     */
    const rechazar = async (codigo, motivo, actual) => {
        await pool.query(
            `INSERT INTO operaciones_lote (operacion_id, usuario_id, cliente_id, estado, codigo, motivo) VALUES (?, ?, ?, 'rechazado', ?, ?)
             ON DUPLICATE KEY UPDATE operacion_id = operacion_id`,
            [op.operacionId, usuario.id, op.clienteId, codigo, motivo.slice(0, 200)]);
        // Un intento sin permiso queda en la auditoría, como en /api/accion
        if (codigo === 'permiso') await auditar(pool, config, { usuario, accion: 'denegado', modulo: 'clientes', objeto: op.clienteId, resumen: motivo, red });
        return { operacionId: op.operacionId, estado: 'rechazado', codigo, motivo, ...(actual ? { actual } : {}) };
    };

    const visto = await db.leerRegistro(pool, 'clientes', op.clienteId);
    if (!visto) return rechazar('no-existe', 'El cliente ya no existe');
    const cambios = { etapa: op.cambios.etapa };
    /** @type {{ etapa: string } | null} */
    let conflicto = null;
    try {
        await db.sincronizar(pool, { guardar: [{ modulo: 'clientes', registro: { ...visto, ...cambios } }] }, usuario,
            (/** @type {string} */ modulo, /** @type {Record<string, any>} */ registro, /** @type {string | undefined} */ operacion) => puedeEscribir(ambito, modulo, registro, operacion),
            {
                auditoria: { config, red },
                // Sobre la copia bloqueada en la transacción: lo que otro cambió entretanto se conserva
                ajustar: (/** @type {string} */ modulo, /** @type {any} */ registro, /** @type {any} */ anterior) => {
                    if (!anterior) throw Object.assign(new Error('El cliente ya no existe'), { estado: 404, codigo: 'no-existe' });
                    if (op.anterior && (anterior.etapa || '') !== op.anterior.etapa && (anterior.etapa || '') !== cambios.etapa) {
                        conflicto = { etapa: anterior.etapa || '' };
                        throw Object.assign(new Error('Otra persona ya cambió la etapa de ese cliente'), { estado: 409, codigo: 'conflicto' });
                    }
                    return { ...anterior, ...cambios };
                },
                alConfirmar: async (/** @type {any} */ conexion, /** @type {any[]} */ guardados) => {
                    await emitirEventosDeCambios(conexion, REGLAS, guardados, { usuario, hoy: enZona(new Date(), config.zonaHoraria).fecha });
                    await conexion.query("INSERT INTO operaciones_lote (operacion_id, usuario_id, cliente_id, estado) VALUES (?, ?, ?, 'aplicado')",
                        [op.operacionId, usuario.id, op.clienteId]);
                },
                devolverDatos: false
            });
        return { operacionId: op.operacionId, estado: 'aplicado' };
    } catch (fallo) {
        const error = /** @type {Error & { estado?: number, codigo?: string, code?: string }} */ (fallo);
        // La misma operación entró a la vez por otra petición: ya está aplicada
        if (error.code === 'ER_DUP_ENTRY') return { operacionId: op.operacionId, estado: 'duplicado' };
        if (error.estado === 409) return rechazar('conflicto', error.message, conflicto || undefined);
        if (error.estado === 403) return rechazar('permiso', 'No tienes permiso para cambiar ese cliente (país o casa comercial)');
        if (error.estado === 404) return rechazar('no-existe', error.message);
        throw error;
    }
}
