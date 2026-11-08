/**
 * Reporte semanal de actividades.
 *
 * - Cada persona aprobada (menos los Master) repasa cada semana sus actividades, que son sus tareas del
 *   CRM: las asignadas a ella y las que creó sin asignar. A cada una le pone un estado (en progreso,
 *   retrasada, completada o terminada sin éxito) y un comentario. Puede añadir actividades nuevas.
 * - Lo que sigue en progreso o retrasado se queda como tarea pendiente y vuelve a salir la semana
 *   siguiente; completada o terminada sin éxito cierra la tarea.
 * - El viernes a REPORTE_HORA (16 por defecto) se recuerda por push y WhatsApp a quien no lo entregó.
 * - Desde el lunes, quien no entregó el de la semana pasada (y ya estaba aprobado ese viernes) solo
 *   puede usar el reporte: el resto de acciones responde 423 con codigo 'reporte'. Al entregarlo se
 *   desbloquea al momento.
 * - Lo ven en la app los Master y los administrativos que comparten país y casa con esa persona; al
 *   entregarlo les llega un push. No genera PDF, ni reuniones, ni correos.
 * - Con ANTHROPIC_API_KEY (ia.js), después de entregarse Claude escribe para ellos una revisión (resumen,
 *   avances, atascos, comentarios pobres) y el push lleva ese resumen; el lunes, el resumen del equipo
 *   para los Master. La revisión nunca bloquea ni desbloquea: se hace después, sin hacer esperar a nadie.
 */
import crypto from 'node:crypto';
import { ambitoDe } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { registrarAviso } from './campana.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import * as db from './db.js';
import { quienDe } from './auditoria.js';
import { actividadesDelCrm } from './pedidos.js';
import { leerMensajes, renderizar } from './mensajes.js';

export const ESTADOS_ACTIVIDAD = ['En progreso', 'Retrasada', 'Completada', 'Terminada sin éxito'];
const CIERRAN = ['Completada', 'Terminada sin éxito'];
const COMENTARIO_MINIMO = 5;
// Lo que se puede hacer sin haber entregado el reporte de la semana pasada
export const SIN_REPORTE = ['reporteSemanal', 'sala', 'telefono', 'push', 'presencia', 'resumen'];

