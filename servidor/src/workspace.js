/**
 * Google Workspace para el CRM, con el permiso de cada persona (OAuth, google.js):
 *
 * - Drive · documentos de los clientes: certificados fitosanitarios, permisos de importación, análisis de
 *   germinación, facturas o fotos de campo, en una carpeta por cliente dentro de DOCUMENTOS_CARPETA_ID.
 * - Drive · respaldo diario: todo el CRM en un JSON en RESPALDO_CARPETA_ID, con la cuenta del sistema; se
 *   conservan RESPALDO_CONSERVAR días.
 * - Calendar · agenda del CRM: los seguimientos de clientes, las tareas, los trasplantes del germinador y la llegada
 *   estimada de los envíos (DHL y FedEx) de cada persona pasan a su Google Calendar como eventos de día completo. Es idempotente: cada evento lleva su clave
 *   (p. ej. "seguimiento:<id del cliente>") y sincronizar otra vez actualiza o borra, nunca duplica.
 * - Gmail · correos de aviso desde la cuenta del sistema (solicitudes de acceso, accesos aprobados, germinación
 *   baja), además de push y WhatsApp. Se envían en segundo plano: un fallo de Gmail no frena la acción.
 *
 * La "cuenta del sistema" (CUENTA_GOOGLE_SISTEMA) es una persona del equipo que entró y conectó Google: no hace
 * falta una cuenta de servicio ni delegación de dominio (y así funciona también con cuentas personales).
 */
import { listarTodo, MODULOS_CRM } from './db.js';
import { ambitoDe, filtrarDatos } from './permisos.js';
import { construirCorreo } from './correo.js';
import { errorApp, conGoogle } from './llamadasGoogle.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import { cuotaGoogle } from './cuotas.js';
import { traducir, idiomaCorreo } from './idioma.js';

export const DIAS_AGENDA = 60;          // La agenda del CRM cubre de hoy a 60 días
export const HORA_AGENDA = 6;           // Sincronización automática: a las 6:00, antes del resumen de Borja
export const MAX_DOCUMENTO = 8 * 1024 * 1024;
export const TIPOS_DOCUMENTO = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv'
};

const normal = (t) => String(t || '').trim().toLocaleLowerCase('es');
const LOTE_ACTIVO = (l) => !['Despachado', 'Descartado'].includes(l.estado);
const enRango = (fecha, desde, hasta) => /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) && fecha >= desde && fecha <= hasta;

// ----- Calendar -----------------------------------------------------------------------------------------

/**
 * Eventos que la persona debería tener en su calendario, a partir de datos YA filtrados por su ámbito:
 * [{ clave, evento }] con eventos de día completo entre hoy y hoy + dias.
 */
