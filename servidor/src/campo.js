// @ts-check
/**
 * Lote A: del pedido al campo sin pasos a mano.
 *
 * - Parámetros agronómicos (tabla `ajustes`, clave 'agronomia'): alvéolos por bandeja, % de siembra extra, y días de
 *   vivero y densidad (plantas/ha) por cultivo. Los valores por defecto están aquí; el Master y el equipo técnico los
 *   cambian desde la app (acción "ajustes") sin tocar código.
 * - #2 Pedido con plantulación → al confirmarse, lote Programado en el germinador (bandejas y fechas) y la siembra en
 *   la agenda del plantulador (tarea con fecha: sale en la agenda del CRM y en su Google Calendar).
 * - #3 Envío Entregado (rastreo de DHL/FedEx o a mano) → visita técnica de seguimiento a los 7 días.
 * - #5 Clientes dormidos: pasado el ciclo de recompra del último pedido confirmado de una casa sin cotización ni
 *   pedido nuevo (la recompra automática sin trabajar no cuenta), aviso al vendedor que lo ejecutó.
 *
 * Cuentas de la siembra: el % extra se aplica una sola vez, al pasar de plantas a semillas (siembra = plantas × (1 +
 * extra)). Un pedido de N miles de semillas se siembra entero: bandejas = semillas / alvéolos (hacia arriba) y se
 * esperan semillas / (1 + extra) plantas. La calculadora de la app usa la misma regla.
 */
import crypto from 'node:crypto';
import * as db from './db.js';
import { registrarAviso } from './campana.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { emitirEvento } from './eventos.js';
import { ambitoDe, dentroDelAmbito } from './permisos.js';
import { ESTADOS_VENTA, DIAS_RECOMPRA, ejecutorDe, correo } from './pedidos.js';
import { enZona, sumarDias } from './fechas.js';
import { auditar } from './auditoria.js';
import { leerMensajes, renderizar } from './mensajes.js';