export const ESQUEMA_REPORTES = [
    `CREATE TABLE IF NOT EXISTS reportes_semanales (
        usuario_id INT UNSIGNED NOT NULL,
        semana CHAR(8) NOT NULL,
        resumen TEXT NOT NULL,
        actividades MEDIUMTEXT NOT NULL,
        entregado DATETIME(3) NOT NULL,
        PRIMARY KEY (usuario_id, semana),
        INDEX (semana)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS reportes_revisiones (
        usuario_id INT UNSIGNED NOT NULL,
        semana CHAR(8) NOT NULL,
        revision MEDIUMTEXT NULL,
        modelo VARCHAR(60) NOT NULL DEFAULT '',
        intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
        error VARCHAR(300) NOT NULL DEFAULT '',
        entrega DATETIME(3) NOT NULL,     -- La entrega revisada (o intentada): si el reporte se corrige, cambia
        revisado DATETIME(3) NOT NULL,    -- Último intento
        PRIMARY KEY (usuario_id, semana)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS reportes_resumenes (
        clave CHAR(64) PRIMARY KEY,
        semana CHAR(8) NOT NULL,
        resumen MEDIUMTEXT NOT NULL,
        modelo VARCHAR(60) NOT NULL DEFAULT '',
        creado DATETIME NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS reportes_avisos_equipo (
        semana CHAR(8) PRIMARY KEY
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS reportes_recordatorios (
        usuario_id INT UNSIGNED NOT NULL,
        semana CHAR(8) NOT NULL,
        PRIMARY KEY (usuario_id, semana)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

// ----- Semanas (ISO 8601: de lunes a domingo, "2026-W45") -----

const diaSemana = (fecha) => { const [a, m, d] = fecha.split('-').map(Number); return (new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7; }; // 0 = lunes

export function lunesDe(fecha) {
    return sumarDias(fecha, -diaSemana(fecha));
}

export function semanaDe(fecha) {
    const jueves = sumarDias(fecha, 3 - diaSemana(fecha)); // El año de la semana es el de su jueves
    const anio = Number(jueves.slice(0, 4));
    const [a, m, d] = jueves.split('-').map(Number);
    const dia = (Date.UTC(a, m - 1, d) - Date.UTC(anio, 0, 1)) / 86400000;
    return `${anio}-W${String(Math.floor(dia / 7) + 1).padStart(2, '0')}`;
}

// Lunes a domingo de una semana, para enseñarla ("del 26 oct al 1 nov")
export function diasDeSemana(semana) {
    const [anio, n] = [Number(semana.slice(0, 4)), Number(semana.slice(6))];
    const cuatroEnero = `${anio}-01-04`; // Siempre cae en la semana 1
    const lunes = sumarDias(lunesDe(cuatroEnero), (n - 1) * 7);
    return { lunes, domingo: sumarDias(lunes, 6) };
}

export const semanaValida = (s) => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(String(s || ''));

// La semana en curso y la anterior, en la zona del equipo
export function semanas(config, ahora = new Date()) {
    const hoy = enZona(ahora, config.zonaHoraria).fecha;
    const lunes = lunesDe(hoy);
    return {
        hoy,
        actual: semanaDe(hoy),
        anterior: semanaDe(sumarDias(lunes, -7)),
        // Quien ya estaba aprobado el viernes de la semana pasada (recibió el recordatorio) debe ese reporte
        viernesAnterior: inicioDelDia(sumarDias(lunes, -3), config.zonaHoraria)
    };
}

// ¿Tiene que entregar reportes? Todo aprobado menos los Master (y si REPORTE_SEMANAL=no, nadie)
const debeReportar = (usuario, config) => {
    const a = ambitoDe(usuario, config);
    return config.reporteSemanal && a.estado === 'aprobado' && !a.master;
};

/**
 * Semana cuyo reporte bloquea a la persona, o null si no está bloqueada: la anterior, si no la
 * entregó y ya estaba aprobada el viernes de esa semana.
 */
export async function semanaBloqueada(pool, config, usuario, ahora = new Date()) {
    if (!debeReportar(usuario, config)) return null;
    const s = semanas(config, ahora);
    if (usuario.aprobado_en && new Date(usuario.aprobado_en) > s.viernesAnterior) return null;
    const [filas] = await pool.query('SELECT 1 FROM reportes_semanales WHERE usuario_id = ? AND semana = ?', [usuario.id, s.anterior]);
    return filas.length ? null : s.anterior;
}

// Mis actividades: mis tareas pendientes (asignadas a mí, o creadas por mí sin asignar) y las que cerré esta semana
// Sin mayúsculas ni tildes, como compara la app (tareas.js)
const normalizar = (t) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();

function esMia(tarea, usuario) {
    const yo = [usuario.nombre, usuario.email, usuario.email.split('@')[0]].filter(Boolean).map(normalizar);
    const para = normalizar(tarea.para);
    const creo = normalizar(tarea.creadaPor);
    return para ? yo.includes(para) : yo.includes(creo);
}

// Lote A #12: lo hecho en el CRM esa semana (visitas, cotizaciones y pedidos confirmados), ya rellenado
function delCrm(datos, usuario, semana, config) {
    return actividadesDelCrm(datos, usuario.email, diasDeSemana(semana), (iso) => enZona(new Date(iso), config.zonaHoraria).fecha);
}

async function actividadesDe(pool, usuario, desde, semana = null, config = null) {
    const datos = await db.listarTodo(pool);
    const { tareas = [] } = datos;
    const automaticas = semana && config ? delCrm(datos, usuario, semana, config) : [];
    return [...tareas.filter(t => esMia(t, usuario) && (!t.hecha || String(t.hecha) >= desde))
        .map(t => ({
            id: t.id, titulo: t.titulo, prioridad: t.prioridad || '', vence: t.vence || '',
            estado: t.estadoSemanal || (t.hecha ? 'Completada' : 'En progreso'), comentario: t.comentarioSemanal || '',
            cerrada: Boolean(t.hecha)
        }))
        .sort((x, y) => Number(x.cerrada) - Number(y.cerrada) || (x.estado === 'Retrasada' ? -1 : 0) - (y.estado === 'Retrasada' ? -1 : 0)), ...automaticas];
}

// ¿Esta persona de administración ve el reporte de aquella? Master: todos; administrativo: si comparten país y casa
function veReporteDe(ambito, persona, config) {
    if (ambito.master) return true;
    if (ambito.cargo !== 'administrativo') return false;
    const otra = ambitoDe(persona, config);
    return otra.paises.some(p => ambito.paises.includes(p)) && otra.casas.some(c => ambito.casas.includes(c));
}

const leerReporte = (fila) => fila && ({ semana: fila.semana, resumen: fila.resumen, actividades: JSON.parse(fila.actividades || '[]'), entregado: fila.entregado });
const leerRevision = (fila) => (fila && fila.revision ? { ...JSON.parse(fila.revision), modelo: fila.modelo, revisado: fila.revisado } : null);
const iaActiva = (contexto) => Boolean(contexto.ia && contexto.ia.activo);

// Push a quien revisa los reportes de esta persona (Master y administrativos de su país y casa)
async function avisarRevisores({ pool, config, avisos }, persona, texto) {
    const [personas] = await pool.query(`SELECT * FROM usuarios WHERE id <> ? AND (estado = 'aprobado' OR email IN (?))`,
        [persona.id, config.google.admins.length ? config.google.admins : ['']]);
    const revisan = personas.filter(p => veReporteDe(ambitoDe(p, config), persona, config));
    if (!revisan.length) return 0;
    await registrarAviso(pool, revisan.map(p => p.id), 'reporte', texto.replace(/^📋\s*/, '').replace('\n', ': '));
    if (!avisos.pushActivo) return 0;
    const { huellas } = await destinosDe(pool, revisan.map(p => p.id));
    return encolar(pool, 'push', huellas, texto);
}

const textoCuentas = (actividades) => {
    const cuenta = (e) => actividades.filter(a => a.estado === e).length;
    return `${cuenta('Completada')} completadas · ${cuenta('En progreso')} en progreso · ${cuenta('Retrasada')} retrasadas · ${cuenta('Terminada sin éxito')} sin éxito`;
};

// Las personas cuyo reporte ve esta persona de administración, con su reporte y su revisión de esa semana
async function equipoVisible(pool, config, ambito, excluirId, semana) {
    const [personas] = await pool.query(`SELECT * FROM usuarios WHERE estado = 'aprobado' AND id <> ? ORDER BY nombre`, [excluirId]);
    const [filas] = await pool.query('SELECT * FROM reportes_semanales WHERE semana = ?', [semana]);
    const [revisiones] = await pool.query('SELECT * FROM reportes_revisiones WHERE semana = ?', [semana]);
    const reportes = new Map(filas.map(f => [f.usuario_id, f]));
    const revisadas = new Map(revisiones.map(f => [f.usuario_id, f]));
    return personas.filter(p => debeReportar(p, config) && veReporteDe(ambito, p, config)).map(p => ({
        id: p.id, email: p.email, nombre: p.nombre || p.email, cargo: ambitoDe(p, config).cargo,
        reporte: leerReporte(reportes.get(p.id)) || null,
        revision: leerRevision(revisadas.get(p.id))
    }));
}

// El resumen del equipo se guarda por semana y por grupo de reportes: si nadie entrega ni corrige nada, no se repite
const claveResumen = (semana, equipo) => crypto.createHash('sha256')
    .update(JSON.stringify([semana, equipo.filter(p => p.reporte).map(p => [p.id, new Date(p.reporte.entregado).getTime()]).sort((a, b) => a[0] - b[0])]))
    .digest('hex');

async function resumenGuardado(pool, semana, equipo) {
    const [[fila]] = await pool.query('SELECT * FROM reportes_resumenes WHERE clave = ?', [claveResumen(semana, equipo)]);
    return fila ? { ...JSON.parse(fila.resumen), modelo: fila.modelo, creado: fila.creado } : null;
}

async function resumirEquipo({ pool, ia }, semana, equipo) {
    const guardado = await resumenGuardado(pool, semana, equipo);
    if (guardado) return guardado;
    const entregados = equipo.filter(p => p.reporte);
    const { datos, modelo } = await ia.resumirEquipo({
        semana, reportes: entregados, sinEntregar: equipo.filter(p => !p.reporte).map(p => p.nombre)
    });
    await pool.query('INSERT IGNORE INTO reportes_resumenes (clave, semana, resumen, modelo, creado) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
        [claveResumen(semana, equipo), semana, JSON.stringify(datos), modelo]);
    return { ...datos, modelo, creado: new Date() };
}

/**
 * Acción "reporteSemanal". operacion:
 * - estado: qué semana toca, si está bloqueada, sus actividades y lo que ya entregó;
 * - entregar: { semana, resumen, actividades: [{ id?, titulo, estado, comentario }] };
 * - equipo (Master y administrativos): { semana? } → quién lo entregó y quién no, con cada reporte.
 */
export async function accionReporte(datos, contexto, { errorApp }) {
    const { pool, config, usuario, ambito, avisos } = contexto;
    const s = semanas(config);
    const op = datos.operacion || 'estado';

    if (op === 'estado') {
        const bloqueada = await semanaBloqueada(pool, config, usuario);
        const semana = bloqueada || s.actual;
        const [[fila]] = await pool.query('SELECT * FROM reportes_semanales WHERE usuario_id = ? AND semana = ?', [usuario.id, semana]);
        return {
            ok: true,
            obligado: debeReportar(usuario, config),
            bloqueado: Boolean(bloqueada),
            semana, dias: diasDeSemana(semana),
            entregado: leerReporte(fila) || null,
            estados: ESTADOS_ACTIVIDAD,
            ia: iaActiva(contexto), // Para avisar a la persona de que administración recibe un resumen hecho con IA
            actividades: await actividadesDe(pool, usuario, inicioDelDia(diasDeSemana(semana).lunes, config.zonaHoraria).toISOString(), semana, config)
        };
    }

    if (op === 'entregar') {
        if (!debeReportar(usuario, config)) throw errorApp('Tu cargo no entrega reporte semanal', 400);
        const semana = String(datos.semana || '');
        // Solo la semana en curso o la anterior (la que bloquea)
        if (!semanaValida(semana) || ![s.actual, s.anterior].includes(semana)) throw errorApp('Esa semana no se puede entregar');
        const resumen = String(datos.resumen || '').trim().replace(/\s+\n/g, '\n').slice(0, 2000);
        const lista = Array.isArray(datos.actividades) ? datos.actividades.slice(0, 100) : [];
        if (!lista.length) throw errorApp('Añade al menos una actividad de la semana, con su estado y un comentario');
        const todo = await db.listarTodo(pool);
        const { tareas = [] } = todo;
        const delCrmSemana = new Map(delCrm(todo, usuario, semana, config).map(a => [a.id, a]));
        const actividades = [];
        for (const a of lista) {
            const titulo = String(a.titulo || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            const estado = String(a.estado || '');
            const comentario = String(a.comentario || '').trim().slice(0, 1000);
            if (!ESTADOS_ACTIVIDAD.includes(estado)) throw errorApp(`Elige el estado de «${titulo || 'la actividad'}»`);
            if (comentario.length < COMENTARIO_MINIMO) throw errorApp(`Escribe un comentario de cómo va «${titulo || 'la actividad'}»`);
            // Lo que salió del CRM (visitas, cotizaciones, pedidos): se guarda en el reporte, sin crear tareas
            if (String(a.id || '').startsWith('auto:')) {
                const auto = delCrmSemana.get(String(a.id));
                if (!auto) throw errorApp(`«${titulo || 'la actividad'}» no es tuya o no es de esa semana`, 403, 'permiso');
                actividades.push({ existente: null, auto: true, id: auto.id, titulo: auto.titulo, estado, comentario });
                continue;
            }
            const existente = a.id ? tareas.find(t => t.id === String(a.id)) : null;
            if (a.id && (!existente || !esMia(existente, usuario))) throw errorApp(`«${titulo}» no es una de tus tareas`, 403, 'permiso');
            if (!existente && !titulo) throw errorApp('Escribe qué actividad es');
            actividades.push({ existente, titulo: existente ? existente.titulo : titulo, estado, comentario });
        }
        const ahora = new Date().toISOString();
        const nombre = usuario.nombre || usuario.email;
        const conexion = await pool.getConnection();
        try {
            await conexion.beginTransaction();
            for (const a of actividades) {
                if (a.auto) continue;
                const cierra = CIERRAN.includes(a.estado);
                const tarea = a.existente
                    ? { ...a.existente }
                    : { id: `rs-${crypto.randomUUID()}`, titulo: a.titulo, prioridad: 'Media', vence: '', para: nombre, creadaPor: nombre, creada: ahora, hecha: '', hechaPor: '' };
                Object.assign(tarea, {
                    estadoSemanal: a.estado, comentarioSemanal: a.comentario, reportada: semana, cuenta: usuario.email,
                    hecha: cierra ? (tarea.hecha || ahora) : '', hechaPor: cierra ? (tarea.hechaPor || nombre) : ''
                });
                await db.guardarRegistro(conexion, 'tareas', tarea, usuario.id, quienDe(contexto));
                a.id = tarea.id;
            }
            await conexion.query(
                `INSERT INTO reportes_semanales (usuario_id, semana, resumen, actividades, entregado) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
                 ON DUPLICATE KEY UPDATE resumen = VALUES(resumen), actividades = VALUES(actividades), entregado = UTC_TIMESTAMP(3)`,
                [usuario.id, semana, resumen, JSON.stringify(actividades.map(({ id, titulo, estado, comentario }) => ({ id, titulo, estado, comentario })))]);
            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }
        // Con IA: la revisión se hace después (sin hacer esperar a nadie) y su resumen va en el aviso a
        // administración. Sin IA: el aviso sale ya, con las cuentas
        if (iaActiva(contexto)) {
            setImmediate(() => revisarPendientes(contexto).catch(e => (contexto.registrar || console).error('Revisión del reporte semanal:', e.message)));
        } else {
            await avisarRevisores(contexto, usuario, `📋 Reporte semanal · ${nombre}\n${textoCuentas(actividades)}`);
        }
        return { ok: true, semana, desbloqueado: true };
    }

    if (op === 'equipo') {
        if (!(ambito.master || ambito.cargo === 'administrativo')) throw errorApp('Los reportes del equipo los ven los Master y administración', 403, 'acceso');
        const semana = semanaValida(datos.semana) ? datos.semana : s.anterior;
        const equipo = await equipoVisible(pool, config, ambito, usuario.id, semana);
        return {
            ok: true, semana, dias: diasDeSemana(semana), actual: s.actual, anterior: s.anterior, ia: iaActiva(contexto),
            resumenEquipo: equipo.some(p => p.reporte) ? await resumenGuardado(pool, semana, equipo) : null,
            equipo: equipo.map(({ id, ...p }) => p)
        };
    }

    // Resumen del equipo con IA (Master y administrativos, de las personas que ven)
    if (op === 'resumenEquipo') {
        if (!(ambito.master || ambito.cargo === 'administrativo')) throw errorApp('Los reportes del equipo los ven los Master y administración', 403, 'acceso');
        if (!iaActiva(contexto)) throw errorApp('La revisión con IA no está configurada en el servidor (ANTHROPIC_API_KEY)', 503, 'configuracion');
        const semana = semanaValida(datos.semana) ? datos.semana : s.anterior;
        const equipo = await equipoVisible(pool, config, ambito, usuario.id, semana);
        if (!equipo.some(p => p.reporte)) throw errorApp('Nadie de tu equipo entregó el reporte de esa semana');
        try {
            return { ok: true, semana, resumenEquipo: await resumirEquipo(contexto, semana, equipo) };
        } catch (error) {
            (contexto.registrar || console).error('Resumen del equipo:', error.message);
            throw errorApp('No se pudo hacer el resumen ahora. Inténtalo en unos minutos.', 502, 'ia');
        }
    }

    throw errorApp('Operación desconocida del reporte semanal');
}

/**
 * Revisa con IA los reportes entregados (o corregidos) sin revisión de las últimas tres semanas. Si
 * falla, lo reintenta cada 10 minutos hasta 3 veces; a la tercera, el aviso a administración sale sin
 * revisión, con las cuentas. Dentro del proceso, una sola pasada a la vez.
 */
let revisando = false;
export async function revisarPendientes(contexto, { limite = 5 } = {}) {
    const { pool, config, ia } = contexto;
    if (!ia || !ia.activo || revisando) return 0;
    revisando = true;
    let hechas = 0;
    try {
        const [pendientes] = await pool.query(
            `SELECT r.*, u.id AS uid, u.nombre, u.email, u.cargo, u.estado, u.paises, u.casas, v.intentos
             FROM reportes_semanales r JOIN usuarios u ON u.id = r.usuario_id
             LEFT JOIN reportes_revisiones v ON v.usuario_id = r.usuario_id AND v.semana = r.semana
             WHERE r.entregado > UTC_TIMESTAMP() - INTERVAL 21 DAY
               AND (v.usuario_id IS NULL OR v.entrega < r.entregado
                    OR (v.revision IS NULL AND v.intentos < 3 AND v.revisado < UTC_TIMESTAMP() - INTERVAL 10 MINUTE))
             ORDER BY r.entregado LIMIT ?`, [limite]);
        for (const fila of pendientes) {
            const persona = { id: fila.uid, nombre: fila.nombre || fila.email, email: fila.email, cargo: fila.cargo, estado: fila.estado, paises: fila.paises, casas: fila.casas };
            const reporte = leerReporte(fila);
            const [[previa]] = await pool.query('SELECT * FROM reportes_semanales WHERE usuario_id = ? AND semana < ? ORDER BY semana DESC LIMIT 1', [persona.id, fila.semana]);
            try {
                const { datos, modelo } = await ia.revisarReporte({
                    persona: { nombre: persona.nombre, cargo: ambitoDe(persona, config).cargo }, reporte, anterior: leerReporte(previa)
                });
                await pool.query(
                    `INSERT INTO reportes_revisiones (usuario_id, semana, revision, modelo, intentos, error, entrega, revisado) VALUES (?, ?, ?, ?, 0, '', ?, UTC_TIMESTAMP(3))
                     ON DUPLICATE KEY UPDATE revision = VALUES(revision), modelo = VALUES(modelo), intentos = 0, error = '', entrega = VALUES(entrega), revisado = UTC_TIMESTAMP(3)`,
                    [persona.id, fila.semana, JSON.stringify(datos), modelo, fila.entregado]);
                await avisarRevisores(contexto, persona, `📋 Reporte semanal · ${persona.nombre}${datos.atencion ? ' · ⚠️ conviene hablar' : ''}\n${String(datos.resumen).slice(0, 300)}`);
                hechas++;
            } catch (error) {
                (contexto.registrar || console).error(`Revisión del reporte de ${persona.email} (${fila.semana}):`, error.message);
                await pool.query(
                    `INSERT INTO reportes_revisiones (usuario_id, semana, revision, intentos, error, entrega, revisado) VALUES (?, ?, NULL, 1, ?, ?, UTC_TIMESTAMP(3))
                     ON DUPLICATE KEY UPDATE revision = NULL, intentos = IF(entrega < VALUES(entrega), 1, intentos + 1),
                         error = VALUES(error), entrega = VALUES(entrega), revisado = UTC_TIMESTAMP(3)`,
                    [persona.id, fila.semana, String(error.message).slice(0, 300), fila.entregado]);
                const [[estado]] = await pool.query('SELECT intentos FROM reportes_revisiones WHERE usuario_id = ? AND semana = ?', [persona.id, fila.semana]);
                if (estado.intentos >= 3) await avisarRevisores(contexto, persona, `📋 Reporte semanal · ${persona.nombre}\n${textoCuentas(reporte.actividades)}`);
            }
        }
    } finally {
        revisando = false;
    }
    return hechas;
}

// Lunes desde REPORTE_RESUMEN_HORA: resumen de la semana pasada de todo el equipo para los Master (una vez)
export async function resumenDelLunes(contexto, ahora = new Date()) {
    const { pool, config, avisos } = contexto;
    if (!iaActiva(contexto) || !config.reporteSemanal) return false;
    const local = enZona(ahora, config.zonaHoraria);
    if (diaSemana(local.fecha) !== 0 || local.hora < config.reporteResumenHora) return false;
    const semana = semanaDe(sumarDias(local.fecha, -7));
    const [[hecho]] = await pool.query('SELECT 1 AS si FROM reportes_avisos_equipo WHERE semana = ?', [semana]);
    if (hecho) return false;
    const equipo = await equipoVisible(pool, config, { master: true }, 0, semana);
    if (!equipo.some(p => p.reporte)) return false;
    const resumen = await resumirEquipo(contexto, semana, equipo);
    const [r] = await pool.query('INSERT IGNORE INTO reportes_avisos_equipo (semana) VALUES (?)', [semana]);
    if (!r.affectedRows || !config.google.admins.length) return true;
    const [masters] = await pool.query('SELECT id FROM usuarios WHERE email IN (?)', [config.google.admins]);
    await registrarAviso(pool, masters.map(m => m.id), 'reporte', `Resumen del equipo de la semana ${Number(semana.slice(6))}: ${String(resumen.resumen).slice(0, 300)}`);
    if (!avisos.pushActivo) return true;
    const { huellas } = await destinosDe(pool, masters.map(m => m.id));
    await encolar(pool, 'push', huellas, `📋 Semana ${Number(semana.slice(6))} del equipo · ${equipo.filter(p => p.reporte).length} de ${equipo.length} reportes\n${String(resumen.resumen).slice(0, 300)}`);
    return true;
}

// Recordatorio del viernes a REPORTE_HORA a quien no entregó el de esta semana (una vez por semana)
export async function recordarReportes({ pool, config, avisos }, ahora = new Date()) {
    if (!config.reporteSemanal || !(avisos.pushActivo || avisos.whatsappActivo)) return 0;
    const local = enZona(ahora, config.zonaHoraria);
    // Texto, hora y plantilla de WhatsApp: los que fijó el Master en la Torre de control (por defecto, los de siempre)
    const mensaje = (await leerMensajes(pool)).recordatorio;
    const hora = mensaje.hora !== null && mensaje.hora !== undefined ? mensaje.hora : config.reporteHora;
    if (diaSemana(local.fecha) !== 4 || local.hora < hora) return 0;
    const semana = semanaDe(local.fecha);
    const [personas] = await pool.query(
        `SELECT u.* FROM usuarios u LEFT JOIN reportes_semanales r ON r.usuario_id = u.id AND r.semana = ?
         WHERE u.estado = 'aprobado' AND r.usuario_id IS NULL`, [semana]);
    let n = 0;
    for (const p of personas.filter(x => debeReportar(x, config))) {
        const [r] = await pool.query('INSERT IGNORE INTO reportes_recordatorios (usuario_id, semana) VALUES (?, ?)', [p.id, semana]);
        if (!r.affectedRows) continue; // Ya se le recordó esta semana
        const { huellas, telefonos } = await destinosDe(pool, [p.id]);
        const texto = renderizar(mensaje.texto, { vendedor: (p.nombre || '').split(' ')[0] || 'equipo' });
        await registrarAviso(pool, [p.id], 'reporte', texto.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
        const seguimiento = { origen: 'recordatorio', usuarioId: p.id };
        if (avisos.pushActivo) n += await encolar(pool, 'push', huellas, texto, null, null, seguimiento);
        if (avisos.whatsappActivo) n += await encolar(pool, 'whatsapp', telefonos, texto, mensaje.plantillaWhatsapp || null, null, seguimiento);
    }
    return n;
}

// Cada 5 minutos: recordatorio del viernes y, con IA, revisiones pendientes y resumen del lunes
export function iniciarRecordatorios(contexto, { cadaMs = 5 * 60000 } = {}) {
    const registrar = contexto.registrar || console;
    const temporizador = setInterval(() => {
        recordarReportes(contexto).catch(e => registrar.error('Recordatorio del reporte semanal:', e.message));
        // Con IA: las revisiones que quedaron pendientes (reinicio del servidor, fallo de la API) y el resumen del lunes
        revisarPendientes(contexto).catch(e => registrar.error('Revisión de reportes:', e.message));
        resumenDelLunes(contexto).catch(e => registrar.error('Resumen del equipo del lunes:', e.message));
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}
