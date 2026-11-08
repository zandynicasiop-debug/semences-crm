// @ts-check
/**
 * Lote B: Torre de control del Master (acción "panelCeo"). Solo los Master (ADMINS) entran; nadie más la ve.
 *
 * Operaciones:
 * - radar: cada persona del equipo con lo que tiene pendiente (cotizaciones abiertas y pedidos por cerrar con sus US$,
 *   clientes en Reunión, tareas vencidas y si su reporte semanal la tiene bloqueada, el HTTP 423).
 * - revision { email, inicio? }: una revisión por Google Meet con esa persona en el primer hueco libre del Master (o a
 *   la hora indicada), con la invitación de Google y la lista de pendientes; le llega también a su campana.
 * - briefings: el resumen de las 7:00 de hoy, persona por persona: si salió, por dónde, y en WhatsApp si se entregó y se
 *   leyó (lo avisa Meta). reenviar { pais: RD | VE | todos }: lo vuelve a generar y enviar ahora.
 * - borja { activas? }: qué secciones lleva el resumen (leer o guardar). resumenGlobal { enviar? }: el consolidado de
 *   RD y VE (ventas en US$ y miles, cotizaciones abiertas, pedidos por cerrar, recompras vencidas, clientes en Reunión,
 *   dormidos y reportes bloqueados); con enviar, también a la campana, el push y el correo del Master.
 * - mensajes { mensajes? }: los textos, asuntos y horas de los mensajes automáticos, y la plantilla de WhatsApp de cada
 *   uno (solo entre las aprobadas en Meta).
 */
import crypto from 'node:crypto';
import * as db from './db.js';
import { ambitoDe, PAISES } from './permisos.js';
import { ejecutorDe, correo, ESTADOS_VENTA, totalUsd } from './pedidos.js';
import { clientesDormidos } from './campo.js';
import { semanaBloqueada } from './reportes.js';
import { resumirPersona } from './resumen.js';
import { primerHuecoLibre } from './flujos.js';
import { conGoogle } from './llamadasGoogle.js';
import { registrarAviso } from './campana.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { construirCorreo } from './correo.js';
import { enZona, inicioDelDia } from './fechas.js';
import { auditar } from './auditoria.js';
import { CATALOGO, VARIABLES, SECCIONES_BORJA, leerMensajes, leerBorja, validarMensajes, guardarAjuste } from './mensajes.js';

const ABIERTAS = ['Pendiente', 'Aprobada'];
const normal = (/** @type {unknown} */ t) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
const redondo = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/** Las personas aprobadas del equipo (sin los Master), por nombre */
async function equipo(/** @type {any} */ pool, /** @type {any} */ config) {
    const [filas] = await pool.query("SELECT * FROM usuarios WHERE estado = 'aprobado' ORDER BY nombre, email");
    return filas.filter((/** @type {any} */ p) => !ambitoDe(p, config).master);
}

/**
 * Lo pendiente de una persona, con los datos de todo el CRM.
 * @param {any} persona @param {Record<string, any[]>} datos @param {string} hoy
 */
export function pendientesDe(persona, datos, hoy) {
    const email = correo(persona.email);
    const fichas = new Map((datos.clientes || []).map(c => [String(c.id), c]));
    const cotizaciones = (datos.cotizaciones || []).filter(c => ejecutorDe(c) === email && ABIERTAS.includes(c.estado || 'Pendiente'));
    const pedidos = (datos.pedidos || []).filter(p => p.estado === 'Cotizado' && ejecutorDe(p, fichas.get(String(p.clienteId)) || null) === email);
    const reuniones = (datos.clientes || []).filter(c => c.etapa === 'Reunión' && correo(c.asignado || c.creadoPor || c.cuenta) === email);
    const yo = [normal(persona.nombre), normal(email), normal(email.split('@')[0])].filter(Boolean);
    const tareas = (datos.tareas || []).filter(t => !t.hecha && t.vence && t.vence < hoy && yo.includes(normal(t.para)));
    return {
        cotizaciones: { n: cotizaciones.length, usd: redondo(cotizaciones.filter(c => (c.moneda || 'US$') === 'US$').reduce((s, c) => s + (Number(c.total) || 0), 0)) },
        pedidos: { n: pedidos.length, usd: redondo(pedidos.reduce((s, p) => s + totalUsd(p), 0)) },
        reuniones: reuniones.length,
        tareasVencidas: tareas.length,
        detalle: [
            ...cotizaciones.slice(0, 5).map(c => `Cotización ${c.numero || ''} · ${(fichas.get(String(c.clienteId)) || {}).nombre || c.cliente || ''} (${c.estado || 'Pendiente'})`),
            ...pedidos.slice(0, 5).map(p => `Pedido por cerrar · ${(fichas.get(String(p.clienteId)) || {}).nombre || p.cliente || ''} · ${p.variedad || ''}`),
            ...reuniones.slice(0, 5).map(c => `Cliente en Reunión · ${c.nombre}`),
            ...tareas.slice(0, 5).map(t => `Tarea vencida · ${t.titulo}`)
        ].map(l => l.replace(/\s+/g, ' ').trim())
    };
}

