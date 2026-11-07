// @ts-check
/**
 * Pedidos (fase 2): la venta de cada cliente por casa comercial y variedad, sin tablas ni etapas nuevas
 * (los pedidos siguen en `registros`, módulo 'pedidos', con sus estados Cotizado → Confirmado → Entregado / Cancelado).
 *
 * - Vendedor ejecutor: cada pedido y cada cotización llevan `vendedor` (el correo de quien vende). Lo pone el
 *   servidor al crearlos y ya no cambia. Un vendedor solo ve y toca los suyos (permisos.js); administración, los de
 *   su país y casa (aprueba las cotizaciones); el Master, todos.
 * - Confirmar: un pedido Confirmado o Entregado (los que cuentan como venta en las metas) necesita miles de
 *   semillas y precio por mil en US$ mayores que 0. Se comprueba al pasar a ese estado o al cambiar esas cifras.
 * - Recompra: al confirmarse (o entregarse) se encola PEDIDO_RECOMPRA (flujos.js) para la próxima temporada: a los
 *   `recompraDias` de la fecha del pedido (90 si no se indica) se abre un pedido Cotizado para el mismo cliente,
 *   casa, variedad y vendedor, y se le avisa en su campana.
 */
import crypto from 'node:crypto';

export const ESTADOS_PEDIDO = ['Cotizado', 'Confirmado', 'Entregado', 'Cancelado'];
/** Estados que cuentan como venta (metas) y que exigen cantidad y precio */
export const ESTADOS_VENTA = ['Confirmado', 'Entregado'];
export const DIAS_RECOMPRA = 90;
export const MAX_DIAS_RECOMPRA = 730;
/** Módulos privados del vendedor que los ejecuta */
export const MODULOS_DEL_VENDEDOR = ['pedidos', 'cotizaciones'];

/** @param {unknown} t */
export const correo = (t) => String(t || '').trim().toLowerCase();
const correoValido = (/** @type {string} */ t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) && t.length <= 190;

/**
 * Correo del vendedor que ejecuta un pedido o una cotización. Los registros de antes de la fase 2 no traen
 * `vendedor`: en un pedido cuenta el vendedor asignado al cliente (como contaban ya las metas) y si no, quien lo creó.
 * @param {Record<string, any>} registro
 * @param {Record<string, any> | null} [cliente]  la ficha del cliente (solo para pedidos de antes)
 */
export function ejecutorDe(registro, cliente = null) {
    return correo(registro.vendedor) || correo(cliente && cliente.asignado) || correo(registro.creadoPor) || correo(registro.cuenta);
}

/**
 * Pone el vendedor ejecutor de un pedido o una cotización que se guarda: el de antes si ya existía (no cambia);
 * si es nuevo, quien lo registra, salvo que administración o el Master lo registren a nombre de un vendedor.
 * @param {{ master?: boolean, cargo: string | null }} ambito
 * @param {{ email: string }} usuario
 * @param {Record<string, any>} registro
 * @param {Record<string, any> | null} anterior
 * @returns {Record<string, any>}
 */
export function conVendedor(ambito, usuario, registro, anterior) {
    if (anterior) return { ...registro, vendedor: ejecutorDe(anterior) || correo(usuario.email) };
    const aNombreDe = correo(registro.vendedor);
    const delegado = (ambito.master || ambito.cargo === 'administrativo') && correoValido(aNombreDe);
    return { ...registro, vendedor: delegado ? aNombreDe : correo(usuario.email) };
}

/** @param {unknown} v */
const cifra = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Reglas del pedido al guardarlo: vendedor ejecutor, temporada y días de recompra limpios, y cantidad y precio
 * obligatorios para confirmarlo. Lanza un error 400 si falta alguno.
 * @param {{ master?: boolean, cargo: string | null }} ambito
 * @param {{ email: string }} usuario
 * @param {Record<string, any>} registro
 * @param {Record<string, any> | null} anterior
 */
export function ajustarPedido(ambito, usuario, registro, anterior) {
    const r = conVendedor(ambito, usuario, registro, anterior);
    const temporada = String(r.temporada ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    if (temporada) r.temporada = temporada; else delete r.temporada;
    const dias = Math.trunc(cifra(r.recompraDias));
    if (dias >= 1 && dias <= MAX_DIAS_RECOMPRA) r.recompraDias = dias; else delete r.recompraDias;

    if (ESTADOS_VENTA.includes(r.estado)) {
        const pasaAVenta = !anterior || !ESTADOS_VENTA.includes(anterior.estado);
        const cambianCifras = anterior !== null && (cifra(anterior.semillasMiles) !== cifra(r.semillasMiles) || cifra(anterior.precioMil) !== cifra(r.precioMil));
        if (pasaAVenta || cambianCifras) {
            const faltan = [];
            if (!(cifra(r.semillasMiles) > 0)) faltan.push('las semillas (miles)');
            if (!(cifra(r.precioMil) > 0)) faltan.push('el precio por mil en US$');
            if (faltan.length) {
                throw Object.assign(new Error(`Para dejar el pedido ${r.estado} escribe ${faltan.join(' y ')}, mayor que 0.`), { estado: 400, codigo: 'datos' });
            }
        }
    }
    return r;
}

/** Total del pedido en US$ (miles de semillas × precio por mil), con dos decimales */
export const totalUsd = (/** @type {Record<string, any>} */ p) => Math.round(cifra(p.semillasMiles) * cifra(p.precioMil) * 100) / 100;

/** @param {string} fecha  AAAA-MM-DD @param {number} dias */
const sumarDiasA = (fecha, dias) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);