export function eventosDeAgenda({ persona, ambito, datos, hoy, dias = DIAS_AGENDA, urlApp = '' }) {
    const hasta = sumarDias(hoy, dias);
    const yo = [normal(persona.nombre), normal(persona.email)].filter(Boolean);
    const esMio = (texto) => yo.includes(normal(texto));
    const pie = `\n\nDesde el CRM de Semences del Caribe${urlApp ? `: ${urlApp}` : ''}`;
    const deDia = (clave, fecha, titulo, descripcion, colorId) => ({
        clave,
        evento: {
            summary: titulo.slice(0, 300),
            description: `${descripcion}${pie}`.slice(0, 8000),
            start: { date: fecha },
            end: { date: sumarDias(fecha, 1) },
            transparency: 'transparent', // No marca el día como ocupado
            colorId,
            extendedProperties: { private: { semencesOrigen: 'crm', semencesClave: clave } }
        }
    });
    const eventos = [];
    if (ambito.modulos.includes('clientes')) {
        for (const c of datos.clientes || []) {
            if (!c.id || !enRango(c.seguimiento, hoy, hasta) || (c.asignado && !esMio(c.asignado))) continue;
            const detalle = [c.telefono && `Teléfono: ${c.telefono}`, c.whatsapp && `WhatsApp: ${c.whatsapp}`, c.ubicacion && `Ubicación: ${c.ubicacion}`, c.marca && `Marca: ${c.marca}`].filter(Boolean).join('\n');
            eventos.push(deDia(`seguimiento:${c.id}`, c.seguimiento, `🤝 Seguimiento: ${c.nombre || 'cliente'}`, detalle || 'Seguimiento del cliente', '10'));
        }
    }
    for (const t of datos.tareas || []) {
        if (!t.id || t.hecha || !esMio(t.para) || !enRango(t.vence, hoy, hasta)) continue;
        eventos.push(deDia(`tarea:${t.id}`, t.vence, `📋 ${t.titulo || 'Tarea'}`, [`Prioridad ${String(t.prioridad || 'media').toLowerCase()}`, t.creadaPor && `Creó: ${t.creadaPor}`].filter(Boolean).join('\n'), '6'));
    }
    if (ambito.modulos.includes('germinador')) {
        for (const l of datos.germinador || []) {
            if (!l.id || !LOTE_ACTIVO(l) || !enRango(l.trasplante, hoy, hasta)) continue;
            eventos.push(deDia(`trasplante:${l.id}`, l.trasplante, `🌱 Trasplante · Lote ${l.lote || l.id}${l.variedad ? ` · ${l.variedad}` : ''}`,
                [l.cliente && `Cliente: ${l.cliente}`, l.bandejas && `Bandejas: ${l.bandejas}`].filter(Boolean).join('\n') || 'Trasplante previsto', '2'));
        }
    }
    // Envíos (DHL y FedEx) sin entregar, el día de su llegada estimada. Mismo criterio que el resumen de Borja:
    // al vendedor, solo los de los clientes asignados a él
    if (ambito.modulos.includes('envios') || (ambito.lectura || []).includes('envios')) {
        const mios = new Set((datos.clientes || []).filter(c => c.asignado && esMio(c.asignado)).map(c => c.id));
        for (const e of datos.envios || []) {
            if (!e.id || e.estado === 'Entregado' || !enRango(e.eta, hoy, hasta)) continue;
            if (ambito.cargo === 'vendedor' && !mios.has(e.clienteId)) continue;
            const detalle = [e.estado && `Estado: ${e.estado}`, e.contenido && `Contenido: ${e.contenido}`,
                e.semillasMiles && `${e.semillasMiles} mil semillas`, e.ubicacion && `Ubicación: ${e.ubicacion}`].filter(Boolean).join('\n');
            eventos.push(deDia(`envio:${e.id}`, e.eta, `📦 Llega ${[e.transportista, e.guia].filter(Boolean).join(' ') || 'un envío'} · ${e.cliente || 'sin cliente'}`, detalle || 'Llegada estimada del envío', '9'));
        }
    }
    return eventos;
}

/**
 * Qué hacer para que el calendario quede como los deseados: { crear, actualizar: [{ id, deseado }], borrar: [id] }.
 * Un evento repetido con la misma clave (p. ej. tras un fallo a medias) se borra.
 */
export function planAgenda(existentes, deseados) {
    const porClave = new Map();
    const borrar = [];
    for (const e of existentes) {
        if (!e.clave || porClave.has(e.clave)) borrar.push(e.id);
        else porClave.set(e.clave, e);
    }
    const crear = [];
    const actualizar = [];
    for (const deseado of deseados) {
        const actual = porClave.get(deseado.clave);
        porClave.delete(deseado.clave);
        if (!actual) crear.push(deseado);
        else if (actual.inicio !== deseado.evento.start.date || actual.titulo !== deseado.evento.summary || actual.descripcion !== deseado.evento.description) {
            actualizar.push({ id: actual.id, deseado });
        }
    }
    for (const sobrante of porClave.values()) borrar.push(sobrante.id);
    return { crear, actualizar, borrar };
}

/**
 * Pone al día la agenda del CRM en el Google Calendar de una persona. datosTodos: todo el CRM (se filtra aquí con
 * su ámbito). Devuelve { creados, actualizados, borrados }.
 */
export async function sincronizarAgenda(contexto, persona, datosTodos, ahora = new Date()) {
    const { pool, config, google } = contexto;
    const ambito = ambitoDe(persona, config);
    if (ambito.estado !== 'aprobado') throw errorApp('Tu cuenta todavía no está aprobada', 403, 'espera');
    const { fecha: hoy } = enZona(ahora, config.zonaHoraria);
    const deseados = eventosDeAgenda({ persona, ambito, datos: filtrarDatos(datosTodos, ambito), hoy, urlApp: config.urlApp });
    const desde = inicioDelDia(hoy, config.zonaHoraria);
    const hasta = new Date(desde.getTime() + (DIAS_AGENDA + 2) * 86400000);
    return conGoogle({ pool, config, usuario: persona }, async (token, alRenovar) => {
        const existentes = await google.eventosCrm(token, alRenovar, { desde, hasta });
        const plan = planAgenda(existentes, deseados);
        // Cubo de fichas por persona (cuotas.js): una agenda con muchos cambios no dispara un 429 de Calendar
        const cuota = () => cuotaGoogle.esperar(persona.id);
        for (const { evento } of plan.crear) { await cuota(); await google.guardarEventoCrm(token, alRenovar, { evento }); }
        for (const { id, deseado } of plan.actualizar) { await cuota(); await google.guardarEventoCrm(token, alRenovar, { id, evento: deseado.evento }); }
        for (const id of plan.borrar) { await cuota(); await google.borrarEventoCrm(token, alRenovar, id); }
        return { creados: plan.crear.length, actualizados: plan.actualizar.length, borrados: plan.borrar.length };
    });
}