/** Plantillas de WhatsApp que se pueden elegir: las aprobadas en Meta o, sin la cuenta, las configuradas en el servidor */
async function plantillasWhatsapp(/** @type {any} */ contexto) {
    const { config, avisos } = contexto;
    let aviso = '';
    if (avisos && avisos.plantillasAprobadas) {
        try {
            const aprobadas = await avisos.plantillasAprobadas();
            if (Array.isArray(aprobadas)) return { plantillas: aprobadas.map(p => ({ ...p, verificada: true })), aviso };
        } catch (error) {
            aviso = `No se pudo leer la lista de Meta (${/** @type {Error} */ (error).message}): se muestran las configuradas en el servidor.`;
        }
    }
    const w = config.whatsapp || {};
    const plantillas = [
        w.plantilla && { nombre: w.plantilla, idioma: w.idioma || '', variables: 1, verificada: false },
        w.plantillaResumen && { nombre: w.plantillaResumen, idioma: w.idioma || '', variables: 7, verificada: false }
    ].filter(Boolean);
    if (!aviso && !w.cuentaId) aviso = 'Sin WHATSAPP_CUENTA_ID solo se ofrecen las plantillas configuradas en el servidor (sin verificar con Meta).';
    return { plantillas, aviso };
}

/**
 * Consolidado de RD y VE (y el total) con todo el CRM.
 * @param {Record<string, any[]>} datos @param {string} hoy @param {Record<string, number>} bloqueadosPorPais
 */
export function consolidado(datos, hoy, bloqueadosPorPais = {}) {
    const mes = hoy.slice(0, 7);
    const vacio = () => ({ ventasUsd: 0, ventasMiles: 0, pedidosVenta: 0, cotizacionesAbiertas: 0, cotizacionesUsd: 0, pedidosPorCerrar: 0, pedidosPorCerrarUsd: 0, recomprasVencidas: 0, clientesEnReunion: 0, dormidos: 0, reportesBloqueados: 0 });
    /** @type {Record<string, ReturnType<typeof vacio>>} */
    const paises = Object.fromEntries(PAISES.map(p => [p, vacio()]));
    const de = (/** @type {any} */ pais) => paises[pais] || null;
    for (const p of datos.pedidos || []) {
        const c = de(p.pais);
        if (!c) continue;
        if (ESTADOS_VENTA.includes(p.estado) && String(p.fecha || '').startsWith(mes)) {
            c.ventasUsd += totalUsd(p);
            c.ventasMiles += Number(p.semillasMiles) || 0;
            c.pedidosVenta++;
        }
        if (p.estado === 'Cotizado') {
            c.pedidosPorCerrar++;
            c.pedidosPorCerrarUsd += totalUsd(p);
            if (p.recompraDe && String(p.fecha || '') <= hoy) c.recomprasVencidas++;
        }
    }
    for (const q of datos.cotizaciones || []) {
        const c = de(q.pais);
        if (!c || !ABIERTAS.includes(q.estado || 'Pendiente')) continue;
        c.cotizacionesAbiertas++;
        if ((q.moneda || 'US$') === 'US$') c.cotizacionesUsd += Number(q.total) || 0;
    }
    for (const f of datos.clientes || []) { const c = de(f.pais); if (c && f.etapa === 'Reunión') c.clientesEnReunion++; }
    for (const d of clientesDormidos(datos, hoy)) { const c = de(d.pais); if (c) c.dormidos++; }
    for (const [pais, n] of Object.entries(bloqueadosPorPais)) { const c = de(pais); if (c) c.reportesBloqueados = n; }
    const total = vacio();
    for (const c of Object.values(paises)) {
        for (const k of /** @type {(keyof ReturnType<typeof vacio>)[]} */ (Object.keys(total))) total[k] += c[k];
        c.ventasUsd = redondo(c.ventasUsd); c.cotizacionesUsd = redondo(c.cotizacionesUsd); c.pedidosPorCerrarUsd = redondo(c.pedidosPorCerrarUsd); c.ventasMiles = redondo(c.ventasMiles);
    }
    total.ventasUsd = redondo(total.ventasUsd); total.cotizacionesUsd = redondo(total.cotizacionesUsd); total.pedidosPorCerrarUsd = redondo(total.pedidosPorCerrarUsd); total.ventasMiles = redondo(total.ventasMiles);
    return { mes, paises, total };
}

