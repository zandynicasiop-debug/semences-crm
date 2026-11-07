/**
 * Quién ve qué: estado (sala de espera), cargo, países y casas comerciales de cada persona.
 *
 * - Toda cuenta nueva entra en la sala de espera ('pendiente') hasta que un Master la aprueba y le
 *   asigna cargo, países y casas. Los Master son los correos de ADMINS: entran siempre, con todo.
 * - El cargo decide los módulos (MODULOS_POR_CARGO). El país y la casa comercial de cada registro
 *   deciden si se ve: el registro tiene que ser de un país Y una casa de la persona.
 * - Todo se comprueba en el servidor: lo que no se puede ver no sale de la base, y lo que no se puede
 *   escribir se rechaza, aunque alguien modifique la app.
 * - Fase 2 (pedidos.js): la ficha básica de un cliente (nombre, contacto, ubicación) la ve el equipo de su país
 *   aunque sea de otra casa, para no registrarlo dos veces; los pedidos y las cotizaciones (cantidades y precios)
 *   solo los ve y toca el vendedor que los ejecuta, administración de su país y casa, y el Master.
 */
import { ejecutorDe, correo, MODULOS_DEL_VENDEDOR } from './pedidos.js';

const esAdmin = (config, email) => config.google.admins.includes(String(email).toLowerCase());

export const PAISES = ['RD', 'VE'];
export const NOMBRE_PAIS = { RD: 'República Dominicana', VE: 'Venezuela' };
export const CASAS = ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó'];
export const CARGOS = ['vendedor', 'tecnico', 'plantulador', 'administrativo', 'master'];

// Módulos con país y casa comercial (los demás son de todo el equipo: tareas, chat, fichas del mapa)
export const MODULOS_CON_AMBITO = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', 'cotizaciones'];

// Reuniones del equipo: las ve y completa (acta) todo el equipo, como las tareas
const COMUNES = ['tareas', 'mensajes', 'sitios', 'reuniones'];
export const MODULOS_POR_CARGO = {
    // Pedidos: los registra el vendedor (y administración); de ahí salen las ventas de las metas.
    // Cotizaciones: las prepara el vendedor y las aprueba administración (reglaCotizacion)
    vendedor: ['clientes', 'visitas', 'pedidos', 'cotizaciones', ...COMUNES],
    tecnico: ['agronomia', 'rendimiento', 'visitas', 'germinador', ...COMUNES],
    // Plantulador: el germinador (lotes en cámara y bandejas) de sus países y casas
    plantulador: ['germinador', ...COMUNES],
    // Envíos (guías de DHL y FedEx): solo administración los registra
    administrativo: ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', 'cotizaciones', ...COMUNES],
    master: ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', 'cotizaciones', ...COMUNES]
};

// Módulos que un cargo puede ver pero no escribir: el vendedor y el plantulador siguen los envíos
export const LECTURA_POR_CARGO = {
    vendedor: ['envios'],
    plantulador: ['envios']
};

// El técnico y el plantulador no gestionan clientes, pero necesitan sus nombres para sus registros
const CLIENTES_SOLO_NOMBRE = ['tecnico', 'plantulador'];
const CAMPOS_NOMBRE_CLIENTE = ['id', 'nombre', 'pais', 'casa', 'ubicacion'];
// Ficha compartida: lo que ve del cliente de otra casa el equipo del mismo país. Sin casa, marca que compra, etapa,
// asignado ni notas: eso es información comercial de la otra casa
const CAMPOS_FICHA_BASICA = ['id', 'nombre', 'pais', 'telefono', 'whatsapp', 'correo', 'ubicacion'];

