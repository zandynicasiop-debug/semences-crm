// @ts-check
/**
 * Borja bidireccional (B1): el equipo le contesta a Borja, por WhatsApp o en el chat de la app, con órdenes cortas que
 * hacen cosas en el CRM sin abrir cada ficha.
 *
 *   RESUMEN (o PENDIENTES / AGENDA)   su resumen de ahora, con las tareas y los seguimientos NUMERADOS
 *   LISTO 2 (o HECHO 2, LISTO visita Constanza)
 *                                     marca hecho ese pendiente de su lista del día: una tarea, o un seguimiento de
 *                                     cliente (se borra la fecha y queda "Seguimiento hecho" en su bitácora)
 *   VISITA Finca X (regular): nota    visita de hoy a ese cliente; sin el estado del cultivo entre paréntesis, Borja lo
 *                                     pregunta (1 a 5) antes de guardar
 *   NOTA Finca X: texto               una entrada en la bitácora del cliente (no cambia su etapa)
 *
 * Reglas:
 * - Nada se adivina: si el nombre coincide con varios clientes de su ámbito, Borja pregunta cuál (con números); si no
 *   entiende la orden, contesta con el menú. Solo clientes de SU país y SUS casas (nunca una ficha compartida).
 * - Todo se guarda por el mismo camino que la web (acciones.js › crm: permisos, eventos, avisos y auditoría HMAC con el
 *   antes y el después). Desde aquí nunca se borra nada ni se tocan precios, pedidos ni cotizaciones.
 * - La lista numerada es la del ÚLTIMO resumen que recibió ese día (el de la mañana o el que pidió con RESUMEN): se
 *   guarda congelada, para que "LISTO 2" sea lo mismo a las 7:00 y a las 15:00. Solo se numeran tareas y seguimientos.
 * - Lo que hay que recordar entre mensajes (la lista del día, la pregunta pendiente, el límite de 30 órdenes por hora y
 *   los mensajes ya atendidos) va en una sola columna JSON de usuarios (borja_estado): nada en la memoria del proceso,
 *   así que vale aunque el servidor se duerma o haya varios procesos.
 */
import crypto from 'node:crypto';
import * as db from './db.js';
import { ambitoDe, filtrarDatos, puedeEscribir, dentroDelAmbito } from './permisos.js';
import { enZona } from './fechas.js';
import { auditar } from './auditoria.js';

export const ESTADOS_CULTIVO = ['Bueno', 'Regular', 'Con plagas o enfermedades', 'Estrés hídrico', 'Listo para cosecha'];
export const MAX_ORDENES_HORA = 30;
export const MAX_OPCIONES = 6;
const PREGUNTA_VALIDA_MS = 2 * 3600000; // Una pregunta sin contestar en 2 horas se olvida
const MAX_BITACORA = 300;

export const MENU = [
    'Esto es lo que puedes pedirme:',
    '• RESUMEN: tus pendientes de hoy, numerados',
    '• LISTO 2: marcar hecho el pendiente número 2',
    '• VISITA Finca X (regular): lo que viste',
    '• NOTA Finca X: texto para su bitácora'
].join('\n');

export const PREGUNTA_CULTIVO = ESTADOS_CULTIVO.map((e, i) => `${i + 1}) ${e}`).join('  ');

