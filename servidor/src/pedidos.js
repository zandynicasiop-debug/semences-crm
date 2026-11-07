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
    // Cuándo se creó (el reporte del viernes cuenta lo de la semana): el de antes, o el de ahora si no viene
    const creado = (anterior && anterior.creado) || registro.creado || new Date().toISOString();
    if (anterior) return { ...registro, creado, vendedor: ejecutorDe(anterior) || correo(usuario.email) };
    const aNombreDe = correo(registro.vendedor);
    const delegado = (ambito.master || ambito.cargo === 'administrativo') && correoValido(aNombreDe);
    return { ...registro, creado, vendedor: delegado ? aNombreDe : correo(usuario.email) };
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
    // Plantulación (campo.js): casilla, bandeja, cultivo y fecha de entrega de las plántulas
    r.conPlantulacion = [true, 'true', 'on', 'si', 'sí', 1, '1'].includes(r.conPlantulacion);
    if (!r.conPlantulacion) delete r.conPlantulacion;
    const alveolos = Math.trunc(cifra(r.alveolos));
    if (r.conPlantulacion && alveolos >= 10 && alveolos <= 1000) r.alveolos = alveolos; else delete r.alveolos;
    const cultivo = String(r.cultivo ?? '').replace(/[\r\n<>]+/g, ' ').trim().slice(0, 40);
    if (r.conPlantulacion && cultivo) r.cultivo = cultivo; else delete r.cultivo;
    if (!(r.conPlantulacion && /^\d{4}-\d{2}-\d{2}$/.test(String(r.entregaPlantulas || '')))) delete r.entregaPlantulas;

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
        // Cuándo se confirmó (el reporte semanal cuenta los confirmados de la semana): se pone al pasar a venta
        if (pasaAVenta) r.confirmado = new Date().toISOString();
        else if (anterior && anterior.confirmado) r.confirmado = anterior.confirmado;
    } else {
        delete r.confirmado;
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

const formatoUsd = (/** @type {number} */ n) => `US$ ${Math.round(n).toLocaleString('es-DO')}`;

/**
 * #11 Prioridades en US$ de una persona para el resumen de las 7:00: sus cotizaciones abiertas en US$ (Pendientes o
 * Aprobadas) y sus pedidos Cotizados, de mayor a menor importe; las recompras ya abiertas sin precio se estiman con el
 * precio del pedido anterior (≈). Como mucho `max` líneas. datos: lo que la persona ve (ya filtrado).
 * @param {{ pedidos?: any[], cotizaciones?: any[], clientes?: any[] }} datos
 * @param {string} email
 * @param {string} hoy
 * @param {number} [max]
 */
export function prioridadesUsd(datos, email, hoy, max = 5) {
    const yo = correo(email);
    const pedidos = datos.pedidos || [];
    const porId = new Map(pedidos.map(p => [String(p.id), p]));
    const fichas = new Map((datos.clientes || []).map(c => [String(c.id), c]));
    const nombre = (/** @type {any} */ r) => (fichas.get(String(r.clienteId)) || {}).nombre || r.cliente || 'cliente';
    /** @type {{ usd: number, aprox: boolean, sinPrecio: boolean, texto: string }[]} */
    const items = [];
    for (const c of datos.cotizaciones || []) {
        const estado = c.estado || 'Pendiente';
        if (ejecutorDe(c) !== yo || !['Pendiente', 'Aprobada'].includes(estado) || (c.moneda || 'US$') !== 'US$' || !(cifra(c.total) > 0)) continue;
        items.push({ usd: cifra(c.total), aprox: false, sinPrecio: false, texto: `Cotización ${c.numero || ''} · ${nombre(c)} (${estado === 'Aprobada' ? 'aprobada: ciérrala con el cliente' : 'por aprobar'})`.replace(/\s+/g, ' ') });
    }
    for (const p of pedidos) {
        if (p.estado !== 'Cotizado' || ejecutorDe(p, fichas.get(String(p.clienteId)) || null) !== yo) continue;
        const recompra = Boolean(p.recompraDe) && String(p.fecha || '') <= hoy;
        let usd = totalUsd(p), aprox = false;
        const origen = p.recompraDe ? porId.get(String(p.recompraDe)) : null;
        if (!(usd > 0) && origen && cifra(origen.precioMil) > 0) { usd = Math.round(cifra(p.semillasMiles) * cifra(origen.precioMil) * 100) / 100; aprox = true; }
        if (!(usd > 0) && !recompra) continue;
        items.push({ usd, aprox, sinPrecio: !(usd > 0), texto: `${recompra ? 'Recompra vencida' : 'Pedido cotizado'} · ${nombre(p)} · ${p.casa || ''} · ${p.variedad || ''}${recompra && p.fecha ? ` (abierta el ${p.fecha})` : ''}` });
    }
    return items.sort((a, b) => b.usd - a.usd).slice(0, max)
        .map(i => `${i.sinPrecio ? 'Sin precio' : `${i.aprox ? '≈ ' : ''}${formatoUsd(i.usd)}`} · ${i.texto}`);
}

/**
 * #12 Lo que la persona hizo en el CRM esa semana, para el reporte del viernes (ya con estado y comentario):
 * visitas que registró, cotizaciones que preparó y pedidos suyos confirmados. Ids `auto:…` (no son tareas).
 * @param {{ visitas?: any[], cotizaciones?: any[], pedidos?: any[], clientes?: any[] }} datos  todo el CRM
 * @param {string} email
 * @param {{ lunes: string, domingo: string }} semana
 * @param {(iso: string) => string} fechaLocal  instante ISO → AAAA-MM-DD en la zona del equipo
 */
export function actividadesDelCrm(datos, email, { lunes, domingo }, fechaLocal) {
    const yo = correo(email);
    const enSemana = (/** @type {unknown} */ f) => typeof f === 'string' && f >= lunes && f <= domingo;
    const fichas = new Map((datos.clientes || []).map(c => [String(c.id), c]));
    const nombre = (/** @type {any} */ r) => (fichas.get(String(r.clienteId)) || {}).nombre || r.cliente || 'cliente';
    const dia = (/** @type {any} */ iso) => (iso && !Number.isNaN(Date.parse(iso)) ? fechaLocal(String(iso)) : '');
    /** @type {{ id: string, titulo: string, estado: string, comentario: string, auto: true }[]} */
    const lista = [];
    for (const v of datos.visitas || []) {
        if (correo(v.creadoPor || v.cuenta) !== yo || !enSemana(v.fecha)) continue;
        lista.push({ id: `auto:visita:${v.id}`, titulo: `Visita a ${nombre(v)} (${v.fecha})`, estado: 'Completada', auto: true,
            comentario: [v.estado && `Cultivo: ${v.estado}`, v.comentarios].filter(Boolean).join(' · ') || 'Visita registrada en el CRM.' });
    }
    for (const c of datos.cotizaciones || []) {
        if (ejecutorDe(c) !== yo || !enSemana(c.fecha || dia(c.creado))) continue;
        lista.push({ id: `auto:cotizacion:${c.id}`, titulo: `Cotización ${c.numero || ''} a ${nombre(c)}`.replace(/\s+/g, ' '), auto: true,
            estado: c.estado === 'Rechazada' ? 'Terminada sin éxito' : 'En progreso',
            comentario: `${c.moneda || 'US$'} ${cifra(c.total).toLocaleString('es-DO')} · ${c.estado || 'Pendiente'}${c.motivo ? ` (${c.motivo})` : ''}.` });
    }
    for (const p of datos.pedidos || []) {
        if (!ESTADOS_VENTA.includes(p.estado) || ejecutorDe(p, fichas.get(String(p.clienteId)) || null) !== yo || !enSemana(dia(p.confirmado) || p.fecha)) continue;
        lista.push({ id: `auto:pedido:${p.id}`, titulo: `Pedido confirmado: ${nombre(p)} · ${p.casa || ''} · ${p.variedad || ''}`, estado: 'Completada', auto: true,
            comentario: `${cifra(p.semillasMiles).toLocaleString('es-DO')} mil semillas · ${formatoUsd(totalUsd(p))}${p.temporada ? ` · temporada ${p.temporada}` : ''}.` });
    }
    return lista;
}