const usd = (/** @type {number} */ n) => `US$ ${Math.round(n).toLocaleString('es-DO')}`;

/** El consolidado en texto (campana, push y correo del Master) */
export function textoConsolidado(/** @type {ReturnType<typeof consolidado>} */ r) {
    const linea = (/** @type {string} */ nombre, /** @type {any} */ c) => `${nombre}: ventas ${usd(c.ventasUsd)} (${c.ventasMiles.toLocaleString('es-DO')} mil semillas) · `
        + `${c.cotizacionesAbiertas} cotizaciones abiertas (${usd(c.cotizacionesUsd)}) · ${c.pedidosPorCerrar} pedidos por cerrar (${usd(c.pedidosPorCerrarUsd)}) · `
        + `${c.recomprasVencidas} recompras vencidas · ${c.clientesEnReunion} clientes en Reunión · ${c.dormidos} dormidos · ${c.reportesBloqueados} reportes bloqueados`;
    return [`📊 Resumen global de Borja (${r.mes})`, linea('🇩🇴 RD', r.paises.RD), linea('🇻🇪 Venezuela', r.paises.VE), linea('Total', r.total)].join('\n');
}

/**
 * @param {any} datos
 * @param {any} contexto
 * @param {{ errorApp: (mensaje: string, estado?: number, codigo?: string) => Error }} herramientas
 */
