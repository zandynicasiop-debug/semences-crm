// @ts-check
/**
 * Lote B: mensajes automáticos que el Master edita desde la Torre de control (tabla `ajustes`, claves 'mensajes' y
 * 'borja'), sin tocar código.
 *
 * - Cada mensaje tiene texto (campana, push y correo; el asunto, si va por correo) con variables {{…}}, y los que
 *   salen a una hora fija (briefing de Borja y recordatorio del viernes), su hora. Los valores por defecto son los
 *   textos de siempre: hasta que alguien los cambie, todo sale igual que antes.
 * - WhatsApp: los mensajes que inicia la empresa tienen que ir en una plantilla aprobada por Meta, así que su texto
 *   no se edita aquí: solo se elige cuál de las plantillas aprobadas se usa (con las variables que espera).
 * - Borja: qué secciones lleva el resumen de la mañana.
 */

/**
 * @typedef {{ asunto?: string, texto: string, hora?: number | null, plantillaWhatsapp?: string, variablesWhatsapp?: number }} Mensaje
 * @typedef {{ nombre: string, descripcion: string, variables: string[], asunto: boolean, hora: boolean, whatsapp: 0 | 1 | 7, porDefecto: Mensaje }} Definicion
 */

/** Qué significa cada variable (se muestra en el editor) */
export const VARIABLES = {
    vendedor: 'Nombre de quien lo recibe',
    cliente: 'Nombre del cliente',
    casa: 'Casa comercial',
    variedad: 'Variedad',
    fecha: 'Fecha del aviso o del pedido',
    dias: 'Días del ciclo de recompra',
    guia: 'Guía del envío',
    lista_pendientes: 'Lo pendiente de hoy (todas las secciones del resumen)',
    agenda_dia: 'La agenda de hoy en Google Calendar'
};

/** @type {Record<string, Definicion>} */
export const CATALOGO = {
    resumen: {
        nombre: 'Briefing de la mañana (Borja)',
        descripcion: 'Saludo del resumen diario. Si no pones {{lista_pendientes}}, lo pendiente va después del saludo.',
        variables: ['vendedor', 'fecha', 'lista_pendientes', 'agenda_dia'],
        asunto: true, hora: true, whatsapp: 7,
        porDefecto: { asunto: '☀️ Tu resumen de hoy ({{fecha}}) · Semences del Caribe', texto: '☀️ Buenos días, {{vendedor}}. Soy Borja, tu resumen de hoy', hora: null, plantillaWhatsapp: '' }
    },
    recordatorio: {
        nombre: 'Recordatorio del reporte semanal (viernes)',
        descripcion: 'A quien aún no entregó su reporte de la semana.',
        variables: ['vendedor'],
        asunto: false, hora: true, whatsapp: 1,
        porDefecto: { texto: '📋 Hola, {{vendedor}}: entrega hoy tu reporte semanal (menú › Reporte semanal). Desde el lunes la app lo pide antes de seguir.', hora: null, plantillaWhatsapp: '' }
    },
    recompra: {
        nombre: 'Recompra de temporada',
        descripcion: 'Al vendedor, cuando se abre el pedido de la nueva temporada.',
        variables: ['vendedor', 'cliente', 'casa', 'variedad'],
        asunto: false, hora: false, whatsapp: 0,
        porDefecto: { texto: '🔁 Recompra: {{cliente}} · {{casa}} · {{variedad}}. Se abrió el pedido de la nueva temporada (Cotizado): confirma la cantidad y el precio.' }
    },
    dormido: {
        nombre: 'Cliente dormido',
        descripcion: 'Al vendedor, cuando un cliente pasa su ciclo sin gestión nueva.',
        variables: ['vendedor', 'cliente', 'casa', 'variedad', 'fecha', 'dias'],
        asunto: false, hora: false, whatsapp: 0,
        porDefecto: { texto: '😴 Cliente dormido: {{cliente}} · {{casa}}. Pasaron sus {{dias}} días de ciclo desde el último pedido confirmado ({{variedad}}, {{fecha}}) sin cotización ni pedido nuevo.' }
    },
    visita: {
        nombre: 'Visita técnica tras la entrega',
        descripcion: 'Al técnico (o al vendedor), cuando un envío se entrega.',
        variables: ['vendedor', 'cliente', 'fecha', 'guia'],
        asunto: false, hora: false, whatsapp: 0,
        porDefecto: { texto: '🔎 Visita técnica el {{fecha}}: {{cliente}} recibió su envío {{guia}}. Revisa cómo va la siembra.' }
    }
};

/** Secciones del resumen de Borja que el Master puede quitar o poner */
export const SECCIONES_BORJA = {
    prioridades: '💵 Prioridades en US$',
    agenda: '📅 Agenda de Google Calendar',
    seguimientos: '🤝 Seguimientos de clientes',
    tareas: '📋 Tareas',
    procesos: '🌱 Procesos agronómicos',
    germinador: '🧪 Germinador',
    envios: '📦 Envíos',
    mensajes: '💬 Mensajes del tablero',
    equipo: '📊 Consolidado del equipo (administración)'
};

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Pone los datos en una plantilla: {{cliente}} → "Finca López". Lo que no se conoce queda vacío.
 * @param {string} plantilla @param {Record<string, unknown>} datos
 */
export function renderizar(plantilla, datos) {
    return String(plantilla || '').replace(VARIABLE, (_, nombre) => {
        const v = datos[nombre];
        return v === undefined || v === null ? '' : String(v);
    });
}