// ----- Cuenta del sistema y correos de aviso ----------------------------------------------------------------

// La persona de CUENTA_GOOGLE_SISTEMA, si entró y tiene Google conectado; si no, null
export async function cuentaDelSistema(pool, config) {
    const correo = config.workspace && config.workspace.cuentaSistema;
    if (!correo) return null;
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ? AND token_google IS NOT NULL', [correo]);
    return filas[0] || null;
}

// Tareas en segundo plano (correos, lo lento de los webhooks de Meta): quien las lanza responde sin esperarlas;
// las pruebas pueden esperarlas (esperarSegundoPlano)
const pendientes = new Set();
export function enSegundoPlano(promesa, registrar = console) {
    const tarea = Promise.resolve(promesa).catch(error => registrar.error('En segundo plano:', error.message)).finally(() => pendientes.delete(tarea));
    pendientes.add(tarea);
    return tarea;
}
export const esperarSegundoPlano = () => Promise.all([...pendientes]);

/**
 * Correo de aviso desde la cuenta del sistema, uno por destinatario (no ven los correos de los demás).
 * Devuelve cuántos se enviaron (0 si los correos de aviso están apagados o no hay cuenta del sistema).
 */
export async function avisarPorCorreo(contexto, { para, asunto, texto }) {
    const { pool, config, google } = contexto;
    if (!config.workspace || !config.workspace.correosAvisos) return 0;
    const sistema = await cuentaDelSistema(pool, config);
    if (!sistema) return 0;
    const destinos = [...new Set([].concat(para || []).map(c => String(c).trim().toLowerCase()).filter(c => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)))];
    const pie = `\n\n—\nSemences del Caribe · aviso automático del CRM${config.urlApp ? `\n${config.urlApp}` : ''}`;
    let enviados = 0;
    for (const correo of destinos) {
        // Cada correo en el idioma de quien lo recibe
        const idioma = await idiomaCorreo(pool, correo);
        const crudo = construirCorreo({ para: correo, asunto: `Semences del Caribe · ${traducir(asunto, idioma)}`.slice(0, 250), texto: traducir(`${texto}${pie}`, idioma) });
        await conGoogle({ pool, config, usuario: sistema }, (token, alRenovar) => google.enviarCorreo(token, alRenovar, crudo));
        enviados++;
    }
    return enviados;
}

// ----- Drive: documentos de los clientes --------------------------------------------------------------------