export const ESQUEMA_AJUSTES = [
    `CREATE TABLE IF NOT EXISTS ajustes (
        clave VARCHAR(50) NOT NULL PRIMARY KEY,
        valor MEDIUMTEXT NOT NULL,
        actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actualizado_por VARCHAR(190) NOT NULL DEFAULT ''
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

/** Superficie: la tarea dominicana oficial (628,86 m²) en RD; la hectárea en Venezuela */
export const SUPERFICIE = { RD: { unidad: 'tareas', m2: 628.86 }, VE: { unidad: 'hectáreas', m2: 10000 } };

/**
 * @typedef {{ vivero: number | null, densidad: number | null }} Cultivo
 * @typedef {{ alveolos: number[], alveolosPorDefecto: number, extraPct: number, cultivos: Record<string, Cultivo> }} Agronomia
 */

/** @type {Agronomia} */
export const AGRONOMIA_POR_DEFECTO = {
    alveolos: [128, 162, 200],
    alveolosPorDefecto: 128,
    extraPct: 10,
    cultivos: {
        Tomate: { vivero: 28, densidad: 25000 },
        Pimiento: { vivero: 40, densidad: 30000 },
        'Ají': { vivero: 35, densidad: 30000 },
        Cebolla: { vivero: 35, densidad: 250000 },
        'Melón': { vivero: 18, densidad: 12000 },
        'Sandía': { vivero: 18, densidad: 5000 },
        Pepino: { vivero: 18, densidad: 22000 },
        'Calabacín': { vivero: 18, densidad: 10000 }
    }
};

/** Días de gracia tras abrirse la recompra antes de dar al cliente por dormido (si nadie la trabajó) */
export const GRACIA_DORMIDO = 14;
/** Visita técnica de seguimiento: días después de la entrega */
export const DIAS_VISITA = 7;

const entero = (/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * Comprueba y limpia los parámetros que manda la app. Devuelve { agronomia } o { error } con el motivo.
 * @param {any} entrada
 * @returns {{ agronomia: Agronomia } | { error: string }}
 */
export function validarAgronomia(entrada) {
    if (!entrada || typeof entrada !== 'object') return { error: 'Faltan los parámetros' };
    /** @type {number[]} */
    const alveolos = [];
    for (const valor of Array.isArray(entrada.alveolos) ? entrada.alveolos : []) {
        const n = entero(valor, 10, 1000);
        if (n !== null && !alveolos.includes(n)) alveolos.push(n);
    }
    alveolos.sort((x, y) => x - y).splice(8);
    if (!alveolos.length) return { error: 'Indica al menos un tamaño de bandeja (alvéolos entre 10 y 1000)' };
    const alveolosPorDefecto = entero(entrada.alveolosPorDefecto, 10, 1000);
    if (alveolosPorDefecto === null || !alveolos.includes(alveolosPorDefecto)) return { error: 'La bandeja por defecto tiene que estar en la lista' };
    const extraPct = Number(entrada.extraPct);
    if (!Number.isFinite(extraPct) || extraPct < 0 || extraPct > 100) return { error: 'El % de siembra extra va de 0 a 100' };
    const lista = entrada.cultivos && typeof entrada.cultivos === 'object' ? Object.entries(entrada.cultivos) : [];
    if (!lista.length || lista.length > 40) return { error: 'Indica entre 1 y 40 cultivos' };
    /** @type {Record<string, Cultivo>} */
    const cultivos = {};
    for (const [nombreBruto, valores] of lista) {
        const nombre = String(nombreBruto).replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!nombre || /[<>]/.test(nombre)) return { error: 'Nombre de cultivo no válido' };
        const v = valores && typeof valores === 'object' ? /** @type {any} */ (valores) : {};
        const vivero = v.vivero === null || v.vivero === '' || v.vivero === undefined ? null : entero(v.vivero, 1, 180);
        const densidad = v.densidad === null || v.densidad === '' || v.densidad === undefined ? null : entero(v.densidad, 1, 2000000);
        if ((v.vivero !== null && v.vivero !== '' && v.vivero !== undefined && vivero === null)) return { error: `Días de vivero de ${nombre}: un número entero de 1 a 180` };
        if ((v.densidad !== null && v.densidad !== '' && v.densidad !== undefined && densidad === null)) return { error: `Densidad de ${nombre}: plantas por hectárea, un número entero` };
        cultivos[nombre] = { vivero, densidad };
    }
    return { agronomia: { alveolos, alveolosPorDefecto, extraPct: Math.round(extraPct * 100) / 100, cultivos } };
}

/**
 * Parámetros vigentes: los guardados (si son válidos) o los de por defecto.
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @returns {Promise<Agronomia>}
 */
export async function leerAgronomia(pool) {
    const [filas] = await pool.query("SELECT valor FROM ajustes WHERE clave = 'agronomia'");
    if (!filas.length) return AGRONOMIA_POR_DEFECTO;
    try {
        const r = validarAgronomia(JSON.parse(filas[0].valor));
        return 'agronomia' in r ? r.agronomia : AGRONOMIA_POR_DEFECTO;
    } catch (e) {
        return AGRONOMIA_POR_DEFECTO;
    }
}

/**
 * Acción "ajustes": leer (cualquiera del equipo aprobado) o guardar (Master y técnicos) los parámetros agronómicos.
 * @param {any} datos
 * @param {any} contexto
 * @param {{ errorApp: (mensaje: string, estado?: number, codigo?: string) => Error }} herramientas
 */
export async function accionAjustes(datos, contexto, { errorApp }) {
    const { pool, config, usuario, ambito, red } = contexto;
    const op = datos.operacion || 'leer';
    const puedeEditar = Boolean(ambito.master || ambito.cargo === 'tecnico');
    if (op === 'guardar') {
        if (!puedeEditar) throw errorApp('Los parámetros agronómicos los cambian el Master y el equipo técnico', 403, 'acceso');
        const r = validarAgronomia(datos.agronomia);
        if ('error' in r) throw errorApp(r.error);
        const antes = await leerAgronomia(pool);
        await pool.query(
            `INSERT INTO ajustes (clave, valor, actualizado, actualizado_por) VALUES ('agronomia', ?, UTC_TIMESTAMP(), ?)
             ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = UTC_TIMESTAMP(), actualizado_por = VALUES(actualizado_por)`,
            [JSON.stringify(r.agronomia), usuario.email]);
        await auditar(pool, config, { usuario, accion: 'modificar', modulo: 'ajustes', objeto: 'agronomia', resumen: 'Parámetros agronómicos', cambios: { antes, despues: r.agronomia }, red });
    } else if (op !== 'leer') {
        throw errorApp('Operación desconocida de ajustes');
    }
    return { ok: true, agronomia: await leerAgronomia(pool), superficie: SUPERFICIE, puedeEditar };
}

/** Cultivo del pedido: el elegido, o el que nombra la variedad ("Tomate Hexagon" → Tomate) */
export function cultivoDe(/** @type {Record<string, any>} */ pedido, /** @type {Agronomia} */ agro) {
    const nombres = Object.keys(agro.cultivos);
    const normal = (/** @type {unknown} */ t) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const elegido = nombres.find(n => normal(n) === normal(pedido.cultivo));
    if (elegido) return elegido;
    const variedad = normal(pedido.variedad);
    return nombres.find(n => new RegExp(`\\b${normal(n)}\\b`).test(variedad)) || '';
}

/**
 * Plan de siembra de un pedido con plantulación. hoy: AAAA-MM-DD local.
 * Con fecha de entrega de plántulas: siembra = entrega − días de vivero; sin ella, se siembra ya (o en la fecha del
 * pedido si es posterior) y la entrega es siembra + vivero. Si la siembra calculada ya pasó, se adelanta a hoy y se avisa.
 * @param {Record<string, any>} pedido
 * @param {Agronomia} agro
 * @param {string} hoy
 */
export function planDeSiembra(pedido, agro, hoy) {
    const semillas = Math.round((Number(pedido.semillasMiles) || 0) * 1000);
    const alveolos = entero(pedido.alveolos, 10, 1000) || agro.alveolosPorDefecto;
    const bandejas = Math.ceil(semillas / alveolos);
    const plantas = Math.floor(semillas / (1 + agro.extraPct / 100));
    const cultivo = cultivoDe(pedido, agro);
    const vivero = (cultivo && agro.cultivos[cultivo] && agro.cultivos[cultivo].vivero) || null;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.fecha || '')) && String(pedido.fecha) > hoy ? String(pedido.fecha) : hoy;
    const entrega = /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.entregaPlantulas || '')) ? String(pedido.entregaPlantulas) : '';
    let siembra = fecha, trasplante = vivero ? sumarDias(fecha, vivero) : '', atrasada = '';
    if (entrega && vivero) {
        const calculada = sumarDias(entrega, -vivero);
        if (calculada < hoy) {
            atrasada = calculada;
            siembra = hoy;
            trasplante = sumarDias(hoy, vivero);
        } else {
            siembra = calculada;
            trasplante = entrega;
        }
    } else if (entrega) {
        trasplante = entrega;
    }
    return { semillas, alveolos, bandejas, plantas, extraPct: agro.extraPct, cultivo, vivero, siembra, trasplante, atrasada };
}

/** @param {string} texto */
const huella = (texto) => crypto.createHash('sha256').update(texto).digest('hex').slice(0, 20);
export const idLoteDe = (/** @type {string} */ pedidoId) => `siembra-${huella(`lote|${pedidoId}`)}`;
export const idTareaSiembra = (/** @type {string} */ pedidoId) => `siembra-${huella(`tarea|${pedidoId}`)}`;
export const idVisita = (/** @type {string} */ envioId) => `visita-${huella(`envio|${envioId}`)}`;

/**
 * Personas aprobadas de un cargo cuyo país y casa incluyen los del registro (por nombre, para elegir siempre igual).
 * @param {any} pool @param {any} config @param {string} cargo @param {Record<string, any>} registro
 */
async function personasDe(pool, config, cargo, registro) {
    const [filas] = await pool.query("SELECT * FROM usuarios WHERE estado = 'aprobado' AND cargo = ? ORDER BY nombre, email", [cargo]);
    return filas.filter((/** @type {any} */ p) => dentroDelAmbito(ambitoDe(p, config), 'germinador', { pais: registro.pais, casa: registro.casa }));
}

/** Aviso en la campana y por push a varias personas */
async function avisar(/** @type {any} */ contexto, /** @type {number[]} */ ids, /** @type {string} */ tipo, /** @type {string} */ texto) {
    const destino = [...new Set(ids.filter(Boolean))];
    if (!destino.length) return;
    await registrarAviso(contexto.pool, destino, tipo, texto);
    if (contexto.avisos && contexto.avisos.pushActivo) {
        const { huellas } = await destinosDe(contexto.pool, destino);
        await encolar(contexto.pool, 'push', huellas, texto);
    }
}

const nombreCorto = (/** @type {any} */ p) => (p && (p.nombre || p.email)) || '';

// ----- #2 Pedido con plantulación -----

/**
 * Regla (flujos.js › REGLAS): pedido con plantulación que pasa a Confirmado o Entregado (o al que se le marca la
 * plantulación ya confirmado) → PEDIDO_PLANTULACION, una sola vez por pedido.
 * @type {import('./eventos.js').Regla}
 */
export const REGLA_PLANTULACION = {
    nombre: 'Pedido con plantulación confirmado: lote del germinador y siembra en la agenda',
    modulo: 'pedidos',
    cuando: (registro, anterior) => registro.conPlantulacion === true && ESTADOS_VENTA.includes(registro.estado)
        && (!anterior || !ESTADOS_VENTA.includes(anterior.estado) || anterior.conPlantulacion !== true),
    evento: (registro, anterior, { usuario }) => ({
        tipo: 'PEDIDO_PLANTULACION',
        clave: `plantulacion:${String(registro.id).slice(0, 150)}`,
        usuarioId: usuario.id,
        carga: { pedidoId: String(registro.id) }
    })
};

/** @type {import('./eventos.js').Manejador} */
export async function alPlantular(evento, { paso, contexto }) {
    const { pool, config } = contexto;
    const pedido = await db.leerRegistro(pool, 'pedidos', String(evento.carga.pedidoId || ''));
    if (!pedido || pedido.conPlantulacion !== true || !ESTADOS_VENTA.includes(pedido.estado)) return;
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    const agro = await leerAgronomia(pool);
    const plan = await paso('plan', async () => planDeSiembra(pedido, agro, hoy));
    const cliente = pedido.clienteId ? await db.leerRegistro(pool, 'clientes', String(pedido.clienteId)) : null;
    const nombreCliente = (cliente && cliente.nombre) || pedido.cliente || 'Cliente';
    const plantuladores = await personasDe(pool, config, 'plantulador', pedido);
    const encargado = plantuladores[0] || null;
    const loteId = idLoteDe(pedido.id);
    const codigo = `P-${plan.siembra.replace(/-/g, '').slice(2)}-${loteId.slice(-4).toUpperCase()}`;

    await paso('lote', async () => {
        if (await db.leerRegistro(pool, 'germinador', loteId)) return { id: loteId, creado: false };
        const comentarios = [
            `Desde el pedido de ${nombreCliente} del ${pedido.fecha || hoy}: ${plan.semillas.toLocaleString('es-DO')} semillas en ${plan.bandejas} bandejas de ${plan.alveolos} alvéolos;`
            + ` se esperan unas ${plan.plantas.toLocaleString('es-DO')} plantas (${plan.extraPct} % de siembra extra).`,
            plan.cultivo ? `${plan.cultivo}: ${plan.vivero ? `${plan.vivero} días de vivero` : 'sin días de vivero en los parámetros'}.` : 'Sin cultivo reconocido: revisa la fecha de trasplante.',
            plan.atrasada ? `⚠️ Para entregar a tiempo había que sembrar el ${plan.atrasada}: se programa para hoy.` : ''
        ].filter(Boolean).join(' ');
        const vendedor = ejecutorDe(pedido, cliente);
        await db.guardarRegistro(pool, 'germinador', {
            id: loteId, clienteId: pedido.clienteId, cliente: nombreCliente, pais: pedido.pais, casa: pedido.casa,
            lote: codigo, variedad: pedido.variedad, estado: 'Programado', siembra: plan.siembra, trasplante: plan.trasplante,
            bandejas: plan.bandejas, semillasMiles: Number(pedido.semillasMiles) || 0, alveolos: plan.alveolos, comentarios,
            pedidoId: String(pedido.id), responsable: 'Plantulación automática', creado: new Date().toISOString(),
            creadoPor: vendedor, cuenta: vendedor
        }, null, /** @type {any} */ ({ config, sistema: 'Plantulación automática' }));
        return { id: loteId, creado: true };
    });

    await paso('agenda', async () => {
        const id = idTareaSiembra(pedido.id);
        if (await db.leerRegistro(pool, 'tareas', id)) return { id };
        await db.guardarRegistro(pool, 'tareas', {
            id, titulo: `Sembrar lote ${codigo}: ${nombreCliente} · ${pedido.variedad || ''} · ${plan.bandejas} bandejas de ${plan.alveolos}`,
            prioridad: plan.atrasada ? 'Alta' : 'Media', vence: plan.siembra, para: nombreCorto(encargado),
            creadaPor: 'Plantulación automática', creada: new Date().toISOString(), hecha: '', hechaPor: '',
            loteId, pedidoId: String(pedido.id), clienteId: pedido.clienteId
        }, null, /** @type {any} */ ({ config, sistema: 'Plantulación automática' }));
        return { id, para: nombreCorto(encargado) };
    });

    await paso('aviso', async () => {
        const texto = `🌱 Siembra programada: ${nombreCliente} · ${pedido.variedad || ''} · ${plan.bandejas} bandejas de ${plan.alveolos} `
            + `el ${plan.siembra}${plan.trasplante ? `, trasplante ${plan.trasplante}` : ''}${plan.atrasada ? ' (adelantada: ya iba tarde)' : ''}.`;
        const [vendedores] = await pool.query("SELECT id FROM usuarios WHERE email = ? AND estado = 'aprobado'", [ejecutorDe(pedido, cliente)]);
        await avisar(contexto, [...plantuladores.map((/** @type {any} */ p) => p.id), ...vendedores.map((/** @type {any} */ v) => v.id)], 'germinador', texto);
        return { avisados: plantuladores.length + vendedores.length };
    });
}

// ----- #3 Envío entregado → visita técnica -----

/**
 * Lo llama avisarEnvio (envios.js) en cada cambio de estado, sea del rastreo automático o a mano: al pasar a
 * Entregado se encola ENVIO_ENTREGADO, una sola vez por envío.
 * @param {any} pool @param {Record<string, any>} registro @param {Record<string, any> | null} anterior @param {number | null} [autorId]
 */
export async function alCambiarEnvio(pool, registro, anterior, autorId = null) {
    if (registro.estado !== 'Entregado' || (anterior && anterior.estado === 'Entregado')) return false;
    return emitirEvento(pool, { tipo: 'ENVIO_ENTREGADO', clave: `visita:${String(registro.id).slice(0, 150)}`, usuarioId: autorId, carga: { envioId: String(registro.id) } });
}

/** @type {import('./eventos.js').Manejador} */
export async function alEntregarEnvio(evento, { paso, contexto }) {
    const { pool, config } = contexto;
    const envio = await db.leerRegistro(pool, 'envios', String(evento.carga.envioId || ''));
    if (!envio || envio.estado !== 'Entregado') return;
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    const cliente = envio.clienteId ? await db.leerRegistro(pool, 'clientes', String(envio.clienteId)) : null;
    const nombreCliente = (cliente && cliente.nombre) || envio.cliente || 'el cliente';
    // El técnico de su país y casa que ya trabaja con ese cliente (su última visita o proceso registrado); si ninguno,
    // el primero por nombre; y sin técnicos, el vendedor asignado al cliente
    const tecnicos = await personasDe(pool, config, 'tecnico', envio);
    let persona = tecnicos[0] || null;
    if (tecnicos.length > 1 && envio.clienteId) {
        const todo = /** @type {{ visitas?: any[], agronomia?: any[] }} */ (await db.listarTodo(pool));
        const visitas = todo.visitas || [], agronomia = todo.agronomia || [];
        /** @type {Map<string, string>} */
        const ultima = new Map();
        for (const r of [...visitas.map(v => ({ ...v, dia: v.fecha })), ...agronomia.map(p => ({ ...p, dia: p.fechaInicio }))]) {
            if (String(r.clienteId) !== String(envio.clienteId)) continue;
            const autor = correo(r.creadoPor || r.cuenta);
            if (String(r.dia || '') > (ultima.get(autor) || '')) ultima.set(autor, String(r.dia || ''));
        }
        const conCliente = tecnicos.filter((/** @type {any} */ t) => ultima.has(correo(t.email)))
            .sort((/** @type {any} */ x, /** @type {any} */ y) => String(ultima.get(correo(y.email))).localeCompare(String(ultima.get(correo(x.email)))));
        if (conCliente.length) persona = conCliente[0];
    }
    if (!persona && cliente && cliente.asignado) {
        const [filas] = await pool.query("SELECT * FROM usuarios WHERE email = ? AND estado = 'aprobado'", [correo(cliente.asignado)]);
        persona = filas[0] || null;
    }
    const vence = sumarDias(hoy, DIAS_VISITA);
    await paso('tarea', async () => {
        const id = idVisita(envio.id);
        if (await db.leerRegistro(pool, 'tareas', id)) return { id };
        await db.guardarRegistro(pool, 'tareas', {
            id, titulo: `Visita técnica de seguimiento: ${nombreCliente} (envío ${envio.transportista || ''} ${envio.guia || ''} entregado el ${hoy})`.replace(/\s+/g, ' '),
            prioridad: 'Media', vence, para: nombreCorto(persona), creadaPor: 'Seguimiento automático', creada: new Date().toISOString(),
            hecha: '', hechaPor: '', envioId: String(envio.id), clienteId: envio.clienteId || ''
        }, null, /** @type {any} */ ({ config, sistema: 'Seguimiento automático' }));
        return { id, para: nombreCorto(persona), vence };
    });
    await paso('aviso', async () => {
        if (!persona) return { omitido: 'Sin técnico ni vendedor asignado: la tarea queda para el equipo' };
        const plantilla = (await leerMensajes(pool)).visita.texto;
        await avisar(contexto, [persona.id], 'tarea', renderizar(plantilla, { vendedor: nombreCorto(persona), cliente: nombreCliente, fecha: vence, guia: envio.guia || '' }).replace(/[ \t]+/g, ' '));
        return { para: persona.email };
    });
}

// ----- #5 Clientes dormidos -----

/**
 * Clientes (por casa) que pasaron su ciclo de recompra sin gestión nueva. datos: todo el CRM; hoy: AAAA-MM-DD.
 * Gestión nueva: un pedido posterior al último confirmado (no cancelado) o una cotización posterior (no rechazada).
 * La recompra que abre el sistema no cuenta mientras siga Cotizada y sin precio (nadie la trabajó), y se dan
 * GRACIA_DORMIDO días desde que se abrió antes de avisar. Los pedidos de antes de la fase 2 (sin recompra), al vencer.
 * @param {{ pedidos?: any[], cotizaciones?: any[], clientes?: any[] }} datos
 * @param {string} hoy
 */
export function clientesDormidos(datos, hoy) {
    const fichas = new Map((datos.clientes || []).map(c => [String(c.id), c]));
    /** @type {Map<string, any[]>} */
    const grupos = new Map();
    for (const p of datos.pedidos || []) {
        if (!p.clienteId || !p.casa || p.estado === 'Cancelado') continue;
        const clave = `${p.clienteId}|${p.casa}`;
        grupos.set(clave, [...(grupos.get(clave) || []), p]);
    }
    const dormidos = [];
    for (const [clave, pedidos] of grupos) {
        const ventas = pedidos.filter(p => ESTADOS_VENTA.includes(p.estado) && /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || '')));
        if (!ventas.length) continue;
        const ultima = ventas.reduce((a, b) => (String(b.fecha) > String(a.fecha) || (b.fecha === a.fecha && String(b.id) > String(a.id)) ? b : a));
        const dias = Number(ultima.recompraDias) || DIAS_RECOMPRA;
        const vence = sumarDias(ultima.fecha, dias);
        if (hoy <= vence) continue;
        const sinTrabajar = (/** @type {any} */ p) => p.recompraDe && p.estado === 'Cotizado' && !(Number(p.precioMil) > 0);
        // Lo posterior al último confirmado (las otras ventas del mismo día son de la misma compra, no gestión nueva)
        const posteriores = pedidos.filter(p => p !== ultima && String(p.fecha || '') >= String(ultima.fecha) && !(ESTADOS_VENTA.includes(p.estado) && p.fecha === ultima.fecha));
        const [clienteId, casa] = clave.split('|');
        const cotizada = (datos.cotizaciones || []).some(c => String(c.clienteId) === clienteId && c.casa === casa && c.estado !== 'Rechazada'
            && String(c.fecha || c.creado || '').slice(0, 10) >= String(ultima.fecha));
        if (cotizada || posteriores.some(p => !sinTrabajar(p))) continue;
        const recompra = posteriores.find(sinTrabajar);
        if (recompra && hoy < sumarDias(String(recompra.fecha || vence), GRACIA_DORMIDO)) continue;
        const cliente = fichas.get(clienteId);
        dormidos.push({
            clienteId, casa, pais: ultima.pais, cliente: (cliente && cliente.nombre) || ultima.cliente || clienteId,
            vendedor: ejecutorDe(ultima, cliente || null), pedidoId: String(ultima.id), ultimaFecha: ultima.fecha,
            variedad: ultima.variedad || '', dias, recompraAbierta: Boolean(recompra)
        });
    }
    return dormidos;
}

/**
 * Repaso (cada hora): encola CLIENTE_DORMIDO para cada cliente dormido, una vez por su último pedido confirmado.
 * @param {any} contexto
 */
export async function revisarDormidos(contexto) {
    const { pool, config } = contexto;
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    let n = 0;
    for (const d of clientesDormidos(await db.listarTodo(pool), hoy)) {
        if (await emitirEvento(pool, { tipo: 'CLIENTE_DORMIDO', clave: `dormido:${d.pedidoId.slice(0, 150)}`, carga: d })) n++;
    }
    return n;
}

/** @type {import('./eventos.js').Manejador} */
export async function alDormirCliente(evento, { paso, contexto }) {
    const { pool } = contexto;
    const d = evento.carga;
    await paso('aviso', async () => {
        const [filas] = await pool.query("SELECT id, email, nombre FROM usuarios WHERE email = ? AND estado = 'aprobado'", [correo(d.vendedor)]);
        if (!filas[0]) return { omitido: 'El vendedor ya no está en el equipo' };
        // Texto editable en la Torre de control (mensajes.js); si la recompra sigue abierta, se dice al final
        const base = renderizar((await leerMensajes(pool)).dormido.texto, {
            vendedor: nombreCorto(filas[0]), cliente: d.cliente, casa: d.casa, variedad: d.variedad || 'sin variedad', fecha: d.ultimaFecha, dias: d.dias
        });
        const texto = d.recompraAbierta ? `${base} Su pedido de recompra sigue sin trabajar.` : base;
        await avisar(contexto, [filas[0].id], 'cliente', texto);
        return { para: filas[0].email };
    });
}

/**
 * Repaso periódico de clientes dormidos (cada hora; el primero, al minuto de arrancar).
 * @param {any} contexto
 */
export function iniciarCampo(contexto, { registrar = console, cadaMs = 3600000 } = {}) {
    const repasar = () => revisarDormidos(contexto).catch(error => registrar.error('Clientes dormidos:', error.message));
    const primero = setTimeout(repasar, 60000);
    const intervalo = setInterval(repasar, cadaMs);
    primero.unref?.();
    intervalo.unref?.();
    return () => { clearTimeout(primero); clearInterval(intervalo); };
}