const textoLimpio = (/** @type {unknown} */ v, /** @type {number} */ max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

/**
 * Comprueba lo que manda el editor. Devuelve { mensajes } (todos los del catálogo, con lo no enviado por defecto) o { error }.
 * plantillas: las de WhatsApp que se pueden elegir ({ nombre, variables }); vacío = no se comprueba contra Meta.
 * @param {any} entrada
 * @param {{ nombre: string, variables: number }[]} [plantillas]
 * @returns {{ mensajes: Record<string, Mensaje> } | { error: string }}
 */
export function validarMensajes(entrada, plantillas = []) {
    if (!entrada || typeof entrada !== 'object') return { error: 'Faltan los mensajes' };
    /** @type {Record<string, Mensaje>} */
    const mensajes = {};
    for (const [clave, def] of Object.entries(CATALOGO)) {
        const e = entrada[clave] && typeof entrada[clave] === 'object' ? entrada[clave] : {};
        /** @type {Mensaje} */
        const m = { texto: textoLimpio(e.texto ?? def.porDefecto.texto, 1000) };
        if (!m.texto) return { error: `${def.nombre}: el texto no puede quedar vacío` };
        if (def.asunto) {
            m.asunto = textoLimpio(e.asunto ?? def.porDefecto.asunto, 150).replace(/\n/g, ' ');
            if (!m.asunto) return { error: `${def.nombre}: el asunto no puede quedar vacío` };
        }
        for (const parte of [m.texto, m.asunto || '']) {
            for (const [, nombre] of parte.matchAll(VARIABLE)) {
                if (!def.variables.includes(nombre)) return { error: `${def.nombre}: {{${nombre}}} no existe aquí. Se puede usar: ${def.variables.map(v => `{{${v}}}`).join(', ')}` };
            }
        }
        if (def.hora) {
            const hora = e.hora === '' || e.hora === null || e.hora === undefined ? null : Number(e.hora);
            if (hora !== null && !(Number.isInteger(hora) && hora >= 0 && hora <= 23)) return { error: `${def.nombre}: la hora va de 0 a 23` };
            m.hora = hora;
        }
        if (def.whatsapp) {
            const nombre = String(e.plantillaWhatsapp ?? '').trim().slice(0, 100);
            // El briefing admite la plantilla de varias líneas (7 variables) o una de una sola variable
            const valen = def.whatsapp === 7 ? [1, 7] : [1];
            if (nombre && plantillas.length) {
                const p = plantillas.find(x => x.nombre === nombre);
                if (!p) return { error: `${def.nombre}: «${nombre.slice(0, 60)}» no está entre las plantillas aprobadas de WhatsApp` };
                if (!valen.includes(p.variables)) return { error: `${def.nombre}: la plantilla «${nombre}» tiene ${p.variables} variable(s) y aquí hace falta ${valen.join(' o ')}` };
                m.variablesWhatsapp = p.variables;
            } else if (nombre) {
                // Lo ya guardado (se comprobó al guardarlo): se conserva con sus variables
                m.variablesWhatsapp = valen.includes(Number(e.variablesWhatsapp)) ? Number(e.variablesWhatsapp) : 1;
            }
            m.plantillaWhatsapp = nombre;
        }
        mensajes[clave] = m;
    }
    return { mensajes };
}

/** Los mensajes de por defecto */
export const MENSAJES_POR_DEFECTO = /** @type {Record<string, Mensaje>} */ (Object.fromEntries(Object.entries(CATALOGO).map(([c, d]) => [c, { ...d.porDefecto }])));

/**
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @param {string} clave
 */
async function leerAjuste(pool, clave) {
    const [filas] = await pool.query('SELECT valor FROM ajustes WHERE clave = ?', [clave]);
    if (!filas.length) return null;
    try { return JSON.parse(filas[0].valor); } catch (e) { return null; }
}

/**
 * Mensajes vigentes (lo guardado, o lo de por defecto si no hay nada o no vale).
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @returns {Promise<Record<string, Mensaje>>}
 */
export async function leerMensajes(pool) {
    const guardado = await leerAjuste(pool, 'mensajes');
    if (!guardado) return MENSAJES_POR_DEFECTO;
    const r = validarMensajes(guardado);
    return 'mensajes' in r ? r.mensajes : MENSAJES_POR_DEFECTO;
}

/**
 * Secciones activas del resumen de Borja: { prioridades: true, … } (todas, si no se tocó).
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @returns {Promise<Record<string, boolean>>}
 */
export async function leerBorja(pool) {
    const guardado = await leerAjuste(pool, 'borja');
    const activas = guardado && guardado.secciones && typeof guardado.secciones === 'object' ? guardado.secciones : {};
    return Object.fromEntries(Object.keys(SECCIONES_BORJA).map(s => [s, activas[s] !== false]));
}

/**
 * Guarda un ajuste (JSON) a nombre de quien lo cambia.
 * @param {{ query: (sql: string, valores?: any) => Promise<any> }} pool
 * @param {string} clave @param {unknown} valor @param {string} email
 */
export async function guardarAjuste(pool, clave, valor, email) {
    await pool.query(
        `INSERT INTO ajustes (clave, valor, actualizado, actualizado_por) VALUES (?, ?, UTC_TIMESTAMP(), ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = UTC_TIMESTAMP(), actualizado_por = VALUES(actualizado_por)`,
        [clave, JSON.stringify(valor), email]);
}
