// @ts-check
/**
 * Lote B: la agenda del CEO con Borja (Torre de control › Mi agenda con Borja). Solo para los Master, y cada uno ve
 * solo lo suyo (tabla `agenda_ceo`, siempre por usuario_id).
 *
 * - Listas: Mis Cosas, Finanzas, Supervisión Comercial y Seguimiento de Correos.
 * - Órdenes a Borja, en español y sin IA (coste cero, siempre igual): anotar en una lista ("finanzas: pagar el
 *   ITBIS el viernes"), agendar en Google Calendar ("agenda reunión con Hexagon mañana a las 3 con x@y.com"), mandar
 *   un correo ("correo a x@y.com: Asunto | Texto") o seguir un hilo ("seguimiento a x@y.com: ¿novedades?"),
 *   completar ("listo: pagar el ITBIS") y preguntar ("¿qué tengo hoy?").
 * - Lo que toca Google (Calendar y Gmail) no hace esperar a nadie: se guarda en la misma transacción que el evento
 *   BORJA_CEO_ORDEN y lo hace el motor de eventos en segundo plano, paso a paso (la cita lleva un id fijo: un
 *   reintento no la duplica).
 * - Supervisión Comercial se llena sola: una cotización en US$ por encima del umbral (US$ 5,000 por defecto) entra en
 *   la lista de cada Master, una sola vez.
 */
import crypto from 'node:crypto';
import { conGoogle } from './llamadasGoogle.js';
import { construirCorreo } from './correo.js';
import { registrarAviso } from './campana.js';
import { emitirEvento } from './eventos.js';
import { esPasajero } from './reintentos.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import { correo } from './pedidos.js';

export const LISTAS_CEO = ['Mis Cosas', 'Finanzas', 'Supervisión Comercial', 'Seguimiento de Correos'];
export const UMBRAL_SUPERVISION = 5000;
const PRIORIDADES = ['Alta', 'Media', 'Baja'];