export async function accionPanelCeo(datos, contexto, { errorApp }) {
    const { pool, config, usuario, ambito, red } = contexto;
    if (!ambito.master) throw errorApp('La Torre de control es solo del Master', 403, 'acceso');
    const op = datos.operacion || 'radar';
    const ahora = new Date();
    const hoy = enZona(ahora, config.zonaHoraria).fecha;

    if (op === 'radar') {
        const todo = await db.listarTodo(pool);
        const personas = [];
        for (const p of await equipo(pool, config)) {
            const a = ambitoDe(p, config);
            const pendientes = pendientesDe(p, todo, hoy);
            const reporteBloqueado = await semanaBloqueada(pool, config, p, ahora);
            personas.push({
                email: p.email, nombre: p.nombre || p.email, cargo: a.cargo, paises: a.paises, casas: a.casas,
                ...pendientes, reporteBloqueado,
                total: pendientes.cotizaciones.n + pendientes.pedidos.n + pendientes.reuniones + pendientes.tareasVencidas + (reporteBloqueado ? 1 : 0)
            });
        }
        personas.sort((x, y) => y.total - x.total || x.nombre.localeCompare(y.nombre, 'es'));
        return { ok: true, hoy, personas };
    }

    if (op === 'revision') {
        const [[persona]] = await pool.query("SELECT * FROM usuarios WHERE email = ? AND estado = 'aprobado'", [correo(datos.email)]);
        if (!persona) throw errorApp('Esa persona no está en el equipo', 404);
        const minutos = config.minutosReunion || 30;
        let inicio;
        if (datos.inicio) {
            const pedido = new Date(String(datos.inicio));
            if (Number.isNaN(pedido.getTime()) || pedido.getTime() < ahora.getTime()) throw errorApp('Elige una hora que no haya pasado');
            inicio = pedido;
        } else {
            const desde = inicioDelDia(hoy, config.zonaHoraria);
            const ocupado = await conGoogle(contexto, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.ocupado(token, alRenovar, desde, new Date(desde.getTime() + 15 * 86400000)));
            const hueco = primerHuecoLibre({ ocupado, ahora, zona: config.zonaHoraria, minutos });
            if (!hueco) throw errorApp('No hay huecos libres en tu agenda en los próximos 5 días laborables: elige la hora a mano', 409, 'agenda');
            inicio = new Date(hueco.inicio);
        }
        const fin = new Date(inicio.getTime() + minutos * 60000);
        const { detalle } = pendientesDe(persona, await db.listarTodo(pool), hoy);
        const nombre = persona.nombre || persona.email;
        const evento = await conGoogle(contexto, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.crearEvento(token, alRenovar, {
            summary: `Revisión de pendientes · ${nombre}`,
            description: ['Revisión con la dirección (Torre de control).', '', ...(detalle.length ? detalle.map(d => `• ${d}`) : ['Sin pendientes en el CRM.'])].join('\n'),
            start: { dateTime: inicio.toISOString(), timeZone: config.zonaHoraria },
            end: { dateTime: fin.toISOString(), timeZone: config.zonaHoraria },
            attendees: [{ email: persona.email }],
            conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        }, true));
        const cuando = inicio.toLocaleString(persona.idioma === 'en' ? 'en-US' : 'es-DO', { timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
        await registrarAviso(pool, [persona.id], 'reunion', `${usuario.nombre || usuario.email} agendó una revisión de tus pendientes por Meet: ${cuando}${evento.meet ? ` · ${evento.meet}` : ''}`);
        await auditar(pool, config, { usuario, accion: 'crear', modulo: 'panelCeo', objeto: persona.email, resumen: `Revisión por Meet con ${nombre} (${inicio.toISOString()})`, red });
        return { ok: true, inicio: inicio.toISOString(), fin: fin.toISOString(), meet: evento.meet || '', enlace: evento.enlace || '' };
    }

    if (op === 'briefings') {
        const [personas] = await pool.query(
            `SELECT id, email, nombre, estado, cargo, paises, casas, resumen_activo, resumen_canal, resumen_enviado,
                    DATE_FORMAT(resumen_fecha, '%Y-%m-%d') AS resumen_dia
             FROM usuarios WHERE estado = 'aprobado' OR email IN (?) ORDER BY nombre, email`,
            [config.google.admins.length ? config.google.admins : ['']]);
        const [filas] = await pool.query(
            "SELECT usuario_id, canal, estado, enviado, entregado, leido, error FROM cola_avisos WHERE origen = 'resumen' AND creado >= ? ORDER BY id",
            [inicioDelDia(hoy, config.zonaHoraria)]);
        const mensajes = await leerMensajes(pool);
        const hora = mensajes.resumen.hora !== null && mensajes.resumen.hora !== undefined ? mensajes.resumen.hora : config.resumenHora;
        const iso = (/** @type {any} */ f) => (f ? new Date(f).toISOString() : '');
        return {
            ok: true, hoy, hora,
            personas: personas.map((/** @type {any} */ p) => ({
                email: p.email, nombre: p.nombre || p.email, cargo: ambitoDe(p, config).cargo, paises: ambitoDe(p, config).paises,
                activo: Boolean(p.resumen_activo), hoyEnviado: p.resumen_dia === hoy, canal: p.resumen_dia === hoy ? p.resumen_canal : '',
                enviado: p.resumen_dia === hoy ? iso(p.resumen_enviado) : '',
                entregas: filas.filter((/** @type {any} */ f) => f.usuario_id === p.id).map((/** @type {any} */ f) => ({
                    canal: f.canal, estado: f.estado, enviado: iso(f.enviado), entregado: iso(f.entregado), leido: iso(f.leido), error: f.error || ''
                }))
            }))
        };
    }

    if (op === 'reenviar') {
        const pais = String(datos.pais || 'todos');
        if (!['RD', 'VE', 'todos'].includes(pais)) throw errorApp('Elige RD, VE o todos');
        const [candidatos] = await pool.query("SELECT * FROM usuarios WHERE resumen_activo = 1 AND (estado = 'aprobado' OR email IN (?)) ORDER BY nombre, email",
            [config.google.admins.length ? config.google.admins : ['']]);
        const elegidos = candidatos.filter((/** @type {any} */ p) => pais === 'todos' || ambitoDe(p, config).paises.includes(pais));
        const todo = await db.listarTodo(pool);
        const ajustes = { mensajes: await leerMensajes(pool), borja: await leerBorja(pool) };
        const resultado = [];
        for (const p of elegidos) {
            await pool.query('UPDATE usuarios SET resumen_fecha = ? WHERE id = ?', [hoy, p.id]);
            try {
                resultado.push({ email: p.email, canal: await resumirPersona(contexto, p, todo, hoy, ajustes) });
            } catch (error) {
                resultado.push({ email: p.email, canal: null, error: /** @type {Error} */ (error).message });
            }
        }
        await auditar(pool, config, { usuario, accion: 'enviar', modulo: 'panelCeo', objeto: pais, resumen: `Reenvío del briefing (${pais}): ${resultado.filter(r => r.canal).length} de ${resultado.length}`, red });
        return { ok: true, pais, enviados: resultado.filter(r => r.canal).length, personas: resultado };
    }

    if (op === 'borja') {
        if (datos.activas !== undefined) {
            const activas = datos.activas && typeof datos.activas === 'object' ? datos.activas : {};
            const secciones = Object.fromEntries(Object.keys(SECCIONES_BORJA).map(s => [s, activas[s] !== false]));
            if (!Object.values(secciones).some(Boolean)) throw errorApp('Deja al menos una sección en el resumen de Borja');
            await guardarAjuste(pool, 'borja', { secciones }, usuario.email);
            await auditar(pool, config, { usuario, accion: 'modificar', modulo: 'ajustes', objeto: 'borja', resumen: 'Secciones del resumen de Borja', cambios: secciones, red });
        }
        return { ok: true, secciones: SECCIONES_BORJA, activas: await leerBorja(pool) };
    }

    if (op === 'resumenGlobal') {
        const todo = await db.listarTodo(pool);
        /** @type {Record<string, number>} */
        const bloqueados = {};
        for (const p of await equipo(pool, config)) {
            if (!(await semanaBloqueada(pool, config, p, ahora))) continue;
            for (const pais of ambitoDe(p, config).paises) bloqueados[pais] = (bloqueados[pais] || 0) + 1;
        }
        const r = consolidado(todo, hoy, bloqueados);
        const texto = textoConsolidado(r);
        const enviadoPor = [];
        if (datos.enviar) {
            await registrarAviso(pool, [usuario.id], 'meta', texto.replace(/^📊\s*/, '').replace(/\n/g, ' · '));
            enviadoPor.push('campana');
            const { huellas } = await destinosDe(pool, [usuario.id]);
            if (contexto.avisos && contexto.avisos.pushActivo && huellas.length) {
                await encolar(pool, 'push', huellas, texto, null, null, { origen: 'global', usuarioId: usuario.id });
                enviadoPor.push('push');
            }
            if (usuario.token_google) {
                try {
                    const crudo = construirCorreo({ para: usuario.email, asunto: `📊 Resumen global de Borja · ${hoy}`, texto: `${texto}\n\nBorja · Semences del Caribe`, adjunto: null });
                    await conGoogle(contexto, (/** @type {string} */ token, /** @type {any} */ alRenovar) => contexto.google.enviarCorreo(token, alRenovar, crudo));
                    enviadoPor.push('correo');
                } catch (error) { /* Sin Gmail conectado: queda en la campana y en la pantalla */ }
            }
        }
        return { ok: true, ...r, texto, enviadoPor };
    }

    if (op === 'mensajes') {
        const { plantillas, aviso } = await plantillasWhatsapp(contexto);
        if (datos.mensajes !== undefined) {
            const r = validarMensajes(datos.mensajes, plantillas);
            if ('error' in r) throw errorApp(r.error);
            await guardarAjuste(pool, 'mensajes', r.mensajes, usuario.email);
            await auditar(pool, config, { usuario, accion: 'modificar', modulo: 'ajustes', objeto: 'mensajes', resumen: 'Mensajes automáticos', cambios: r.mensajes, red });
        }
        return {
            ok: true, mensajes: await leerMensajes(pool), variables: VARIABLES, plantillas, aviso,
            catalogo: Object.fromEntries(Object.entries(CATALOGO).map(([c, d]) => [c, { nombre: d.nombre, descripcion: d.descripcion, variables: d.variables, asunto: d.asunto, hora: d.hora, whatsapp: d.whatsapp, porDefecto: d.porDefecto }])),
            horasServidor: { resumen: config.resumenHora, recordatorio: config.reporteHora }
        };
    }

    throw errorApp('Operación desconocida de la Torre de control');
}
