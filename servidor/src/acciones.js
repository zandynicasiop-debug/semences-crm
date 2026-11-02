/**
 * Acciones que la app pide al backend: POST /api/accion con { accion, ...datos }.
 * Son las mismas que atendía el Apps Script (sincronizar, crm, sheets, chat, calendar, meet), así
 * la app apenas cambia, más las nuevas: correo, reporte, avisar (Chat + WhatsApp), telefono y equipo.
 *
 * Cada acción recibe (datos, contexto) y devuelve el objeto que se manda a la app ({ ok: true, ... }).
 */
import * as db from './db.js';
import { tokenDe, actualizarToken, olvidarToken, telefonosDelEquipo, guardarTelefono, esAdmin, publico,
    guardarSuscripcion, borrarSuscripcion, suscripcionesDelEquipo, tieneSuscripcion, destinosDe } from './cuentas.js';
import { ambitoDe, puedeEscribir, puedeLeer, dentroDelAmbito, filtrarDatos, asignacionValida, PAISES, CASAS, CARGOS, NOMBRE_PAIS } from './permisos.js';
import { construirCorreo, destinatarios } from './correo.js';
import { pestanasDe } from './exportar.js';
import { normalizarTelefono, suscripcionValida } from './avisos.js';
import { conReintentos } from './reintentos.js';
import { encolar, estadoCola } from './cola.js';

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
export async function conGoogle({ pool, config, usuario }, tarea) {
    const token = tokenDe(usuario, config);
    if (!token) throw errorApp('Conecta tu cuenta de Google para usar esta función', 403, 'google');
    const alRenovar = (nuevo) => actualizarToken(pool, config, usuario, nuevo).catch(() => {});
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

// Aviso por WhatsApp a un cliente de que le llegó un correo o una invitación (si hay plantilla de clientes).
// Devuelve true si quedó en la cola
async function avisarCliente({ pool, avisos, config }, telefono, texto) {
    if (!telefono || !avisos.whatsappClientesActivo) return false;
    const numero = normalizarTelefono(telefono);
    if (!numero) return false;
    return (await encolar(pool, 'whatsapp', [numero], texto, config.whatsapp.plantillaClientes)) > 0;
}

const horaLocal = (fecha, config) => fecha.toLocaleString('es-DO', { timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

// Persona aprobada del equipo por su correo (para mensajes directos y pasar clientes)
async function personaDelEquipo({ pool, usuario, config }, correo) {
    const email = String(correo || '').trim().toLowerCase();
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    const persona = filas[0];
    if (!persona || ambitoDe(persona, config).estado !== 'aprobado') throw errorApp('Esa persona no está en el equipo', 404);
    if (persona.id === usuario.id) throw errorApp('No puedes enviártelo a ti');
    return persona;
}

// Guarda el mensaje en la bandeja de la persona y le avisa por push y WhatsApp
async function enviarDirecto({ pool, usuario, avisos }, destino, tipo, texto, enlace) {
    await pool.query('INSERT INTO directos (de_id, para_id, tipo, texto, enlace) VALUES (?, ?, ?, ?, ?)', [usuario.id, destino.id, tipo, texto, enlace]);
    const { huellas, telefonos } = await destinosDe(pool, [destino.id]);
    const iconos = { mensaje: '💬', reunion: '📹', cliente: '🤝', tarea: '📋' };
    const aviso = `${iconos[tipo] || '💬'} ${usuario.nombre || usuario.email}\n${texto}${enlace ? `\n${enlace}` : ''}`;
    if (avisos.pushActivo) await encolar(pool, 'push', huellas, aviso);
    if (avisos.whatsappActivo) await encolar(pool, 'whatsapp', telefonos, aviso);
}

function comprobarCambios(lista, nombre) {
    if (lista === undefined) return [];
    if (!Array.isArray(lista)) throw errorApp(`"${nombre}" debe ser una lista`);
    if (lista.length > MAX_CAMBIOS) throw errorApp(`Demasiados cambios a la vez (máximo ${MAX_CAMBIOS})`);
    return lista;
}

export const ACCIONES = {
    // Base de datos compartida: aplica los cambios de la app y devuelve los datos que la persona puede ver
    // (según su cargo, países y casas comerciales). Lo que no puede escribir se rechaza entero
    async sincronizar(datos, { pool, usuario, ambito }) {
        const guardar = comprobarCambios(datos.guardar, 'guardar');
        const eliminar = comprobarCambios(datos.eliminar, 'eliminar');
        for (const op of guardar) {
            if (JSON.stringify(op && op.registro || {}).length > MAX_REGISTRO) throw errorApp('Un registro es demasiado grande');
        }
        const todo = await db.sincronizar(pool, { guardar, eliminar }, usuario, (modulo, registro) => puedeEscribir(ambito, modulo, registro));
        return { ok: true, datos: filtrarDatos(todo, ambito), hora: new Date().toISOString() };
    },

    async crm(datos, { pool, usuario, ambito }) {
        if (JSON.stringify(datos.registro || {}).length > MAX_REGISTRO) throw errorApp('El registro es demasiado grande');
        await db.sincronizar(pool, { guardar: [{ modulo: datos.modulo, registro: datos.registro }] }, usuario, (m, r) => puedeEscribir(ambito, m, r));
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

    // Aviso a todo el equipo: Google Chat, WhatsApp y push a la vez (lo que esté configurado)
    async avisar(datos, contexto) {
        const { pool, avisos, usuario } = contexto;
        const mensaje = String(datos.mensaje || '').trim();
        if (!mensaje) throw errorApp('Mensaje vacío');
        const resultado = { ok: true, chat: null, whatsapp: null, push: null };
        if (avisos.chatActivo) {
            resultado.chat = await avisos.chat(mensaje).then(() => 'enviado', (e) => `error: ${e.message}`);
        }
        if (avisos.whatsappActivo) {
            // No se espera a Meta: los mensajes salen de la cola en segundos (y se reintentan si Meta falla)
            resultado.whatsapp = { encolados: await encolar(pool, 'whatsapp', await telefonosDelEquipo(pool, contexto.config), mensaje) };
        }
        if (avisos.pushActivo) {
            resultado.push = { encolados: await encolar(pool, 'push', await suscripcionesDelEquipo(pool, contexto.config, usuario.id), mensaje) };
        }
        if (!resultado.chat && !resultado.whatsapp && !resultado.push) throw errorApp('No hay ningún canal de avisos configurado en el servidor (Google Chat, WhatsApp o push)', 503, 'configuracion');
        return resultado;
    },

    /**
     * Evento en el calendario de la persona ({ titulo, inicio, fin, descripcion }). Opcional:
     * invitados (correos: Google les manda la invitación), conMeet (sala de Meet) y whatsapp (teléfono
     * del cliente invitado, para avisarle por WhatsApp de que tiene la invitación en el correo).
     */
    async calendar(datos, contexto) {
        const inicio = datos.inicio ? fecha(datos.inicio, 'inicio') : new Date();
        const fin = datos.fin ? fecha(datos.fin, 'fin') : new Date(inicio.getTime() + contexto.config.minutosReunion * 60000);
        if (fin <= inicio) throw errorApp('La hora de fin debe ser posterior a la de inicio');
        const invitados = datos.invitados && [].concat(datos.invitados).filter(Boolean).length ? destinatarios(datos.invitados) : [];
        const titulo = String(datos.titulo || 'Inspección · Semences del Caribe').slice(0, 300);
        const evento = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearEvento(token, alRenovar, {
            summary: titulo,
            description: String(datos.descripcion || '').slice(0, 8000),
            start: { dateTime: inicio.toISOString(), timeZone: contexto.config.zonaHoraria },
            end: { dateTime: fin.toISOString(), timeZone: contexto.config.zonaHoraria },
            ...(invitados.length ? { attendees: invitados.map(email => ({ email })) } : {}),
            ...(datos.conMeet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {})
        }, Boolean(datos.conMeet)));
        const whatsapp = invitados.length && await avisarCliente(contexto, datos.whatsapp,
            `Le enviamos por correo (${invitados[0]}) la invitación a "${titulo}" el ${horaLocal(inicio, contexto.config)}${evento.meet ? ', por videollamada de Google Meet' : ''}.`);
        return { ok: true, eventoId: evento.id, enlace: evento.enlace, meetUrl: evento.meet || '', avisoWhatsapp: Boolean(whatsapp) };
    },

    // ¿Está ocupada esa hora en el calendario de la persona? ({ inicio, fin }) → { ocupado: [{ inicio, fin }] }
    async disponibilidad(datos, contexto) {
        const inicio = fecha(datos.inicio, 'inicio');
        const fin = fecha(datos.fin, 'fin');
        if (fin <= inicio || fin - inicio > 31 * 86400000) throw errorApp('Intervalo de fechas no válido');
        const ocupado = await conGoogle(contexto, (token, alRenovar) => contexto.google.ocupado(token, alRenovar, inicio, fin));
        return { ok: true, ocupado };
    },

    // Todo el CRM a una hoja de Google Sheets de la persona (la misma hoja cada vez, reescrita)
    async exportar(datos, contexto) {
        const { pool, usuario } = contexto;
        const pestanas = pestanasDe(filtrarDatos(await db.listarTodo(pool), contexto.ambito));
        const hoja = await conGoogle(contexto, (token, alRenovar) => contexto.google.exportarHoja(token, alRenovar, {
            hojaId: usuario.hoja_exportacion, titulo: 'Semences del Caribe · CRM', pestanas
        }));
        if (hoja.id !== usuario.hoja_exportacion) await pool.query('UPDATE usuarios SET hoja_exportacion = ? WHERE id = ?', [hoja.id, usuario.id]);
        return { ok: true, hojaId: hoja.id, enlace: hoja.enlace, filas: Object.fromEntries(pestanas.map(p => [p.nombre, p.filas.length - 1])) };
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

    // Correo desde el Gmail de la persona ({ para, asunto, texto, adjunto: { nombre, tipo, base64 } }).
    // Con whatsapp (teléfono del cliente), además se le avisa por WhatsApp de que tiene un correo
    async correo(datos, contexto) {
        const crudo = construirCorreo(datos);
        const id = await conGoogle(contexto, (token, alRenovar) => contexto.google.enviarCorreo(token, alRenovar, crudo));
        const para = destinatarios(datos.para);
        const whatsapp = await avisarCliente(contexto, datos.whatsapp,
            `Le enviamos un correo a ${para[0]}${para.length > 1 ? ' (y otros)' : ''}: "${String(datos.asunto).slice(0, 150)}". Revise su bandeja de entrada.`);
        return { ok: true, id, avisoWhatsapp: whatsapp };
    },

    // Reporte PDF desde la plantilla de Google Docs ({ titulo, campos: { nombre: valor }, cliente: { id, nombre } })
    async reporte(datos, contexto) {
        const plantillaId = datos.plantillaId || contexto.config.reportes.plantillaId;
        if (!plantillaId) throw errorApp('No hay plantilla de reporte configurada (REPORTE_PLANTILLA_ID)', 503, 'configuracion');
        if (!/^[\w-]{20,100}$/.test(plantillaId)) throw errorApp('El id de la plantilla no es válido');
        const campos = datos.campos && typeof datos.campos === 'object' && !Array.isArray(datos.campos) ? datos.campos : {};
        if (Object.keys(campos).length > 100) throw errorApp('Demasiados campos (máximo 100)');
        for (const campo of Object.keys(campos)) if (!/^[\wáéíóúñÁÉÍÓÚÑ]{1,40}$/.test(campo)) throw errorApp(`Nombre de campo no válido: ${campo}`);
        const titulo = String(datos.titulo || 'Reporte · Semences del Caribe').replace(/[\r\n/\\]/g, ' ').slice(0, 150);
        // Carpeta propia del cliente dentro de la de reportes ({ id, nombre } del registro de clientes)
        let carpetaCliente = null;
        if (datos.cliente && datos.cliente.id) {
            if (!/^[\w-]{1,100}$/.test(String(datos.cliente.id))) throw errorApp('El id del cliente no es válido');
            const ficha = await db.leerRegistro(contexto.pool, 'clientes', datos.cliente.id);
            if (ficha && (!puedeLeer(contexto.ambito, 'clientes') || !dentroDelAmbito(contexto.ambito, 'clientes', ficha))) {
                throw errorApp('Ese cliente no es de tu país o casa comercial', 403, 'permiso');
            }
            const nombre = String(datos.cliente.nombre || datos.cliente.id).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 150);
            carpetaCliente = { id: String(datos.cliente.id), nombre: nombre || String(datos.cliente.id) };
        }
        const archivo = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearReporte(token, alRenovar, {
            plantillaId, carpetaId: contexto.config.reportes.carpetaId, titulo, campos, carpetaCliente
        }));
        return { ok: true, archivoId: archivo.id, enlace: archivo.enlace };
    },

    // Avisos push en este navegador: alta ({ suscripcion }), baja ({ endpoint }) o consulta ({ endpoint, consultar: true })
    async push(datos, { pool, usuario, avisos }) {
        if (!avisos.pushActivo) throw errorApp('Los avisos push no están configurados en el servidor', 503, 'configuracion');
        if (datos.operacion === 'alta') {
            const suscripcion = suscripcionValida(datos.suscripcion);
            if (!suscripcion) throw errorApp('Suscripción push no válida');
            await guardarSuscripcion(pool, usuario.id, suscripcion);
            return { ok: true, activo: true };
        }
        const endpoint = String(datos.endpoint || '');
        if (!endpoint) throw errorApp('Falta la dirección de la suscripción');
        if (datos.operacion === 'baja') {
            await borrarSuscripcion(pool, usuario.id, endpoint);
            return { ok: true, activo: false };
        }
        if (datos.operacion === 'consultar') return { ok: true, activo: await tieneSuscripcion(pool, usuario.id, endpoint) };
        throw errorApp('Operación desconocida (alta, baja o consultar)');
    },

    // Recibir o no el resumen de la mañana ({ activo: true | false })
    async resumen(datos, { pool, usuario, config }) {
        const activo = datos.activo !== false;
        await pool.query('UPDATE usuarios SET resumen_activo = ? WHERE id = ?', [activo ? 1 : 0, usuario.id]);
        return { ok: true, usuario: publico({ ...usuario, resumen_activo: activo ? 1 : 0 }, config) };
    },

    // Mi número de WhatsApp para recibir los avisos ('' para dejar de recibirlos)
    async telefono(datos, { pool, usuario, config }) {
        const texto = String(datos.telefono || '').trim();
        const telefono = texto ? normalizarTelefono(texto) : '';
        if (texto && !telefono) throw errorApp('Teléfono no válido. Escríbelo con código de país o como 809, 829 u 849 + 7 cifras.');
        await guardarTelefono(pool, usuario.id, telefono);
        return { ok: true, usuario: publico({ ...usuario, telefono }, config) };
    },

    // ----- Sala de espera: la persona deja su WhatsApp y espera a que un Master la apruebe -----
    async sala(datos, contexto) {
        const { pool, usuario, ambito, config, avisos } = contexto;
        if (ambito.estado === 'aprobado') return { ok: true, usuario: publico(usuario, config) };
        if (ambito.estado === 'rechazado') throw errorApp('Tu solicitud de acceso fue rechazada. Habla con un administrador.', 403, 'rechazado');
        const telefono = normalizarTelefono(datos.telefono);
        if (!telefono) throw errorApp('Escribe tu WhatsApp con código de país, o como 809, 829 u 849 + 7 cifras.');
        const primeraVez = !usuario.solicitado;
        await pool.query('UPDATE usuarios SET telefono = ?, solicitado = COALESCE(solicitado, UTC_TIMESTAMP()) WHERE id = ?', [telefono, usuario.id]);
        // Aviso a los Master (push y WhatsApp), solo la primera vez
        if (primeraVez && config.google.admins.length) {
            const [masters] = await pool.query('SELECT id FROM usuarios WHERE email IN (?)', [config.google.admins]);
            const { huellas, telefonos } = await destinosDe(pool, masters.map(m => m.id));
            const texto = `🔐 Nueva solicitud de acceso\n${usuario.nombre || usuario.email} (${usuario.email}) espera en la sala de espera. Entra a la app › Equipo y accesos para asignarle país, casa comercial y cargo.`;
            if (avisos.pushActivo) await encolar(pool, 'push', huellas, texto);
            if (avisos.whatsappActivo) await encolar(pool, 'whatsapp', telefonos, texto);
        }
        const [filas] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [usuario.id]);
        return { ok: true, usuario: publico(filas[0], config) };
    },

    // ----- Accesos (solo Master): aprobar, rechazar o cambiar el ámbito de cada persona -----
    async accesos(datos, contexto) {
        const { pool, usuario, ambito, config, avisos } = contexto;
        if (!ambito.master) throw errorApp('Solo un Master puede gestionar los accesos', 403, 'acceso');
        const email = String(datos.email || '').trim().toLowerCase();
        const [objetivo] = email ? await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]) : [[]];
        const persona = objetivo[0];
        if (datos.operacion !== 'listar') {
            if (!persona) throw errorApp('Esa cuenta todavía no ha entrado nunca en la app');
            if (esAdmin(config, persona.email)) throw errorApp('Los Master (ADMINS) tienen siempre todo el acceso');
        }
        if (datos.operacion === 'aprobar') {
            const asignacion = asignacionValida(datos);
            if (!asignacion) throw errorApp(`Elige el cargo (${CARGOS.filter(c => c !== 'master').join(', ')}), al menos un país y al menos una casa comercial`);
            await pool.query(
                `UPDATE usuarios SET estado = 'aprobado', cargo = ?, paises = ?, casas = ?, aprobado_por = ?, aprobado_en = UTC_TIMESTAMP() WHERE id = ?`,
                [asignacion.cargo, JSON.stringify(asignacion.paises), JSON.stringify(asignacion.casas), usuario.email, persona.id]);
            // Primera aprobación: se le avisa por WhatsApp (y push si ya lo activó)
            if (persona.estado !== 'aprobado') {
                const { huellas, telefonos } = await destinosDe(pool, [persona.id]);
                const texto = `✅ Acceso aprobado\nHola ${persona.nombre || ''}, ya puedes usar la app de Semences del Caribe. Ábrela de nuevo para entrar.`;
                if (avisos.whatsappActivo) await encolar(pool, 'whatsapp', telefonos, texto);
                if (avisos.pushActivo) await encolar(pool, 'push', huellas, texto);
            }
        } else if (datos.operacion === 'rechazar') {
            await pool.query(`UPDATE usuarios SET estado = 'rechazado', cargo = NULL, paises = '[]', casas = '[]', aprobado_por = ?, aprobado_en = UTC_TIMESTAMP() WHERE id = ?`, [usuario.email, persona.id]);
            // Fuera: sus sesiones y sus avisos push
            await pool.query('DELETE FROM sesiones WHERE usuario_id = ?', [persona.id]);
            await pool.query('DELETE FROM push_suscripciones WHERE usuario_id = ?', [persona.id]);
        } else if (datos.operacion === 'reabrir') {
            // Devuelve a la sala de espera a alguien rechazado (o quita el acceso a alguien aprobado)
            await pool.query(`UPDATE usuarios SET estado = 'pendiente', cargo = NULL, paises = '[]', casas = '[]' WHERE id = ?`, [persona.id]);
        } else if (datos.operacion !== 'listar') {
            throw errorApp('Operación desconocida (listar, aprobar, rechazar o reabrir)');
        }
        const [personas] = await pool.query(
            `SELECT * FROM usuarios ORDER BY FIELD(estado, 'pendiente', 'aprobado', 'rechazado'), solicitado IS NULL, solicitado, nombre`);
        return {
            ok: true,
            opciones: { paises: PAISES.map(p => ({ id: p, nombre: NOMBRE_PAIS[p] })), casas: CASAS, cargos: CARGOS.filter(c => c !== 'master') },
            personas: personas.map(p => ({ ...publico(p, config), solicitadoEn: p.solicitado, aprobadoPor: p.aprobado_por || '' }))
        };
    },

    // ----- Tablero del equipo -----

    // Latido de la app (cada minuto): "sigo conectado" y, si cambia, mi estado. Devuelve el equipo
    async presencia(datos, { pool, usuario, config }) {
        const estado = ['disponible', 'en_parcela', 'en_reunion'].includes(datos.estado) ? datos.estado : null;
        await pool.query(`UPDATE usuarios SET visto = UTC_TIMESTAMP()${estado ? ', presencia = ?' : ''} WHERE id = ?`, estado ? [estado, usuario.id] : [usuario.id]);
        const [filas] = await pool.query(
            `SELECT id, email, nombre, foto, cargo, estado, presencia, TIMESTAMPDIFF(SECOND, visto, UTC_TIMESTAMP()) segundos
             FROM usuarios WHERE estado = 'aprobado' OR email IN (?) ORDER BY nombre`, [config.google.admins.length ? config.google.admins : ['']]);
        const [[sinLeer]] = await pool.query('SELECT COUNT(*) n FROM directos WHERE para_id = ? AND leido = 0', [usuario.id]);
        return {
            ok: true,
            sinLeer: Number(sinLeer.n),
            equipo: filas.map(f => {
                const ambito = ambitoDe(f, config);
                const conectado = f.segundos !== null && f.segundos < 150;
                return {
                    email: f.email, nombre: f.nombre, foto: f.foto, cargo: ambito.cargo, yo: f.id === usuario.id,
                    estado: conectado ? f.presencia : 'desconectado', paises: ambito.paises, casas: ambito.casas
                };
            })
        };
    },

    // Mensaje directo a una persona del equipo: queda en su bandeja y le llega por push y WhatsApp.
    // tipo: mensaje, reunion (con enlace de Meet), cliente (le pasaron un cliente) o tarea
    async directo(datos, contexto) {
        const destino = await personaDelEquipo(contexto, datos.para);
        const texto = String(datos.texto || '').trim().slice(0, 2000);
        if (!texto) throw errorApp('Escribe el mensaje');
        const tipo = ['mensaje', 'reunion', 'tarea'].includes(datos.tipo) ? datos.tipo : 'mensaje';
        const enlace = /^https:\/\/meet\.google\.com\//.test(String(datos.enlace || '')) ? String(datos.enlace).slice(0, 500) : '';
        await enviarDirecto(contexto, destino, tipo, texto, enlace);
        return { ok: true };
    },

    // Mis mensajes directos (los 50 últimos); quedan como leídos
    async bandeja(datos, { pool, usuario }) {
        const [filas] = await pool.query(
            `SELECT d.id, d.tipo, d.texto, d.enlace, d.leido, d.creado, u.nombre de, u.email deEmail, u.foto deFoto
             FROM directos d JOIN usuarios u ON u.id = d.de_id WHERE d.para_id = ? ORDER BY d.id DESC LIMIT 50`, [usuario.id]);
        await pool.query('UPDATE directos SET leido = 1 WHERE para_id = ? AND leido = 0', [usuario.id]);
        return { ok: true, mensajes: filas.map(f => ({ ...f, leido: Boolean(f.leido) })) };
    },

    // Pasar un cliente a otra persona: tiene que poder verlo (su país y casa) y gestionar clientes
    async pasarCliente(datos, contexto) {
        const { pool, usuario, ambito, config } = contexto;
        const destino = await personaDelEquipo(contexto, datos.para);
        const conexion = await pool.getConnection();
        let cliente;
        try {
            await conexion.beginTransaction();
            cliente = await db.leerRegistro(conexion, 'clientes', String(datos.clienteId || ''), true);
            if (!cliente) throw errorApp('Ese cliente no existe', 404);
            if (!puedeEscribir(ambito, 'clientes', cliente)) throw errorApp('Ese cliente no es de tu país o casa comercial', 403, 'permiso');
            if (!puedeEscribir(ambitoDe(destino, config), 'clientes', cliente)) {
                throw errorApp(`${destino.nombre || destino.email} no puede ver ese cliente (su cargo, país o casa comercial no lo incluyen)`, 400, 'permiso');
            }
            await db.guardarRegistro(conexion, 'clientes', { ...cliente, asignado: destino.email, asignadoNombre: destino.nombre || destino.email, cuenta: usuario.email }, usuario.id);
            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }
        const nota = String(datos.nota || '').trim().slice(0, 500);
        await enviarDirecto(contexto, destino, 'cliente', `Te pasó el cliente ${cliente.nombre}${nota ? `: ${nota}` : ''}`, '');
        return { ok: true };
    },

    // Gestión del equipo (solo ADMINS): quién puede entrar además del dominio, y sus teléfonos
    async equipo(datos, { pool, usuario, config }) {
        if (!esAdmin(config, usuario.email)) throw errorApp('Solo un Master puede gestionar el equipo', 403, 'acceso');
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
            // Quien ya no está en el equipo pierde también sus sesiones abiertas y sus avisos push
            await pool.query('DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.email = ?', [email]);
            await pool.query('DELETE p FROM push_suscripciones p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = ?', [email]);
            // Y vuelve a la sala de espera: si un día puede entrar otra vez, un Master decide su acceso
            await pool.query("UPDATE usuarios SET estado = 'pendiente', cargo = NULL, paises = '[]', casas = '[]' WHERE email = ?", [email]);
        } else if (datos.operacion !== 'listar') {
            throw errorApp('Operación desconocida (listar, guardar o quitar)');
        }
        const [filas] = await pool.query('SELECT email, nombre, telefono, notas FROM equipo ORDER BY email');
        const [fallidos] = await pool.query("SELECT canal, destino, error, creado FROM cola_avisos WHERE estado = 'fallido' ORDER BY id DESC LIMIT 20");
        return { ok: true, equipo: filas, avisos: { cola: await estadoCola(pool), ultimosFallidos: fallidos } };
    }
};