export const ESQUEMA_AGENDA_CEO = [
    `CREATE TABLE IF NOT EXISTS agenda_ceo (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT UNSIGNED NOT NULL,
        lista VARCHAR(40) NOT NULL,
        titulo VARCHAR(300) NOT NULL,
        detalle TEXT NULL,
        prioridad ENUM('Alta', 'Media', 'Baja') NOT NULL DEFAULT 'Media',
        fecha DATE NULL,
        hora CHAR(5) NULL,
        estado ENUM('pendiente', 'hecho') NOT NULL DEFAULT 'pendiente',
        tipo ENUM('nota', 'cita', 'correo') NOT NULL DEFAULT 'nota',
        datos TEXT NULL,
        google_id VARCHAR(200) NULL,
        enlace VARCHAR(500) NULL,
        sincronizado VARCHAR(20) NOT NULL DEFAULT '',
        error VARCHAR(300) NOT NULL DEFAULT '',
        origen VARCHAR(190) NULL,
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        hecho DATETIME NULL,
        UNIQUE KEY origen (usuario_id, origen),
        INDEX (usuario_id, estado)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

// ----- Fechas en español -----
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
// Sin tildes y en minúsculas, letra por letra (mismo largo: las posiciones sirven para recortar el texto original)
const plano = (/** @type {string} */ t) => t.toLowerCase().replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n');
const dos = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * Cuándo dice el texto: { fecha (AAAA-MM-DD local), hora (HH:MM), minutos (duración), resto (el texto sin eso) }.
 * hoy: AAAA-MM-DD en la zona del equipo. "a las 3" sin am/pm, de 1 a 6, se entiende por la tarde (horario de oficina).
 * @param {string} texto
 * @param {string} hoy
 */
export function interpretarCuando(texto, hoy) {
    let resto = String(texto || '');
    /** @type {string | null} */
    let fecha = null;
    /** @type {string | null} */
    let hora = null;
    let minutos = 0;
    const quitar = (/** @type {RegExp} */ patron, /** @type {(m: RegExpExecArray) => void} */ alEncontrar) => {
        const m = patron.exec(plano(resto));
        if (!m) return false;
        alEncontrar(m);
        resto = `${resto.slice(0, m.index)} ${resto.slice(m.index + m[0].length)}`;
        return true;
    };
    const anio = Number(hoy.slice(0, 4));
    const diaSemanaHoy = new Date(`${hoy}T12:00:00Z`).getUTCDay();
    const conAnio = (/** @type {number} */ m, /** @type {number} */ d, /** @type {number | null} */ a) => {
        let f = `${a || anio}-${dos(m)}-${dos(d)}`;
        if (!a && f < hoy) f = `${anio + 1}-${dos(m)}-${dos(d)}`;
        return f;
    };

    // Duración: "por 1 hora", "durante 45 min", "1h"
    quitar(/\b(?:por|durante)\s+(\d+(?:[.,]\d+)?)\s*(h|hora|horas|min|minutos)\b/, (m) => { const n = Number(m[1].replace(',', '.')); minutos = /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n); });
    // Fecha
    quitar(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => { fecha = `${m[1]}-${m[2]}-${m[3]}`; })
        || quitar(/\b(?:el\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => { const a = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null; fecha = conAnio(Number(m[2]), Number(m[1]), a); })
        || quitar(new RegExp(`\\b(?:el\\s+)?(\\d{1,2})\\s+de\\s+(${MESES.join('|')})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`), (m) => { fecha = conAnio(MESES.indexOf(m[2]) + 1, Number(m[1]), m[3] ? Number(m[3]) : null); })
        || quitar(/\bpasado\s+manana\b/, () => { fecha = sumarDias(hoy, 2); })
        // "mañana" es el día siguiente, salvo en "por/en/de la mañana" (la franja horaria)
        || quitar(/\bmanana\b(?<!(?:en|por|de)\s+la\s+manana)/, () => { fecha = sumarDias(hoy, 1); })
        || quitar(/\bhoy\b/, () => { fecha = hoy; })
        || quitar(new RegExp(`\\b(?:el\\s+)?(?:proximo\\s+)?(${DIAS.join('|')})(?:\\s+que\\s+viene)?\\b`), (m) => {
            const objetivo = DIAS.indexOf(m[1]);
            fecha = sumarDias(hoy, ((objetivo - diaSemanaHoy + 7) % 7) || 7);
        });
    // Hora: "15:30", "a las 3 pm", "a las 10", "4pm"; o la franja ("por la tarde")
    const ponerHora = (/** @type {number} */ h, /** @type {number} */ m, /** @type {string} */ sufijo) => {
        let hh = h;
        if (/p\.?\s?m|tarde|noche/.test(sufijo) && hh < 12) hh += 12;
        else if (/a\.?\s?m|manana/.test(sufijo) && hh === 12) hh = 0;
        else if (!sufijo && hh >= 1 && hh <= 6) hh += 12;
        if (hh <= 23 && m <= 59) hora = `${dos(hh)}:${dos(m)}`;
    };
    const SUFIJO = '(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|de la tarde|de la noche|de la manana)?';
    quitar(new RegExp(`\\ba\\s+las?\\s+(\\d{1,2})(?::(\\d{2}))?\\s*${SUFIJO}`), (m) => ponerHora(Number(m[1]), Number(m[2] || 0), m[3] || ''))
        || quitar(new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*${SUFIJO}`), (m) => ponerHora(Number(m[1]), Number(m[2]), m[3] || ''))
        || quitar(/\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?=\s|$|[.,;])/, (m) => ponerHora(Number(m[1]), 0, m[2]))
        || quitar(/\b(?:en|por)\s+la\s+(manana|tarde)\b/, (m) => { hora = m[1] === 'manana' ? '09:00' : '15:00'; });
    resto = resto.replace(/\s+/g, ' ').replace(/^[\s,.:;–-]+|[\s,.:;–-]+$/g, '').replace(/\s+(el|para el|a|de|para)$/i, '').trim();
    return { fecha, hora, minutos, resto };
}

// ----- Órdenes -----
const EMAIL = /[^\s<>,;:()]+@[^\s<>,;:()]+\.[a-z]{2,}/i;
/** @type {[RegExp, string][]} */
const LISTA_POR_PALABRA = [[/^mis\s+cosas$/, 'Mis Cosas'], [/^finanzas$/, 'Finanzas'], [/^supervision(\s+comercial)?$/, 'Supervisión Comercial'], [/^(seguimiento(\s+de\s+correos)?|correos)$/, 'Seguimiento de Correos']];

/**
 * @typedef {{ accion: 'anotar' | 'agendar' | 'correo' | 'completar' | 'consultar' | 'ayuda', lista?: string, titulo?: string,
 *   prioridad?: string, fecha?: string | null, hora?: string | null, minutos?: number, para?: string, asunto?: string,
 *   cuerpo?: string, seguimiento?: boolean, invitado?: string, meet?: boolean, error?: string }} Orden
 */

