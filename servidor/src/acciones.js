/**
 * Acciones que la app pide al backend: POST /api/accion con { accion, ...datos }.
 * Son las mismas que atendía el Apps Script (sincronizar, crm, sheets, chat, calendar, meet), así
 * la app apenas cambia, más las nuevas: correo, reporte, avisar (Chat + WhatsApp), telefono y equipo.
 *
 * Cada acción recibe (datos, contexto) y devuelve el objeto que se manda a la app ({ ok: true, ... }).
 */
import * as db from './db.js';
import { tokenDe, actualizarToken, olvidarToken, telefonosDelEquipo, guardarTelefono, esAdmin, publico } from './cuentas.js';
import { construirCorreo } from './correo.js';
import { normalizarTelefono } from './avisos.js';
import { conReintentos } from './reintentos.js';

export function errorApp(mensaje, estado = 400, codigo = 'datos') {
    const error = new Error(mensaje);
    error.estado = estado;
    error.codigo = codigo;
    return error;
}

const MAX_CAMBIOS = 500;
const MAX_REGISTRO = 100 * 1024;

function fecha(texto, nombre) {
    const valor = new Date(texto);
    if (Number.isNaN(valor.getTime())) throw errorApp(`Fecha no válida: ${nombre}`);
    return valor;
}

// Llamada a Google con la cuenta de la persona: reintenta lo pasajero y avisa si hay que volver a autorizar
async function conGoogle({ pool, config, usuario }, tarea) {
    const token = tokenDe(usuario, config);
    if (!token) throw errorApp('Conecta tu cuenta de Google para usar esta función', 403, 'google');
    const alRenovar = (nuevo) => actualizarToken(pool, config, usuario.id, nuevo).catch(() => {});
    try {
        return await conReintentos(() => tarea(token, alRenovar));
    } catch (error) {
        const motivo = String((error.response && error.response.data && error.response.data.error) || error.message || '');
        if (/invalid_grant/.test(motivo)) {
            await olvidarToken(pool, usuario.id);
            throw errorApp('Google ya no acepta el permiso de tu cuenta. Vuelve a conectarla.', 403, 'google');
        }
        if (Number(error.code || error.status) === 403 && /insufficient|scope|permission/i.test(motivo)) {
            throw errorApp('Falta un permiso de Google para esto. Vuelve a conectar tu cuenta y acepta todos los permisos.', 403, 'google');
        }
        throw error;
    }
}

function comprobarCambios(lista, nombre) {
    if (lista === undefined) return [];
    if (!Array.isArray(lista)) throw errorApp(`"${nombre}" debe ser una lista`);
    if (lista.length > MAX_CAMBIOS) throw errorApp(`Demasiados cambios a la vez (máximo ${MAX_CAMBIOS})`);
    return lista;
}