/**
 * Regla del motor de eventos (flujos.js › REGLAS): el pedido pasa a Confirmado o Entregado → recompra de la
 * próxima temporada, una sola vez por pedido (clave), con espera hasta la fecha del pedido + recompraDias.
 * @type {import('./eventos.js').Regla}
 */
export const REGLA_RECOMPRA = {
    nombre: 'Pedido confirmado o entregado: recompra en la próxima temporada',
    modulo: 'pedidos',
    cuando: (registro, anterior) => ESTADOS_VENTA.includes(registro.estado) && (!anterior || !ESTADOS_VENTA.includes(anterior.estado)),
    evento: (registro, anterior, { usuario, hoy }) => {
        const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(registro.fecha || '')) ? String(registro.fecha) : hoy;
        const cuando = sumarDiasA(desde, Number(registro.recompraDias) || DIAS_RECOMPRA);
        return {
            tipo: 'PEDIDO_RECOMPRA',
            clave: `recompra:${String(registro.id).slice(0, 150)}`,
            usuarioId: usuario.id,
            carga: { pedidoId: String(registro.id), cuando },
            retrasoS: Math.max(0, (Date.parse(`${cuando}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 1000)
        };
    }
};

/** Id del pedido de recompra: siempre el mismo para un pedido de origen (reintentar no lo duplica) */
export const idRecompra = (/** @type {string} */ origenId) => `recompra-${crypto.createHash('sha256').update(String(origenId)).digest('hex').slice(0, 20)}`;

/**
 * El pedido Cotizado de la nueva temporada: mismo cliente, país, casa, variedad y vendedor; las semillas del
 * anterior como punto de partida; el precio, por confirmar.
 * @param {Record<string, any>} origen
 * @param {string} hoy  AAAA-MM-DD en la zona del equipo
 */
export function pedidoDeRecompra(origen, hoy) {
    const vendedor = ejecutorDe(origen);
    const antes = origen.temporada ? `la temporada ${origen.temporada}` : `el pedido del ${origen.fecha || 'anterior'}`;
    /** @type {Record<string, any>} */
    const nuevo = {
        id: idRecompra(origen.id),
        clienteId: origen.clienteId,
        pais: origen.pais,
        casa: origen.casa,
        fecha: hoy,
        variedad: origen.variedad,
        estado: 'Cotizado',
        notas: `Recompra de ${antes}: confirma con el cliente la cantidad y el precio de la nueva temporada.`,
        recompraDe: String(origen.id),
        vendedor,
        responsable: 'Recompra automática',
        creadoPor: vendedor,
        cuenta: vendedor
    };
    ['cliente', 'recompraDias'].forEach(c => { if (origen[c] !== undefined) nuevo[c] = origen[c]; });
    if (cifra(origen.semillasMiles) > 0) nuevo.semillasMiles = cifra(origen.semillasMiles);
    return nuevo;
}

/**
 * Pone `vendedor` a los pedidos y cotizaciones de antes de la fase 2 (una vez, al arrancar; no toca los que ya
 * lo tienen): así la privacidad por vendedor y las metas valen igual para los registros antiguos.
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @returns {Promise<number>} cuántos registros se completaron
 */
export async function asignarEjecutores(pool) {
    const [filas] = await pool.query("SELECT modulo, id, datos FROM registros WHERE modulo IN ('pedidos', 'cotizaciones', 'clientes')");
    /** @type {Map<string, Record<string, any>>} */
    const clientes = new Map();
    /** @type {{ modulo: string, id: string, datos: Record<string, any> }[]} */
    const pendientes = [];
    for (const fila of filas) {
        let datos;
        try { datos = JSON.parse(fila.datos); } catch (e) { continue; }
        if (fila.modulo === 'clientes') clientes.set(String(datos.id), datos);
        else if (!correo(datos.vendedor)) pendientes.push({ modulo: fila.modulo, id: fila.id, datos });
    }
    let n = 0;
    for (const { modulo, id, datos } of pendientes) {
        const vendedor = ejecutorDe(datos, modulo === 'pedidos' ? clientes.get(String(datos.clienteId)) : null);
        if (!vendedor) continue;
        await pool.query('UPDATE registros SET datos = ? WHERE modulo = ? AND id = ?', [JSON.stringify({ ...datos, vendedor }), modulo, id]);
        n++;
    }
    return n;
}