/**
 * Lo que pide el CEO, sin IA: siempre la misma respuesta para el mismo texto.
 * @param {string} entrada
 * @param {string} hoy  AAAA-MM-DD local
 * @returns {Orden}
 */
export function interpretarOrden(entrada, hoy) {
    let texto = String(entrada || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    texto = texto.replace(/^borja\s*[,:]?\s*/i, '');
    const p = plano(texto);
    if (!texto || /^(ayuda|\?|que (puedes|sabes) hacer)/.test(p)) return { accion: 'ayuda' };
    const prioridad = /\b(urgente|importante|prioridad alta)\b/.test(p) ? 'Alta' : /\b(cuando (pueda|puedas)|prioridad baja|sin prisa)\b/.test(p) ? 'Baja' : 'Media';
    const sinPrioridad = (/** @type {string} */ t) => t.replace(/\b(urgente|importante|prioridad alta|prioridad baja|sin prisa)\b/gi, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();

    // Correo o seguimiento de un hilo
    const c = /^(?:(?:envia|manda)(?:le)?\s+(?:un\s+)?correo|correo|email|escribe(?:le)?|seguimiento)\s+(?:a|para)\s+(\S+@\S+?)\s*[:,–-]?\s+([\s\S]+)$/i.exec(p);
    if (c && EMAIL.test(c[1])) {
        const inicio = texto.length - c[2].length;
        const contenido = texto.slice(inicio).trim();
        const [asunto, ...cuerpo] = contenido.split('|').map(s => s.trim());
        const seguimiento = p.startsWith('seguimiento');
        const primera = asunto.split(/(?<=[.?!])\s/)[0].slice(0, 120);
        return {
            accion: 'correo', lista: 'Seguimiento de Correos', para: (EMAIL.exec(c[1]) || [''])[0].toLowerCase(), seguimiento, prioridad,
            asunto: cuerpo.length ? asunto.slice(0, 200) : primera, cuerpo: cuerpo.length ? cuerpo.join(' | ') : contenido,
            titulo: `${seguimiento ? 'Seguimiento' : 'Correo'} a ${(EMAIL.exec(c[1]) || [''])[0]}: ${cuerpo.length ? asunto : primera}`.slice(0, 300)
        };
    }
    if (/^(correo|email|envia|manda|escribe|seguimiento)\b/.test(p) && !EMAIL.test(texto)) {
        return { accion: 'correo', error: 'Dime a qué correo, por ejemplo: correo a ana@ejemplo.com: Asunto | Texto' };
    }

    // Completar
    const hecho = /^(listo|hecho|completad[oa]|terminad[oa]|ya (hice|pague|envie|llame))\s*[:,–-]?\s*(.*)$/.exec(p);
    if (hecho) return { accion: 'completar', titulo: texto.slice(texto.length - hecho[3].length).trim() };

    // Consultar
    if (/^(¿\s*)?(que tengo|que hay|mis pendientes|mi agenda|mi dia|resumen|como (va|voy|vamos)|pendientes)/.test(p)) return { accion: 'consultar' };

    // Agendar en Google Calendar
    const agenda = /^(agendame|agenda(?:r)?|cita|reunion|bloquea(?:me)?|ponme en (?:el|mi) calendario|recuerdame en (?:el|mi) calendario)\b\s*/.exec(p);
    if (agenda) {
        const invitado = (EMAIL.exec(texto) || [''])[0].toLowerCase();
        let resto = texto.slice(agenda[0].length);
        if (invitado) resto = resto.replace(new RegExp(`\\s*(con|y|invita(r)? a)?\\s*${invitado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), ' ');
        const cuando = interpretarCuando(sinPrioridad(resto), hoy);
        const meet = Boolean(invitado) || /\b(meet|videollamada)\b/.test(p);
        // "reunión con Ana…" → "Reunión con Ana"; "cita con el banco…" → "Cita con el banco"
        const prefijo = agenda[1] === 'reunion' ? 'Reunión' : agenda[1] === 'cita' ? 'Cita' : '';
        const base = prefijo && !new RegExp(`^${plano(prefijo)}`).test(plano(cuando.resto)) ? `${prefijo} ${cuando.resto}` : cuando.resto;
        const titulo = base.replace(/\b(con\s+)?(meet|videollamada)\b/gi, '').replace(/\s+/g, ' ').trim();
        if (!cuando.fecha && !cuando.hora) return { accion: 'agendar', error: '¿Para cuándo? Por ejemplo: agenda reunión con Hexagon mañana a las 10' };
        return {
            accion: 'agendar', lista: 'Mis Cosas', titulo: (titulo || 'Cita').slice(0, 300), prioridad,
            fecha: cuando.fecha || hoy, hora: cuando.hora, minutos: cuando.minutos || 30, invitado, meet
        };
    }

    // Anotar en una lista ("finanzas: …") o en Mis Cosas
    let lista = 'Mis Cosas', cuerpo = texto;
    const conLista = /^(?:lista\s+|anota(?:me|lo)?\s+en\s+|en\s+)?(mis cosas|finanzas|supervision(?: comercial)?|seguimiento(?: de correos)?|correos)\s*[:,–-]\s*/.exec(p);
    if (conLista) {
        const encontrada = LISTA_POR_PALABRA.find(([patron]) => patron.test(conLista[1]));
        lista = encontrada ? encontrada[1] : 'Mis Cosas';
        cuerpo = texto.slice(conLista[0].length);
    } else {
        // Sin el verbo de la orden ("recuérdame…", "anota…"); se busca en el texto sin tildes y se recorta el original
        const verbo = /^(anota(?:me|lo)?|apunta(?:me|lo)?|recuerdame(?:\s+que)?|tengo que|pendiente:?)\s*/.exec(p);
        cuerpo = verbo ? texto.slice(verbo[0].length) : texto;
    }
    const cuando = interpretarCuando(sinPrioridad(cuerpo), hoy);
    // Con hora y sin día: es para hoy
    return { accion: 'anotar', lista: /** @type {string} */ (lista), titulo: (cuando.resto || cuerpo).slice(0, 300), prioridad, fecha: cuando.fecha || (cuando.hora ? hoy : null), hora: cuando.hora };
}

// ----- Datos -----
const fila = (/** @type {any} */ r) => ({
    id: Number(r.id), lista: r.lista, titulo: r.titulo, detalle: r.detalle || '', prioridad: r.prioridad,
    fecha: r.fecha_dia || '', hora: r.hora || '', estado: r.estado, tipo: r.tipo,
    sincronizado: r.sincronizado || '', error: r.error || '', enlace: r.enlace || '', automatico: Boolean(r.origen)
});
const COLUMNAS = "id, lista, titulo, detalle, prioridad, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha_dia, hora, estado, tipo, sincronizado, error, enlace, origen";

/** El umbral de Supervisión Comercial (ajustes 'agendaCeo') */
export async function leerUmbral(/** @type {any} */ pool) {
    const [filas] = await pool.query("SELECT valor FROM ajustes WHERE clave = 'agendaCeo'");
    try {
        const n = filas.length ? Number(JSON.parse(filas[0].valor).umbral) : NaN;
        return Number.isFinite(n) && n > 0 ? n : UMBRAL_SUPERVISION;
    } catch (e) {
        return UMBRAL_SUPERVISION;
    }
}

/**
 * Todo en una vista: las listas (pendientes por prioridad y fecha; lo hecho en los últimos 7 días), el calendario de
 * hoy (Google) y los pendientes del equipo (los da panelCeo.js).
 * @param {any} contexto @param {{ personas: any[] }} equipo
 */
export async function vistaAgenda(contexto, equipo) {
    const { pool, config, usuario } = contexto;
    const [pendientes] = await pool.query(`SELECT ${COLUMNAS} FROM agenda_ceo WHERE usuario_id = ? AND estado = 'pendiente'
        ORDER BY FIELD(prioridad, 'Alta', 'Media', 'Baja'), fecha IS NULL, fecha, hora IS NULL, hora, id`, [usuario.id]);
    const [hechos] = await pool.query(`SELECT ${COLUMNAS} FROM agenda_ceo WHERE usuario_id = ? AND estado = 'hecho' AND hecho >= UTC_TIMESTAMP() - INTERVAL 7 DAY
        ORDER BY hecho DESC LIMIT 20`, [usuario.id]);
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    let calendario = [], avisoCalendario = '';
    try {
        const inicio = inicioDelDia(hoy, config.zonaHoraria);
        calendario = await conGoogle(contexto, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.eventos(token, alRenovar, inicio, new Date(inicio.getTime() + 86400000), 30));
    } catch (error) {
        avisoCalendario = `Sin tu Google Calendar: ${/** @type {Error} */ (error).message}`;
    }
    const listas = Object.fromEntries(LISTAS_CEO.map(l => [l, pendientes.filter((/** @type {any} */ r) => r.lista === l).map(fila)]));
    return {
        ok: true, hoy, listas, nombresListas: LISTAS_CEO, hechos: hechos.map(fila), calendario, avisoCalendario,
        equipo: equipo.personas.filter(p => p.total > 0).slice(0, 8),
        umbral: await leerUmbral(pool)
    };
}

const ejemplos = [
    'finanzas: pagar el ITBIS el viernes (urgente)',
    'agenda reunión con Hexagon mañana a las 3 con compras@hexagon.com',
    'correo a ana@semillasdata.com: Precios de diciembre | Ana, ¿me pasas la lista de precios?',
    'seguimiento a ana@semillasdata.com: ¿pudiste revisarla?',
    'listo: pagar el ITBIS',
    '¿qué tengo hoy?'
];

const fechaLegible = (/** @type {string | null | undefined} */ f, /** @type {string | null | undefined} */ h) => {
    if (!f) return '';
    const [a, m, d] = f.split('-').map(Number);
    const texto = new Date(Date.UTC(a, m - 1, d, 12)).toLocaleDateString('es-DO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    return h ? `${texto} a las ${h}` : texto;
};

/** Inserta un ítem y, si toca Google, su evento en la misma transacción */
async function crearItem(/** @type {any} */ pool, /** @type {any} */ usuario, /** @type {Record<string, any>} */ item, conEvento = false) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        const [r] = await conexion.query(
            'INSERT INTO agenda_ceo (usuario_id, lista, titulo, detalle, prioridad, fecha, hora, tipo, datos, sincronizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [usuario.id, item.lista, item.titulo, item.detalle || null, item.prioridad || 'Media', item.fecha || null, item.hora || null, item.tipo || 'nota',
                item.datos ? JSON.stringify(item.datos) : null, conEvento ? 'pendiente' : '']);
        if (conEvento) await emitirEvento(conexion, { tipo: 'BORJA_CEO_ORDEN', clave: `borja:${r.insertId}`, usuarioId: usuario.id, carga: { itemId: r.insertId } });
        await conexion.commit();
        return r.insertId;
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
}

/**
 * Una orden escrita a Borja: la entiende, hace lo que toca en la base y deja lo de Google en la cola.
 * @param {any} contexto @param {string} texto
 * @returns {Promise<{ accion: string, respuesta: string, id?: number }>}
 */
export async function ordenABorja(contexto, texto) {
    const { pool, config, usuario } = contexto;
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    const orden = interpretarOrden(texto, hoy);
    if (orden.error) return { accion: orden.accion, respuesta: orden.error };
    if (orden.accion === 'ayuda') return { accion: 'ayuda', respuesta: `Puedo anotarte cosas en tus listas (${LISTAS_CEO.join(', ')}), agendarte citas en tu Google Calendar, mandar correos y seguir hilos desde tu Gmail, y decirte qué tienes. Por ejemplo:\n${ejemplos.map(e => `• ${e}`).join('\n')}` };

    if (orden.accion === 'consultar') {
        const [[n]] = await pool.query("SELECT COUNT(*) AS total, SUM(prioridad = 'Alta') AS altas, SUM(fecha IS NOT NULL AND fecha <= ?) AS hoy FROM agenda_ceo WHERE usuario_id = ? AND estado = 'pendiente'", [hoy, usuario.id]);
        return { accion: 'consultar', respuesta: `Tienes ${Number(n.total)} pendientes (${Number(n.altas || 0)} de prioridad alta, ${Number(n.hoy || 0)} para hoy o atrasados). Abajo están tus listas, tu calendario de hoy y lo pendiente del equipo.` };
    }

    if (orden.accion === 'completar') {
        const [abiertos] = await pool.query("SELECT id, titulo FROM agenda_ceo WHERE usuario_id = ? AND estado = 'pendiente' ORDER BY id DESC", [usuario.id]);
        const buscado = plano(String(orden.titulo || '')).trim();
        const encontrado = buscado ? abiertos.find((/** @type {any} */ r) => plano(r.titulo).includes(buscado)) : null;
        if (!encontrado) return { accion: 'completar', respuesta: buscado ? `No encontré «${orden.titulo}» entre tus pendientes.` : '¿Qué terminaste? Por ejemplo: listo: pagar el ITBIS' };
        await pool.query("UPDATE agenda_ceo SET estado = 'hecho', hecho = UTC_TIMESTAMP() WHERE id = ? AND usuario_id = ?", [encontrado.id, usuario.id]);
        return { accion: 'completar', respuesta: `Hecho: «${encontrado.titulo}». ¡Uno menos!`, id: Number(encontrado.id) };
    }

    if (orden.accion === 'agendar') {
        const id = await crearItem(pool, usuario, {
            lista: orden.lista, titulo: orden.titulo, prioridad: orden.prioridad, fecha: orden.fecha, hora: orden.hora, tipo: 'cita',
            detalle: orden.invitado ? `Con ${orden.invitado}` : '', datos: { minutos: orden.minutos, invitado: orden.invitado || '', meet: orden.meet }
        }, true);
        return { accion: 'agendar', id, respuesta: `Agendando «${orden.titulo}» el ${fechaLegible(orden.fecha, orden.hora)}${orden.hora ? '' : ' (todo el día)'} en tu Google Calendar${orden.invitado ? `, con invitación y Meet para ${orden.invitado}` : ''}. Te aviso cuando esté.` };
    }

    if (orden.accion === 'correo') {
        /** @type {any} */
        let hilo = null;
        if (orden.seguimiento) {
            const [previos] = await pool.query("SELECT id, datos, google_id FROM agenda_ceo WHERE usuario_id = ? AND tipo = 'correo' AND google_id IS NOT NULL ORDER BY id DESC", [usuario.id]);
            hilo = previos.find((/** @type {any} */ r) => { try { return JSON.parse(r.datos || '{}').para === orden.para; } catch (e) { return false; } }) || null;
        }
        const anterior = hilo ? JSON.parse(hilo.datos || '{}') : null;
        const asunto = anterior ? `Re: ${String(anterior.asunto || '').replace(/^Re:\s*/i, '')}` : String(orden.asunto || 'Seguimiento');
        try {
            construirCorreo({ para: orden.para, asunto, texto: orden.cuerpo, adjunto: null }); // Lo que no valga, se dice ya
        } catch (error) {
            return { accion: 'correo', respuesta: `No puedo mandar ese correo: ${/** @type {Error} */ (error).message}` };
        }
        const id = await crearItem(pool, usuario, {
            lista: 'Seguimiento de Correos', titulo: orden.titulo, prioridad: orden.prioridad, tipo: 'correo', detalle: orden.cuerpo,
            datos: { para: orden.para, asunto, cuerpo: orden.cuerpo, hilo: hilo ? hilo.google_id : '' }
        }, true);
        return { accion: 'correo', id, respuesta: `Enviando desde tu Gmail a ${orden.para}: «${asunto}»${hilo ? ' (en el mismo hilo)' : ''}. Queda en Seguimiento de Correos hasta que lo des por hecho.` };
    }

    const id = await crearItem(pool, usuario, { lista: orden.lista, titulo: orden.titulo, prioridad: orden.prioridad, fecha: orden.fecha, hora: orden.hora });
    return { accion: 'anotar', id, respuesta: `Anotado en ${orden.lista}: «${orden.titulo}»${orden.fecha ? ` para el ${fechaLegible(orden.fecha, orden.hora)}` : ''}${orden.prioridad === 'Alta' ? ' (prioridad alta)' : ''}.` };
}

/**
 * Alta rápida y cambios de un ítem desde la pantalla. Siempre sobre lo del propio Master.
 * @param {any} contexto @param {any} datos @param {(m: string, e?: number, c?: string) => Error} errorApp
 */
export async function cambiarItem(contexto, datos, errorApp) {
    const { pool, usuario } = contexto;
    if (datos.crear) {
        const c = datos.crear;
        const titulo = String(c.titulo || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!titulo) throw errorApp('Escribe qué hay que hacer');
        if (!LISTAS_CEO.includes(c.lista)) throw errorApp('Elige una de tus listas');
        const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha || '')) ? String(c.fecha) : null;
        const hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.hora || '')) ? String(c.hora) : null;
        return crearItem(pool, usuario, { lista: c.lista, titulo, prioridad: PRIORIDADES.includes(c.prioridad) ? c.prioridad : 'Media', fecha, hora });
    }
    const id = Number(datos.id);
    if (!Number.isInteger(id) || id <= 0) throw errorApp('Falta el ítem');
    const [r] = datos.cambio === 'completar'
        ? await pool.query("UPDATE agenda_ceo SET estado = 'hecho', hecho = UTC_TIMESTAMP() WHERE id = ? AND usuario_id = ?", [id, usuario.id])
        : datos.cambio === 'reabrir'
            ? await pool.query("UPDATE agenda_ceo SET estado = 'pendiente', hecho = NULL WHERE id = ? AND usuario_id = ?", [id, usuario.id])
            : datos.cambio === 'borrar'
                ? await pool.query('DELETE FROM agenda_ceo WHERE id = ? AND usuario_id = ?', [id, usuario.id])
                : [{ affectedRows: -1 }];
    if (r.affectedRows === -1) throw errorApp('Cambio desconocido');
    if (!r.affectedRows) throw errorApp('Ese ítem no está en tu agenda', 404);
    return id;
}

// ----- En segundo plano -----
/** Id fijo del evento de Calendar para un ítem (base32hex): un reintento no crea otro */
export const idEventoCalendar = (/** @type {number} */ itemId) => `borja${crypto.createHash('sha256').update(`agenda_ceo|${itemId}`).digest('hex').slice(0, 26)}`;

/**
 * BORJA_CEO_ORDEN: la cita en el Google Calendar del Master o el correo desde su Gmail. Lo definitivo (sin Google
 * conectado, sin permiso, datos que Google rechaza) queda en el ítem como fallido; lo pasajero se reintenta.
 * @type {import('./eventos.js').Manejador}
 */
export async function alOrdenarABorja(evento, { paso, contexto }) {
    const { pool, config } = contexto;
    const [[item]] = await pool.query(`SELECT ${COLUMNAS}, usuario_id, datos FROM agenda_ceo WHERE id = ?`, [Number(evento.carga.itemId)]);
    if (!item || item.sincronizado === 'hecho') return;
    const [[usuario]] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [item.usuario_id]);
    if (!usuario) return;
    const datos = JSON.parse(item.datos || '{}');
    const ctx = { ...contexto, usuario };
    const fallar = async (/** @type {any} */ error) => {
        if (esPasajero(error)) throw error;
        await pool.query("UPDATE agenda_ceo SET sincronizado = 'fallido', error = ? WHERE id = ?", [String(error.message || error).slice(0, 300), item.id]);
        await registrarAviso(pool, [usuario.id], 'mensaje', `Borja no pudo ${item.tipo === 'cita' ? 'agendar' : 'enviar'} «${item.titulo}»: ${String(error.message || error).slice(0, 200)}`);
        return null;
    };

    if (item.tipo === 'cita') {
        const hecho = await paso('calendario', async () => {
            const zona = config.zonaHoraria;
            const fecha = item.fecha_dia;
            /** @type {Record<string, any>} */
            const cita = {
                id: idEventoCalendar(Number(item.id)),
                summary: item.titulo,
                description: ['Agendado por Borja desde la Torre de control.', item.detalle].filter(Boolean).join('\n'),
                attendees: datos.invitado ? [{ email: datos.invitado }] : []
            };
            if (item.hora) {
                const [h, m] = String(item.hora).split(':').map(Number);
                const inicio = new Date(inicioDelDia(fecha, zona).getTime() + (h * 60 + m) * 60000);
                cita.start = { dateTime: inicio.toISOString(), timeZone: zona };
                cita.end = { dateTime: new Date(inicio.getTime() + (Number(datos.minutos) || 30) * 60000).toISOString(), timeZone: zona };
            } else {
                cita.start = { date: fecha };
                cita.end = { date: sumarDias(fecha, 1) };
            }
            if (datos.meet) cita.conferenceData = { createRequest: { requestId: `borja-${item.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
            try {
                const r = await conGoogle(ctx, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.crearEvento(token, alRenovar, cita, Boolean(datos.meet)));
                await pool.query("UPDATE agenda_ceo SET sincronizado = 'hecho', error = '', google_id = ?, enlace = ? WHERE id = ?", [r.id || cita.id, (r.meet || r.enlace || '').slice(0, 500), item.id]);
                return { id: r.id || cita.id, meet: r.meet || '' };
            } catch (error) {
                // Ya existía (un reintento después de crearla): está hecha
                if (Number(/** @type {any} */ (error).status || /** @type {any} */ (error).code) === 409) {
                    await pool.query("UPDATE agenda_ceo SET sincronizado = 'hecho', error = '', google_id = ? WHERE id = ?", [cita.id, item.id]);
                    return { id: cita.id, meet: '' };
                }
                return fallar(error);
            }
        });
        if (hecho) await paso('aviso', async () => {
            await registrarAviso(pool, [usuario.id], 'reunion', `Borja agendó «${item.titulo}» en tu Google Calendar${hecho.meet ? ` · ${hecho.meet}` : ''}`);
            return true;
        });
        return;
    }

    if (item.tipo === 'correo') {
        const enviado = await paso('correo', async () => {
            try {
                const crudo = construirCorreo({ para: datos.para, asunto: datos.asunto, texto: datos.cuerpo, adjunto: null });
                const r = await conGoogle(ctx, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.enviarCorreoEnHilo(token, alRenovar, crudo, datos.hilo || ''));
                await pool.query("UPDATE agenda_ceo SET sincronizado = 'hecho', error = '', google_id = ? WHERE id = ?", [r.hilo || r.id || null, item.id]);
                return r;
            } catch (error) {
                return fallar(error);
            }
        });
        if (enviado) await paso('aviso', async () => {
            await registrarAviso(pool, [usuario.id], 'mensaje', `Borja envió tu correo a ${datos.para}: «${datos.asunto}»`);
            return true;
        });
    }
}

/**
 * Supervisión Comercial: cada cotización guardada pasa por aquí (flujos.js › REGLAS); si es en US$ y supera el umbral,
 * entra en la lista de cada Master, una sola vez por cotización.
 * @type {import('./eventos.js').Regla}
 */
export const REGLA_SUPERVISION_CEO = {
    nombre: 'Cotización alta: a Supervisión Comercial del CEO',
    modulo: 'cotizaciones',
    cuando: (registro, anterior) => (registro.moneda || 'US$') === 'US$' && Number(registro.total) > 0 && (!anterior || Number(anterior.total || 0) < Number(registro.total)),
    evento: (registro) => ({
        tipo: 'CEO_SUPERVISION',
        clave: `supervision:${String(registro.id).slice(0, 120)}:${Math.round(Number(registro.total))}`,
        carga: { cotizacionId: String(registro.id) }
    })
};

/** @type {import('./eventos.js').Manejador} */
export async function alSupervisarCotizacion(evento, { paso, contexto }) {
    const { pool, config } = contexto;
    const [[filaCot]] = await pool.query("SELECT datos FROM registros WHERE modulo = 'cotizaciones' AND id = ?", [String(evento.carga.cotizacionId || '')]);
    if (!filaCot) return;
    const cot = JSON.parse(filaCot.datos);
    const umbral = await leerUmbral(pool);
    if ((cot.moneda || 'US$') !== 'US$' || !(Number(cot.total) >= umbral)) return;
    const [[filaCliente]] = await pool.query("SELECT datos FROM registros WHERE modulo = 'clientes' AND id = ?", [String(cot.clienteId || '')]);
    const cliente = filaCliente ? JSON.parse(filaCliente.datos) : {};
    await paso('listas', async () => {
        const admins = config.google.admins.length ? config.google.admins : [''];
        const [masters] = await pool.query('SELECT id FROM usuarios WHERE email IN (?)', [admins]);
        const titulo = `Cotización alta: ${cot.numero || ''} · ${cliente.nombre || cot.cliente || 'cliente'} · US$ ${Math.round(Number(cot.total)).toLocaleString('es-DO')} (${cot.casa || ''}, ${String(cot.vendedor || cot.creadoPor || '').split('@')[0]})`.replace(/\s+/g, ' ');
        for (const m of masters) {
            await pool.query(`INSERT IGNORE INTO agenda_ceo (usuario_id, lista, titulo, detalle, prioridad, origen) VALUES (?, 'Supervisión Comercial', ?, ?, 'Alta', ?)`,
                [m.id, titulo.slice(0, 300), `Estado: ${cot.estado || 'Pendiente'}`, `cotizacion:${String(cot.id).slice(0, 170)}`]);
        }
        return { masters: masters.length };
    });
}

/** Guarda el umbral de Supervisión Comercial (US$) */
export async function guardarUmbral(/** @type {any} */ pool, /** @type {number} */ umbral, /** @type {string} */ email) {
    await pool.query(
        `INSERT INTO ajustes (clave, valor, actualizado, actualizado_por) VALUES ('agendaCeo', ?, UTC_TIMESTAMP(), ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = UTC_TIMESTAMP(), actualizado_por = VALUES(actualizado_por)`,
        [JSON.stringify({ umbral }), correo(email)]);
}