const sinAcentos = (/** @type {unknown} */ t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
export const normalizar = (/** @type {unknown} */ t) => sinAcentos(t).toLowerCase().replace(/\s+/g, ' ').trim();

const ALIAS_CULTIVO = /** @type {[RegExp, number][]} */ ([
    [/^(1|buen[oa]|bien)$/, 0],
    [/^(2|regular)$/, 1],
    [/^(3|plagas?|enfermedad(es)?|con plagas?( o enfermedad(es)?)?|plagas o enfermedad(es)?)$/, 2],
    [/^(4|estres|estres hidrico|sequia|falta de agua)$/, 3],
    [/^(5|listo|lista|cosecha|para cosechar|listo para cosecha|lista para cosecha)$/, 4]
]);

/**
 * El estado del cultivo escrito a mano ("regular", "plagas", "3") → el valor del CRM, o null
 * @param {unknown} texto
 */
export function estadoCultivoDe(texto) {
    const t = normalizar(texto);
    const encontrado = ALIAS_CULTIVO.find(([patron]) => patron.test(t));
    return encontrado ? ESTADOS_CULTIVO[encontrado[1]] : null;
}

/**
 * Qué pide el mensaje. Devuelve { tipo, ... }: ayuda, numero, resumen, global, listo, visita, nota, agendar o desconocido.
 * @param {unknown} texto
 */
export function interpretarBorja(texto) {
    const crudo = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const t = normalizar(crudo).replace(/[.!¡¿?]+$/g, '').trim();
    if (!t || /^(ayuda|menu|comandos|opciones|hola|buenas|buenos dias|buenas tardes|\?)$/.test(t)) return { tipo: 'ayuda' };
    if (/^\d{1,2}$/.test(t)) return { tipo: 'numero', numero: Number(t) };
    if (/^(mi |mis )?(resumen|pendientes|agenda)( de hoy)?$/.test(t)) return { tipo: 'resumen' };
    if (/^(estado (del )?equipo|resumen global)$/.test(t)) return { tipo: 'global' };
    const listo = crudo.match(/^(?:listo|lista|hecho|hecha)\b\s*[:#-]?\s*(.*)$/i);
    if (listo) {
        const resto = listo[1].trim();
        if (!resto) return { tipo: 'listo', numero: null, texto: '' };
        return /^\d{1,2}$/.test(resto) ? { tipo: 'listo', numero: Number(resto), texto: '' } : { tipo: 'listo', numero: null, texto: resto };
    }
    const visita = crudo.match(/^visita\s+(.+?)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/i);
    if (visita) {
        const estadoEscrito = (visita[2] || '').trim();
        return { tipo: 'visita', cliente: visita[1].trim(), estado: estadoEscrito ? estadoCultivoDe(estadoEscrito) : null, estadoEscrito, nota: visita[3].trim() };
    }
    if (/^visita\b/i.test(crudo)) return { tipo: 'formato', ejemplo: 'VISITA Finca X (regular): lo que viste' };
    const nota = crudo.match(/^nota\s+(.+?)\s*:\s*(.+)$/i);
    if (nota) return { tipo: 'nota', cliente: nota[1].trim(), nota: nota[2].trim() };
    if (/^nota\b/i.test(crudo)) return { tipo: 'formato', ejemplo: 'NOTA Finca X: lo que quieras anotar' };
    if (/^agendar\b/i.test(crudo)) return { tipo: 'agendar', texto: crudo.replace(/^agendar\s*/i, '') };
    return { tipo: 'desconocido' };
}

/**
 * La bitácora de un cliente solo crece: lo que ya había se conserva aunque llegue un registro sin esas entradas (la
 * ficha editada en otro teléfono, sin la nota que acababa de entrar por WhatsApp). Une por id, en orden de fecha.
 * @param {unknown} antes @param {unknown} ahora
 */
export function unirBitacora(antes, ahora) {
    /** @type {Map<string, any>} */
    const porId = new Map();
    for (const lista of [antes, ahora]) {
        if (!Array.isArray(lista)) continue;
        for (const e of lista) {
            if (!e || typeof e !== 'object' || !e.id || porId.has(String(e.id))) continue;
            porId.set(String(e.id), {
                id: String(e.id).slice(0, 64), fecha: String(e.fecha || '').slice(0, 40), autor: String(e.autor || '').slice(0, 200),
                email: String(e.email || '').slice(0, 254), texto: String(e.texto || '').slice(0, 1000),
                ...(e.tipo ? { tipo: String(e.tipo).slice(0, 20) } : {}), ...(e.origen ? { origen: String(e.origen).slice(0, 20) } : {})
            });
        }
    }
    return [...porId.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(-MAX_BITACORA);
}

/**
 * Numera las líneas de tareas y seguimientos de un resumen ya filtrado (las secciones traen `items`, alineados con sus
 * líneas visibles). Devuelve las secciones con "1) …" delante y la lista para congelar: [{ n, tipo, id, etiqueta }].
 * @param {{ clave: string, titulo: string, lineas: string[], items?: { tipo: string, id: string, etiqueta: string }[] }[]} secciones
 */
export function numerarSecciones(secciones) {
    /** @type {{ n: number, tipo: string, id: string, etiqueta: string }[]} */
    const lista = [];
    const numeradas = secciones.map(s => {
        if (!s.items || !s.items.length) return s;
        const lineas = s.lineas.map((linea, i) => {
            const item = s.items && s.items[i];
            if (!item) return linea;
            lista.push({ n: lista.length + 1, tipo: item.tipo, id: item.id, etiqueta: item.etiqueta });
            return `${lista.length}) ${linea}`;
        });
        return { ...s, lineas };
    });
    return { secciones: numeradas, lista };
}

// ----- Estado de la conversación (columna usuarios.borja_estado) -----

/** @param {any} pool @param {number} id */
export async function leerEstadoBorja(pool, id) {
    const [[fila]] = await pool.query('SELECT borja_estado FROM usuarios WHERE id = ?', [id]);
    try {
        const valor = fila && fila.borja_estado ? JSON.parse(fila.borja_estado) : {};
        return valor && typeof valor === 'object' ? valor : {};
    } catch (e) {
        return {};
    }
}

/** @param {any} pool @param {number} id @param {any} estado */
export async function guardarEstadoBorja(pool, id, estado) {
    await pool.query('UPDATE usuarios SET borja_estado = ? WHERE id = ?', [JSON.stringify(estado).slice(0, 60000), id]);
}

/**
 * Congela la lista numerada del día (la de un resumen recién enviado). Una pregunta pendiente de otro día se olvida.
 * @param {any} pool @param {number} id @param {string} fecha @param {{ n: number, tipo: string, id: string, etiqueta: string }[]} lista
 */
export async function congelarLista(pool, id, fecha, lista) {
    const estado = await leerEstadoBorja(pool, id);
    await guardarEstadoBorja(pool, id, { ...estado, fecha, lista, pendiente: estado.pendiente && estado.pendiente.fecha === fecha ? estado.pendiente : null });
}

// ----- Ejecutar una orden -----

/**
 * Clientes de su país y sus casas que coinciden con lo escrito (sin tildes ni mayúsculas). Nunca fichas compartidas.
 * @param {any[]} clientes ya filtrados por su ámbito @param {any} ambito @param {string} buscado
 */
export function buscarClientes(clientes, ambito, buscado) {
    const q = normalizar(buscado);
    if (!q) return [];
    return clientes.filter(c => !c.compartida && dentroDelAmbito(ambito, 'clientes', c) && normalizar(c.nombre).includes(q))
        .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
}

const nuevoId = () => crypto.randomUUID();
const ahoraIso = () => new Date().toISOString();

/**
 * Atiende un mensaje de una persona del equipo. canal: 'whatsapp' | 'app'; idMensaje: el id de Meta (evita atender
 * dos veces el mismo mensaje si Meta lo reenvía). Devuelve { respuesta } (null = no contestar) y, para las pruebas y
 * la auditoría, { orden }.
 * @param {{ pool: any, config: any, google?: any, avisos?: any, ACCIONES: any, conEventos: Function, prepararResumen: Function }} contexto
 * @param {any} persona fila de usuarios
 * @param {string} texto
 * @param {{ canal?: 'whatsapp' | 'app', idMensaje?: string, ahora?: Date }} [opciones]
 */
export async function atenderBorja(contexto, persona, texto, { canal = 'app', idMensaje = '', ahora = new Date() } = {}) {
    const { pool, config } = contexto;
    const ambito = ambitoDe(persona, config);
    if (ambito.estado !== 'aprobado') return { respuesta: 'Tu cuenta todavía no tiene el acceso aprobado: cuando un Master lo apruebe, podré ayudarte.', orden: 'sin-acceso' };
    const estado = await leerEstadoBorja(pool, persona.id);
    // El mismo mensaje dos veces (Meta reintenta si tardamos): solo se atiende una
    const vistos = Array.isArray(estado.vistos) ? estado.vistos : [];
    if (idMensaje && vistos.includes(idMensaje)) return { respuesta: null, orden: 'repetido' };
    // Límite: 30 órdenes por hora y persona (el resto se rechaza, sin tocar nada)
    const marcas = (Array.isArray(estado.marcas) ? estado.marcas : []).filter((/** @type {number} */ m) => m > ahora.getTime() - 3600000);
    const guardar = (/** @type {any} */ cambios) => guardarEstadoBorja(pool, persona.id, {
        ...estado, ...cambios, marcas: [...marcas, ahora.getTime()].slice(-MAX_ORDENES_HORA),
        vistos: idMensaje ? [...vistos, idMensaje].slice(-30) : vistos
    });
    if (marcas.length >= MAX_ORDENES_HORA) {
        await guardarEstadoBorja(pool, persona.id, { ...estado, vistos: idMensaje ? [...vistos, idMensaje].slice(-30) : vistos });
        return { respuesta: `Llegaste al límite de ${MAX_ORDENES_HORA} órdenes por hora. Inténtalo en un rato o hazlo desde la app.`, orden: 'limite' };
    }

    const hoy = enZona(ahora, config.zonaHoraria).fecha;
    const quien = { config, usuario: persona, red: { ip: '', agente: canal === 'whatsapp' ? 'WhatsApp · Borja' : 'App · Borja' } };
    // El contexto con el que la web guarda: mismos permisos, eventos, avisos y auditoría
    const como = { ...contexto, usuario: persona, ambito, red: quien.red };
    const pendiente = estado.pendiente && estado.pendiente.creado > ahora.getTime() - PREGUNTA_VALIDA_MS ? estado.pendiente : null;
    const orden = interpretarBorja(texto);
    const anotar = (/** @type {string} */ resumen) => auditar(pool, config, { usuario: persona, accion: 'borja', resumen: `Borja (${canal === 'whatsapp' ? 'WhatsApp' : 'app'}): ${resumen}`.slice(0, 300), red: quien.red });

    /** @type {(cliente: any, nota: string, estadoCultivo: string) => Promise<string>} */
    const registrarVisita = async (cliente, nota, estadoCultivo) => {
        if (!puedeEscribir(ambito, 'visitas', { pais: cliente.pais, casa: cliente.casa })) return 'Tu cargo no registra visitas en el CRM. Si quieres, déjalo como NOTA en su bitácora.';
        const visita = {
            id: nuevoId(), clienteId: cliente.id, cliente: cliente.nombre, pais: cliente.pais || '', casa: cliente.casa || '',
            fecha: hoy, ubicacion: cliente.ubicacion || '', estado: estadoCultivo, comentarios: nota.slice(0, 2000),
            responsable: persona.nombre || persona.email, creado: ahoraIso(), origen: 'borja'
        };
        await contexto.ACCIONES.crm({ modulo: 'visitas', registro: visita }, como);
        await anotar(`visita a ${cliente.nombre} (${estadoCultivo})`);
        return `✅ Visita de hoy registrada en ${cliente.nombre} (cultivo: ${estadoCultivo}). Entra sola en tu reporte del viernes.`;
    };

    /** @type {(clienteId: string, entrada: any, cambios?: Record<string, any>) => Promise<any>} añade una entrada a la bitácora, por el camino de la web */
    const anadirABitacora = async (clienteId, entrada, cambios = {}) => {
        const actual = await db.leerRegistro(pool, 'clientes', clienteId);
        if (!actual) return null;
        const registro = { ...actual, ...cambios, bitacora: [...(Array.isArray(actual.bitacora) ? actual.bitacora : []), entrada] };
        if (puedeEscribir(ambito, 'clientes', actual)) {
            await contexto.ACCIONES.crm({ modulo: 'clientes', registro }, como);
        } else {
            // Técnicos y plantuladores no editan la ficha, pero sí pueden dejar una nota en la bitácora de un cliente de su
            // país y su casa: solo eso (el resto del registro es el que había), con el mismo guardado y auditoría
            if (Object.keys(cambios).length || !dentroDelAmbito(ambito, 'clientes', actual)) return null;
            await db.sincronizar(pool, { guardar: [{ modulo: 'clientes', registro }] }, persona,
                (/** @type {string} */ m, /** @type {any} */ r) => m === 'clientes' && dentroDelAmbito(ambito, 'clientes', r),
                { ...contexto.conEventos(como), devolverDatos: false });
        }
        return actual;
    };

    const entradaBitacora = (/** @type {string} */ textoNota, tipo = 'nota') => ({
        id: nuevoId(), fecha: ahoraIso(), autor: persona.nombre || persona.email, email: persona.email, texto: textoNota.slice(0, 1000), tipo, origen: 'borja'
    });

    /** @type {(cliente: any, textoNota: string) => Promise<string>} */
    const guardarNota = async (cliente, textoNota) => {
        const actual = await anadirABitacora(cliente.id, entradaBitacora(textoNota));
        if (!actual) return `No pude guardar la nota en ${cliente.nombre}: ese cliente no es de tu país o casa comercial.`;
        await anotar(`nota en la bitácora de ${cliente.nombre}`);
        return `📝 Nota guardada en la bitácora de ${cliente.nombre}.`;
    };

    /**
     * Elige el cliente o pregunta cuál (y entonces deja la pregunta pendiente). Devuelve { cliente } o { respuesta }; en
     * los dos casos de respuesta el estado ya queda guardado
     */
    const elegirCliente = async (/** @type {string} */ buscado, /** @type {any} */ siguiente) => {
        const datos = /** @type {any} */ (filtrarDatos(await db.listarTodo(pool), ambito));
        const encontrados = buscarClientes(datos.clientes || [], ambito, buscado);
        if (encontrados.length === 1) return { cliente: encontrados[0] };
        if (!encontrados.length || encontrados.length > MAX_OPCIONES) {
            await guardar({ pendiente: null });
            return { respuesta: !encontrados.length
                ? `No encuentro ningún cliente «${buscado}» de tu país y tus casas comerciales. Revisa el nombre (basta una parte: «Robles»).`
                : `Hay ${encontrados.length} clientes con «${buscado}». Escribe un poco más del nombre para que sea uno solo.` };
        }
        const opciones = encontrados.map(c => ({ id: c.id, nombre: c.nombre, casa: c.casa || '' }));
        await guardar({ pendiente: { tipo: 'cliente', fecha: hoy, creado: ahora.getTime(), opciones, siguiente } });
        return { respuesta: `Tengo ${opciones.length} clientes con «${buscado}»:\n${opciones.map((o, i) => `${i + 1}) ${o.nombre}${o.casa ? ` (${o.casa})` : ''}`).join('\n')}\nResponde solo con el número.` };
    };

    /** Lo que se hace con el cliente ya elegido */
    const conCliente = async (/** @type {any} */ cliente, /** @type {any} */ siguiente) => {
        if (siguiente.accion === 'nota') { await guardar({ pendiente: null }); return guardarNota(cliente, siguiente.nota); }
        if (siguiente.estado) { await guardar({ pendiente: null }); return registrarVisita(cliente, siguiente.nota, siguiente.estado); }
        // Visita sin el estado del cultivo: se pregunta antes de guardar (no se inventa)
        await guardar({ pendiente: { tipo: 'cultivo', fecha: hoy, creado: ahora.getTime(), cliente: { id: cliente.id, nombre: cliente.nombre, pais: cliente.pais, casa: cliente.casa, ubicacion: cliente.ubicacion || '' }, nota: siguiente.nota } });
        return `¿Cómo está el cultivo en ${cliente.nombre}? Responde con el número:\n${PREGUNTA_CULTIVO}`;
    };

    /** @type {(item: any) => Promise<string>} */
    const marcarHecho = async (item) => {
        if (item.tipo === 'tarea') {
            const tarea = await db.leerRegistro(pool, 'tareas', item.id);
            if (!tarea) return `La tarea «${item.etiqueta}» ya no existe.`;
            if (tarea.hecha) return `La tarea «${item.etiqueta}» ya estaba hecha.`;
            await contexto.ACCIONES.crm({ modulo: 'tareas', registro: { ...tarea, hecha: ahoraIso(), hechaPor: persona.nombre || persona.email } }, como);
        } else {
            const cliente = await db.leerRegistro(pool, 'clientes', item.id);
            if (!cliente || !puedeEscribir(ambito, 'clientes', cliente)) return `No puedo cerrar el seguimiento de «${item.etiqueta}»: ya no es de tu país o casa comercial.`;
            if (!cliente.seguimiento) return `${item.etiqueta} ya no tenía un seguimiento pendiente.`;
            await anadirABitacora(cliente.id, entradaBitacora('Seguimiento hecho', 'seguimiento'), { seguimiento: '' });
        }
        const lista = (estado.lista || []).map((/** @type {any} */ x) => (x.n === item.n ? { ...x, hecho: true } : x));
        await guardar({ lista, pendiente: null });
        await anotar(`listo ${item.n} (${item.tipo === 'tarea' ? 'tarea' : 'seguimiento'}: ${item.etiqueta})`);
        return `✅ Hecho (#${item.n}): ${item.tipo === 'tarea' ? 'la tarea' : 'el seguimiento de'} «${item.etiqueta}». Entra solo en tu reporte del viernes.`;
    };

    // 1) Contesta a una pregunta pendiente con un número
    if (orden.tipo === 'numero' && pendiente) {
        const n = Number(orden.numero);
        if (pendiente.tipo === 'cultivo') {
            const estadoCultivo = ESTADOS_CULTIVO[n - 1];
            if (!estadoCultivo) { await guardar({}); return { respuesta: `Responde con un número del 1 al 5:\n${PREGUNTA_CULTIVO}`, orden: 'cultivo' }; }
            await guardar({ pendiente: null });
            return { respuesta: await registrarVisita(pendiente.cliente, pendiente.nota, estadoCultivo), orden: 'visita' };
        }
        if (pendiente.tipo === 'cliente') {
            const opcion = (pendiente.opciones || [])[n - 1];
            if (!opcion) { await guardar({}); return { respuesta: `Elige un número del 1 al ${(pendiente.opciones || []).length}.`, orden: 'cliente' }; }
            const cliente = await db.leerRegistro(pool, 'clientes', opcion.id);
            if (!cliente || !dentroDelAmbito(ambito, 'clientes', cliente)) { await guardar({ pendiente: null }); return { respuesta: 'Ese cliente ya no está disponible.', orden: 'cliente' }; }
            return { respuesta: await conCliente(cliente, pendiente.siguiente), orden: pendiente.siguiente.accion };
        }
        if (pendiente.tipo === 'listo') {
            const item = (estado.lista || []).find((/** @type {any} */ x) => x.n === (pendiente.opciones || [])[n - 1]);
            if (!item) { await guardar({}); return { respuesta: 'Ese número no está entre las opciones.', orden: 'listo' }; }
            return { respuesta: await marcarHecho(item), orden: 'listo' };
        }
    }
    // Una orden nueva deja sin efecto la pregunta pendiente
    const sinPendiente = { pendiente: null };

    switch (orden.tipo) {
    case 'numero':
        await guardar(sinPendiente);
        return { respuesta: `¿Quieres marcar hecho el ${orden.numero}? Escribe LISTO ${orden.numero}.`, orden: 'numero' };
    case 'resumen': {
        const { texto: resumen, lista } = await contexto.prepararResumen(contexto, persona, hoy);
        await guardar({ ...sinPendiente, fecha: hoy, lista });
        await anotar('resumen');
        return { respuesta: resumen || 'No tienes pendientes para hoy. ¡Buen trabajo!', orden: 'resumen' };
    }
    case 'listo': {
        if (orden.numero === null && !orden.texto) { await guardar(sinPendiente); return { respuesta: 'Dime cuál: LISTO y el número de tu lista de hoy (por ejemplo, LISTO 2).', orden: 'listo' }; }
        const lista = estado.fecha === hoy && Array.isArray(estado.lista) ? estado.lista : [];
        if (!lista.length) { await guardar(sinPendiente); return { respuesta: 'Todavía no tienes la lista numerada de hoy. Escribe RESUMEN y te la mando.', orden: 'listo' }; }
        let item = null;
        if (orden.numero !== null) {
            item = lista.find((/** @type {any} */ x) => x.n === orden.numero);
            if (!item) { await guardar(sinPendiente); return { respuesta: `En tu lista de hoy no hay un ${orden.numero}: va del 1 al ${lista.length}. Escribe RESUMEN para verla.`, orden: 'listo' }; }
        } else {
            const q = normalizar(orden.texto);
            const candidatos = lista.filter((/** @type {any} */ x) => normalizar(x.etiqueta).includes(q) || q.includes(normalizar(x.etiqueta)));
            if (!candidatos.length) { await guardar(sinPendiente); return { respuesta: `No encuentro «${orden.texto}» en tu lista de hoy. Escribe RESUMEN para verla con sus números.`, orden: 'listo' }; }
            if (candidatos.length > 1) {
                await guardar({ pendiente: { tipo: 'listo', fecha: hoy, creado: ahora.getTime(), opciones: candidatos.map((/** @type {any} */ x) => x.n) } });
                return { respuesta: `¿Cuál de estos?\n${candidatos.map((/** @type {any} */ x, /** @type {number} */ i) => `${i + 1}) ${x.etiqueta}`).join('\n')}\nResponde solo con el número.`, orden: 'listo' };
            }
            item = candidatos[0];
        }
        if (item.hecho) { await guardar(sinPendiente); return { respuesta: `El #${item.n} («${item.etiqueta}») ya lo marcaste hecho.`, orden: 'listo' }; }
        return { respuesta: await marcarHecho(item), orden: 'listo' };
    }
    case 'visita': {
        if (orden.estadoEscrito && !orden.estado) {
            await guardar(sinPendiente);
            return { respuesta: `No reconozco el estado «${orden.estadoEscrito}». Usa uno de estos (o su número):\n${PREGUNTA_CULTIVO}`, orden: 'visita' };
        }
        const siguiente = { accion: 'visita', nota: orden.nota, estado: orden.estado };
        const r = await elegirCliente(String(orden.cliente), siguiente);
        if (!r.cliente) return { respuesta: r.respuesta, orden: 'visita' };
        return { respuesta: await conCliente(r.cliente, siguiente), orden: 'visita' };
    }
    case 'nota': {
        const siguiente = { accion: 'nota', nota: orden.nota };
        const r = await elegirCliente(String(orden.cliente), siguiente);
        if (!r.cliente) return { respuesta: r.respuesta, orden: 'nota' };
        return { respuesta: await conCliente(r.cliente, siguiente), orden: 'nota' };
    }
    case 'formato':
        await guardar(sinPendiente);
        return { respuesta: `Así: ${orden.ejemplo}`, orden: 'formato' };
    case 'agendar':
    case 'global':
        await guardar(sinPendiente);
        return { respuesta: `Eso llega en la próxima actualización de Borja. Mientras tanto:\n${MENU}`, orden: orden.tipo };
    default:
        await guardar(sinPendiente);
        return { respuesta: `${orden.tipo === 'ayuda' ? '👋 Hola, soy Borja.' : 'No te entendí.'} ${MENU}\n(BAJA / ALTA: dejar o volver a recibir WhatsApp)`, orden: orden.tipo };
    }
}