export const ACCIONES = {
    // Base de datos compartida: aplica los cambios de la app y devuelve todos los datos
    async sincronizar(datos, { pool, usuario }) {
        const guardar = comprobarCambios(datos.guardar, 'guardar');
        const eliminar = comprobarCambios(datos.eliminar, 'eliminar');
        for (const op of guardar) {
            if (JSON.stringify(op && op.registro || {}).length > MAX_REGISTRO) throw errorApp('Un registro es demasiado grande');
        }
        const todo = await db.sincronizar(pool, { guardar, eliminar }, usuario);
        return { ok: true, datos: todo, hora: new Date().toISOString() };
    },

    async crm(datos, { pool, usuario }) {
        if (JSON.stringify(datos.registro || {}).length > MAX_REGISTRO) throw errorApp('El registro es demasiado grande');
        await db.guardarRegistro(pool, datos.modulo, { ...datos.registro, cuenta: usuario.email }, usuario.id);
        return { ok: true };
    },

    // Métricas del simulador (antes, la pestaña "Métricas" de la hoja)
    async sheets(datos, { pool, usuario }) {
        const { accion, ...metricas } = datos;
        const cuando = metricas.fecha ? fecha(metricas.fecha, 'fecha') : new Date();
        await pool.query('INSERT INTO metricas (fecha, datos, usuario_id) VALUES (?, ?, ?)',
            [cuando, JSON.stringify(metricas).slice(0, 10000), usuario.id]);
        return { ok: true };
    },

    async chat(datos, { avisos }) {
        await avisos.chat(datos.mensaje);
        return { ok: true };
    },

    // Aviso a todo el equipo: Google Chat y WhatsApp a la vez (lo que esté configurado)
    async avisar(datos, { pool, avisos }) {
        const mensaje = String(datos.mensaje || '').trim();
        if (!mensaje) throw errorApp('Mensaje vacío');
        const resultado = { ok: true, chat: null, whatsapp: null };
        if (avisos.chatActivo) {
            resultado.chat = await avisos.chat(mensaje).then(() => 'enviado', (e) => `error: ${e.message}`);
        }
        if (avisos.whatsappActivo) {
            resultado.whatsapp = await avisos.whatsapp(mensaje, await telefonosDelEquipo(pool));
        }
        if (!resultado.chat && !resultado.whatsapp) throw errorApp('Ni Google Chat ni WhatsApp están configurados en el servidor', 503, 'configuracion');
        return resultado;
    },

    // Evento en el calendario de la persona ({ titulo, inicio, fin, descripcion })
    async calendar(datos, contexto) {
        const inicio = datos.inicio ? fecha(datos.inicio, 'inicio') : new Date();
        const fin = datos.fin ? fecha(datos.fin, 'fin') : new Date(inicio.getTime() + contexto.config.minutosReunion * 60000);
        if (fin <= inicio) throw errorApp('La hora de fin debe ser posterior a la de inicio');
        const evento = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearEvento(token, alRenovar, {
            summary: String(datos.titulo || 'Inspección · Semences del Caribe').slice(0, 300),
            description: String(datos.descripcion || '').slice(0, 8000),
            start: { dateTime: inicio.toISOString(), timeZone: contexto.config.zonaHoraria },
            end: { dateTime: fin.toISOString(), timeZone: contexto.config.zonaHoraria }
        }, false));
        return { ok: true, eventoId: evento.id, enlace: evento.enlace };
    },

    // Reunión que empieza ahora, con enlace real de Google Meet
    async meet(datos, contexto) {
        const inicio = new Date();
        const fin = new Date(inicio.getTime() + contexto.config.minutosReunion * 60000);
        const evento = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearEvento(token, alRenovar, {
            summary: String(datos.titulo || 'Reunión del equipo · Semences del Caribe').slice(0, 300),
            start: { dateTime: inicio.toISOString(), timeZone: contexto.config.zonaHoraria },
            end: { dateTime: fin.toISOString(), timeZone: contexto.config.zonaHoraria },
            conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        }, true));
        if (!evento.meet) throw errorApp('Google Calendar no devolvió el enlace de Meet', 502, 'google');
        return { ok: true, meetUrl: evento.meet, eventoId: evento.id };
    },

    // Correo desde el Gmail de la persona ({ para, asunto, texto, adjunto: { nombre, tipo, base64 } })
    async correo(datos, contexto) {
        const crudo = construirCorreo(datos);
        const id = await conGoogle(contexto, (token, alRenovar) => contexto.google.enviarCorreo(token, alRenovar, crudo));
        return { ok: true, id };
    },

    // Reporte PDF desde la plantilla de Google Docs ({ titulo, campos: { nombre: valor } })
    async reporte(datos, contexto) {
        const plantillaId = datos.plantillaId || contexto.config.reportes.plantillaId;
        if (!plantillaId) throw errorApp('No hay plantilla de reporte configurada (REPORTE_PLANTILLA_ID)', 503, 'configuracion');
        if (!/^[\w-]{20,100}$/.test(plantillaId)) throw errorApp('El id de la plantilla no es válido');
        const campos = datos.campos && typeof datos.campos === 'object' && !Array.isArray(datos.campos) ? datos.campos : {};
        if (Object.keys(campos).length > 100) throw errorApp('Demasiados campos (máximo 100)');
        for (const campo of Object.keys(campos)) if (!/^[\wáéíóúñÁÉÍÓÚÑ]{1,40}$/.test(campo)) throw errorApp(`Nombre de campo no válido: ${campo}`);
        const titulo = String(datos.titulo || 'Reporte · Semences del Caribe').replace(/[\r\n/\\]/g, ' ').slice(0, 150);
        const archivo = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearReporte(token, alRenovar, {
            plantillaId, carpetaId: contexto.config.reportes.carpetaId, titulo, campos
        }));
        return { ok: true, archivoId: archivo.id, enlace: archivo.enlace };
    },

    // Mi número de WhatsApp para recibir los avisos ('' para dejar de recibirlos)
    async telefono(datos, { pool, usuario, config }) {
        const texto = String(datos.telefono || '').trim();
        const telefono = texto ? normalizarTelefono(texto) : '';
        if (texto && !telefono) throw errorApp('Teléfono no válido. Escríbelo con código de país o como 809, 829 u 849 + 7 cifras.');
        await guardarTelefono(pool, usuario.id, telefono);
        return { ok: true, usuario: publico({ ...usuario, telefono }, config) };
    },

    // Gestión del equipo (solo ADMINS): quién puede entrar además del dominio, y sus teléfonos
    async equipo(datos, { pool, usuario, config }) {
        if (!esAdmin(config, usuario.email)) throw errorApp('Solo un administrador puede gestionar el equipo', 403, 'acceso');
        const email = String(datos.email || '').trim().toLowerCase();
        if (datos.operacion === 'guardar' || datos.operacion === 'quitar') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw errorApp('Correo no válido');
        }
        if (datos.operacion === 'guardar') {
            const telefono = datos.telefono ? normalizarTelefono(datos.telefono) : '';
            if (datos.telefono && !telefono) throw errorApp('Teléfono no válido');
            await pool.query(
                `INSERT INTO equipo (email, nombre, telefono, notas) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), telefono = VALUES(telefono), notas = VALUES(notas)`,
                [email, String(datos.nombre || '').slice(0, 200), telefono, String(datos.notas || '').slice(0, 500)]);
        } else if (datos.operacion === 'quitar') {
            await pool.query('DELETE FROM equipo WHERE email = ?', [email]);
            // Quien ya no está en el equipo pierde también sus sesiones abiertas
            await pool.query('DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.email = ?', [email]);
        } else if (datos.operacion !== 'listar') {
            throw errorApp('Operación desconocida (listar, guardar o quitar)');
        }
        const [filas] = await pool.query('SELECT email, nombre, telefono, notas FROM equipo ORDER BY email');
        return { ok: true, equipo: filas };
    }
};
