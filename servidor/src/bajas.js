// @ts-check
/**
 * Consentimiento y baja de WhatsApp de los clientes (Ley 172-13 de República Dominicana y política de Meta).
 *
 * - Un cliente que escribe BAJA (o STOP, CANCELAR, "no más mensajes") al número de WhatsApp de la empresa deja de
 *   recibir mensajes de la empresa por WhatsApp al momento: su número va a la lista de bajas (tabla `ajustes`, clave
 *   'whatsappBajas') y su ficha queda marcada "No quiere mensajes de WhatsApp" (cambio auditado, a nombre del
 *   sistema). Se le contesta una vez, confirmándolo. Con ALTA vuelve a recibirlos.
 * - El equipo también puede marcar o desmarcar la casilla en la ficha del cliente (p. ej. si lo pidió por teléfono).
 * - Antes de enviar cualquier WhatsApp a un cliente (acciones.js › avisarCliente) se comprueban las dos cosas.
 */
import * as db from './db.js';
import { normalizarTelefono } from './avisos.js';
import { guardarAjuste } from './mensajes.js';

const sinAcentos = (/** @type {string} */ t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
const PIDE_BAJA = /^(baja|darme de baja|dar de baja|stop|parar|cancelar|unsubscribe|no (quiero|deseo) (recibir )?(mas )?mensajes|no mas mensajes|no me escriban)\b/;
const PIDE_ALTA = /^(alta|start|volver a recibir)\b/;

/**
 * ¿El texto pide la baja o el alta? 'baja' | 'alta' | null
 * @param {unknown} texto
 */
export function pideBajaOAlta(texto) {
    const t = sinAcentos(String(texto || '')).trim().toLowerCase().replace(/[.!¡¿?]+/g, '').replace(/\s+/g, ' ');
    if (!t || t.length > 60) return null;
    if (PIDE_BAJA.test(t)) return 'baja';
    if (PIDE_ALTA.test(t)) return 'alta';
    return null;
}

export const TEXTO_BAJA = 'Listo: no le enviaremos más mensajes de WhatsApp de Semences del Caribe. Si quiere volver a recibirlos, escriba ALTA.';
export const TEXTO_ALTA = 'Listo: volverá a recibir los avisos de Semences del Caribe por WhatsApp. Para dejar de recibirlos, escriba BAJA.';

/** @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool @returns {Promise<Record<string, string>>} número → fecha */
export async function leerBajas(pool) {
    const [filas] = await pool.query("SELECT valor FROM ajustes WHERE clave = 'whatsappBajas'");
    if (!filas.length) return {};
    try {
        const valor = JSON.parse(filas[0].valor);
        return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    } catch (e) {
        return {};
    }
}

const numerosDe = (/** @type {any} */ cliente) => [cliente.whatsapp, cliente.telefono].map(t => normalizarTelefono(t)).filter(Boolean);

/**
 * ¿Ese número pidió no recibir WhatsApp? (lista de bajas o ficha de cliente marcada)
 * @param {any} pool @param {string} numero ya normalizado
 */
export async function whatsappDadoDeBaja(pool, numero) {
    if (!numero) return false;
    if ((await leerBajas(pool))[numero]) return true;
    const clientes = /** @type {any[]} */ ((await db.listarTodo(pool)).clientes || []);
    return clientes.some((/** @type {any} */ c) => c.sinWhatsapp === true && numerosDe(c).includes(numero));
}

/**
 * Aplica una baja (o un alta) pedida desde WhatsApp: lista de bajas y fichas de los clientes con ese número (cada
 * cambio auditado a nombre del sistema). Devuelve cuántas fichas cambiaron.
 * @param {{ pool: any, config: any }} contexto @param {string} numero @param {'baja' | 'alta'} que
 */
export async function aplicarBaja({ pool, config }, numero, que) {
    const bajas = await leerBajas(pool);
    const ahora = new Date().toISOString();
    if (que === 'baja') bajas[numero] = bajas[numero] || ahora;
    else delete bajas[numero];
    await guardarAjuste(pool, 'whatsappBajas', bajas, `whatsapp:${numero}`);
    const clientes = /** @type {any[]} */ ((await db.listarTodo(pool)).clientes || []);
    let cambiadas = 0;
    for (const cliente of clientes.filter((/** @type {any} */ c) => numerosDe(c).includes(numero))) {
        const quiere = que === 'alta';
        if (Boolean(cliente.sinWhatsapp) === !quiere) continue;
        const nuevo = { ...cliente, sinWhatsapp: !quiere, bajaWhatsapp: quiere ? '' : ahora };
        await db.guardarRegistro(pool, 'clientes', nuevo, null, /** @type {any} */ ({ config, sistema: `WhatsApp: el cliente pidió la ${que}` }));
        cambiadas++;
    }
    return cambiadas;
}