// Comprueba un documento ({ nombre, tipo, base64 }) y devuelve { nombre, tipo, datos }
export function documentoValido({ nombre, tipo, base64 }) {
    const extension = TIPOS_DOCUMENTO[tipo];
    if (!extension) throw errorApp('Tipo de archivo no admitido (PDF, imagen, Word, Excel o CSV)');
    const datos = Buffer.from(String(base64 || ''), 'base64');
    if (!datos.length) throw errorApp('El archivo está vacío');
    if (datos.length > MAX_DOCUMENTO) throw errorApp('El archivo pesa demasiado (máximo 8 MB)');
    let limpio = String(nombre || '').replace(/[\r\n/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!limpio) limpio = `documento.${extension}`;
    if (!limpio.toLowerCase().endsWith(`.${extension}`) && !(extension === 'jpg' && /\.jpe?g$/i.test(limpio))) limpio += `.${extension}`;
    return { nombre: limpio, tipo, datos };
}

// ----- Drive: respaldo del CRM ------------------------------------------------------------------------------

/**
 * Respaldo de todo el CRM (JSON) en RESPALDO_CARPETA_ID con la cuenta del sistema, y borra los de más de
 * RESPALDO_CONSERVAR días. Devuelve { archivo, enlace, registros, borrados }.
 */
export async function respaldar(contexto, ahora = new Date()) {
    const { pool, config, google } = contexto;
    const { respaldoCarpetaId: carpetaId, respaldoConservar } = config.workspace || {};
    if (!carpetaId) throw errorApp('No hay carpeta de respaldos configurada (RESPALDO_CARPETA_ID)', 503, 'configuracion');
    const sistema = await cuentaDelSistema(pool, config);
    if (!sistema) throw errorApp('La cuenta del sistema (CUENTA_GOOGLE_SISTEMA) no ha entrado en la app o no tiene Google conectado', 503, 'configuracion');
    const datos = await listarTodo(pool);
    const registros = Object.fromEntries(MODULOS_CRM.map(m => [m, (datos[m] || []).length]));
    const local = enZona(ahora, config.zonaHoraria);
    const nombre = `semences-crm-respaldo-${local.fecha}-${String(local.hora).padStart(2, '0')}${String(local.minuto).padStart(2, '0')}.json`;
    const contenido = JSON.stringify({ formato: 'semences-crm-respaldo', version: 1, generado: ahora.toISOString(), zonaHoraria: config.zonaHoraria, registros, datos });
    return conGoogle({ pool, config, usuario: sistema }, async (token, alRenovar) => {
        const archivo = await google.subirArchivo(token, alRenovar, {
            carpetaId, nombre, tipo: 'application/json', datos: Buffer.from(contenido, 'utf8'),
            descripcion: 'Respaldo automático del CRM de Semences del Caribe', propiedades: { semencesRespaldo: '1' }
        });
        const viejos = await google.respaldos(token, alRenovar, { carpetaId, antesDe: new Date(ahora.getTime() - respaldoConservar * 86400000) });
        for (const viejo of viejos) await google.borrarArchivo(token, alRenovar, viejo.id);
        return { archivo: archivo.nombre, enlace: archivo.enlace, registros, borrados: viejos.length };
    });
}

// ¿Toca el respaldo de hoy? A la hora RESPALDO_HORA (o después, si el servidor estaba dormido) y si no hay ya uno de hoy
export async function respaldoPendiente(contexto, ahora = new Date()) {
    const { pool, config, google } = contexto;
    const ws = config.workspace || {};
    if (!ws.respaldoCarpetaId || !ws.cuentaSistema) return false;
    const { fecha, hora } = enZona(ahora, config.zonaHoraria);
    if (hora < ws.respaldoHora) return false;
    const sistema = await cuentaDelSistema(pool, config);
    if (!sistema) return false;
    const desde = inicioDelDia(fecha, config.zonaHoraria);
    const hechos = await conGoogle({ pool, config, usuario: sistema }, (token, alRenovar) => google.respaldos(token, alRenovar, { carpetaId: ws.respaldoCarpetaId, desde }));
    return hechos.length === 0;
}

// ----- Tareas periódicas en el propio proceso ------------------------------------------------------------

/**
 * Cada pocos minutos: el respaldo del día (si toca) y, a partir de HORA_AGENDA, la agenda de cada persona con Google
 * conectado (una vez al día por proceso; si hay varios procesos, repetirla no duplica nada).
 * Devuelve la función para pararlo.
 */
export function iniciarWorkspace(contexto, { cadaMs = 10 * 60000, registrar = console } = {}) {
    let ocupado = false;
    let agendaHecha = '';
    const repaso = async () => {
        if (ocupado) return;
        ocupado = true;
        try {
            const { config, pool } = contexto;
            const ahora = new Date();
            if (await respaldoPendiente(contexto, ahora).catch(e => { registrar.error('Respaldo (comprobación):', e.message); return false; })) {
                const r = await respaldar(contexto, ahora);
                registrar.log(`Respaldo del CRM en Drive: ${r.archivo} (${r.borrados} antiguos borrados)`);
            }
            const { fecha, hora } = enZona(ahora, config.zonaHoraria);
            if (config.workspace.agendaAutomatica && hora >= HORA_AGENDA && agendaHecha !== fecha) {
                agendaHecha = fecha;
                const [personas] = await pool.query("SELECT * FROM usuarios WHERE token_google IS NOT NULL AND (estado = 'aprobado' OR email IN (?))",
                    [config.google.admins.length ? config.google.admins : ['']]);
                const datos = personas.length ? await listarTodo(pool) : null;
                for (const persona of personas) {
                    await sincronizarAgenda(contexto, persona, datos, ahora).catch(e => registrar.error(`Agenda de ${persona.email}:`, e.message));
                }
            }
        } catch (error) {
            registrar.error('Google Workspace:', error.message);
        } finally {
            ocupado = false;
        }
    };
    const temporizador = setInterval(repaso, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}