const lista = (texto) => { try { const v = JSON.parse(texto || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

/**
 * Ámbito de la persona: { estado, cargo, master, paises, casas, modulos (lee y escribe), lectura (solo lee) }.
 * Un Master (ADMINS) tiene siempre todo, aunque la base diga otra cosa.
 */
export function ambitoDe(usuario, config) {
    if (esAdmin(config, usuario.email)) {
        return { estado: 'aprobado', cargo: 'master', master: true, email: correo(usuario.email), paises: [...PAISES], casas: [...CASAS], modulos: MODULOS_POR_CARGO.master, lectura: [] };
    }
    const estado = usuario.estado || 'pendiente';
    const cargo = CARGOS.includes(usuario.cargo) && usuario.cargo !== 'master' ? usuario.cargo : null;
    if (estado !== 'aprobado' || !cargo) return { estado: estado === 'aprobado' ? 'pendiente' : estado, cargo: null, master: false, email: correo(usuario.email), paises: [], casas: [], modulos: [], lectura: [] };
    return {
        estado, cargo, master: false, email: correo(usuario.email),
        paises: lista(usuario.paises).filter(p => PAISES.includes(p)),
        casas: lista(usuario.casas).filter(c => CASAS.includes(c)),
        modulos: MODULOS_POR_CARGO[cargo],
        lectura: LECTURA_POR_CARGO[cargo] || []
    };
}

const todoElAmbito = (a) => a.master || (PAISES.every(p => a.paises.includes(p)) && CASAS.every(c => a.casas.includes(c)));

// ¿Entra este registro en el ámbito? Lo que no tiene país o casa (registros de antes) solo lo ve quien lo ve todo
export function dentroDelAmbito(ambito, modulo, registro) {
    if (!MODULOS_CON_AMBITO.includes(modulo)) return true;
    if (!registro.pais || !registro.casa) return todoElAmbito(ambito);
    return ambito.paises.includes(registro.pais) && ambito.casas.includes(registro.casa);
}

export function puedeLeer(ambito, modulo) {
    return ambito.modulos.includes(modulo) || (ambito.lectura || []).includes(modulo) || (modulo === 'clientes' && CLIENTES_SOLO_NOMBRE.includes(ambito.cargo));
}

// Pedidos y cotizaciones: los de cualquier vendedor (de su país y casa) solo los ven administración y el Master
export const veVentasDelEquipo = (ambito) => Boolean(ambito.master || ambito.cargo === 'administrativo');

/**
 * ¿Es de esta persona el pedido o la cotización? cliente: la ficha, para los pedidos de antes de la fase 2.
 * Lo que llega de la app sin vendedor ni autor (uno nuevo) es de quien lo guarda: el servidor se lo pone (pedidos.js).
 */
export function delVendedor(ambito, modulo, registro, cliente = null) {
    if (!MODULOS_DEL_VENDEDOR.includes(modulo) || veVentasDelEquipo(ambito)) return true;
    const ejecutor = ejecutorDe(registro, cliente);
    return Boolean(ambito.email) && ejecutor === ambito.email;
}

// operacion: 'guardar' o 'eliminar' (una cotización aprobada solo la borra administración)
export function puedeEscribir(ambito, modulo, registro, operacion = 'guardar') {
    if (!ambito.modulos.includes(modulo) || !dentroDelAmbito(ambito, modulo, registro)) return false;
    // Un vendedor no puede tocar (ni guardar a nombre de otro) los pedidos y cotizaciones de otro vendedor
    if (MODULOS_DEL_VENDEDOR.includes(modulo) && !veVentasDelEquipo(ambito)) {
        const nuevo = !registro.vendedor && !registro.creadoPor && !registro.cuenta;
        if (!nuevo && !delVendedor(ambito, modulo, registro)) return false;
    }
    if (modulo === 'cotizaciones' && operacion === 'eliminar' && registro.estado === 'Aprobada') return apruebaCotizaciones(ambito);
    return true;
}

/**
 * Cotizaciones: líneas libres (producto, cantidad, unidad y precio, sin lista de precios) que aprueba
 * administración. Solo un administrativo o un Master las aprueba o rechaza; si otro las cambia, vuelven a
 * 'Pendiente'. El total y quién la revisó los pone siempre el servidor, no la app.
 */
export const ESTADOS_COTIZACION = ['Pendiente', 'Aprobada', 'Rechazada'];
export const MONEDAS_COTIZACION = ['US$', 'RD$', 'Bs'];
export const apruebaCotizaciones = (ambito) => ambito.master || ambito.cargo === 'administrativo';

const texto = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const importe = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };

// Lo que decide el precio: si cambia, la cotización tiene que volver a aprobarse
const CAMPOS_COTIZACION = ['clienteId', 'cliente', 'pais', 'casa', 'moneda', 'lineas', 'condiciones', 'validez'];
const mismoContenido = (a, b) => CAMPOS_COTIZACION.every(c => JSON.stringify(a[c] ?? '') === JSON.stringify(b[c] ?? ''));

export function ajustarCotizacion(ambito, usuario, registro, anterior) {
    const lineas = (Array.isArray(registro.lineas) ? registro.lineas : []).slice(0, 100).map(l => ({
        producto: texto(l && l.producto, 200),
        cantidad: importe(l && l.cantidad),
        unidad: texto(l && l.unidad, 40),
        precio: importe(l && l.precio)
    })).filter(l => l.producto && l.cantidad > 0);
    const r = {
        ...registro,
        lineas,
        moneda: MONEDAS_COTIZACION.includes(registro.moneda) ? registro.moneda : MONEDAS_COTIZACION[0],
        total: Math.round(lineas.reduce((t, l) => t + l.cantidad * l.precio, 0) * 100) / 100
    };
    const sinCambios = anterior && mismoContenido(r, anterior);
    const revision = ['estado', 'revisadoPor', 'revisadoEn', 'motivo'];
    if (!apruebaCotizaciones(ambito) || !ESTADOS_COTIZACION.includes(r.estado)) {
        // Quien no aprueba solo la envía a aprobación; si la reenvía sin cambios, se queda como estaba
        if (sinCambios) revision.forEach(c => { if (anterior[c] !== undefined) r[c] = anterior[c]; else delete r[c]; });
        else r.estado = 'Pendiente';
    }
    if (r.estado === 'Pendiente') {
        ['revisadoPor', 'revisadoEn', 'motivo'].forEach(c => delete r[c]);
    } else if (sinCambios && anterior.estado === r.estado && anterior.revisadoEn) {
        r.revisadoPor = anterior.revisadoPor;
        r.revisadoEn = anterior.revisadoEn;
    } else {
        r.revisadoPor = usuario.nombre || usuario.email;
        r.revisadoEn = new Date().toISOString();
    }
    if (r.estado !== 'Rechazada') delete r.motivo;
    else r.motivo = texto(r.motivo, 500);
    return r;
}

const solo = (r, campos) => Object.fromEntries(campos.filter(c => r[c] !== undefined).map(c => [c, r[c]]));

// Los datos que puede ver la persona, por módulo (los demás módulos ni aparecen)
export function filtrarDatos(datos, ambito) {
    const salida = {};
    const fichas = new Map((datos.clientes || []).map(c => [String(c.id), c]));
    for (const [modulo, registros] of Object.entries(datos)) {
        if (!puedeLeer(ambito, modulo)) continue;
        let visibles;
        if (modulo === 'clientes' && ambito.modulos.includes('clientes')) {
            // Los de su casa, completos; los de otra casa de su país, solo la ficha básica (marcada como compartida)
            visibles = registros.flatMap(r => {
                if (dentroDelAmbito(ambito, modulo, r)) return [r];
                if (r.pais && ambito.paises.includes(r.pais)) return [{ ...solo(r, CAMPOS_FICHA_BASICA), compartida: true }];
                return [];
            });
        } else {
            visibles = registros.filter(r => dentroDelAmbito(ambito, modulo, r) && delVendedor(ambito, modulo, r, fichas.get(String(r.clienteId)) || null));
            if (modulo === 'clientes') visibles = visibles.map(r => solo(r, CAMPOS_NOMBRE_CLIENTE));
        }
        salida[modulo] = visibles;
    }
    return salida;
}

// Comprueba lo que asigna un Master: cargo válido y al menos un país y una casa conocidos
export function asignacionValida({ cargo, paises, casas }) {
    const p = [...new Set([].concat(paises || []))].filter(x => PAISES.includes(x));
    const c = [...new Set([].concat(casas || []))].filter(x => CASAS.includes(x));
    if (!CARGOS.includes(cargo) || cargo === 'master') return null;
    if (!p.length || !c.length) return null;
    return { cargo, paises: p, casas: c };
}
