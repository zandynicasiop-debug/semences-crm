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
 */
import crypto from 'node:crypto';
import { ambitoDe } from './permisos.js';
import { destinosDe } from './cuentas.js';
import { encolar } from './cola.js';
import { enZona, inicioDelDia, sumarDias } from './fechas.js';
import * as db from './db.js';

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
        entregado DATETIME NOT NULL,
        PRIMARY KEY (usuario_id, semana),
        INDEX (semana)
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

async function actividadesDe(pool, usuario, desde) {
    const { tareas = [] } = await db.listarTodo(pool);
    return tareas.filter(t => esMia(t, usuario) && (!t.hecha || String(t.hecha) >= desde))
        .map(t => ({
            id: t.id, titulo: t.titulo, prioridad: t.prioridad || '', vence: t.vence || '',
            estado: t.estadoSemanal || (t.hecha ? 'Completada' : 'En progreso'), comentario: t.comentarioSemanal || '',
            cerrada: Boolean(t.hecha)
        }))
        .sort((x, y) => Number(x.cerrada) - Number(y.cerrada) || (x.estado === 'Retrasada' ? -1 : 0) - (y.estado === 'Retrasada' ? -1 : 0));
}

// ¿Esta persona de administración ve el reporte de aquella? Master: todos; administrativo: si comparten país y casa
function veReporteDe(ambito, persona, config) {
    if (ambito.master) return true;
    if (ambito.cargo !== 'administrativo') return false;
    const otra = ambitoDe(persona, config);
    return otra.paises.some(p => ambito.paises.includes(p)) && otra.casas.some(c => ambito.casas.includes(c));
}

const leerReporte = (fila) => fila && ({ semana: fila.semana, resumen: fila.resumen, actividades: JSON.parse(fila.actividades || '[]'), entregado: fila.entregado });

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
            actividades: await actividadesDe(pool, usuario, inicioDelDia(diasDeSemana(semana).lunes, config.zonaHoraria).toISOString())
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
        const { tareas = [] } = await db.listarTodo(pool);
        const actividades = [];
        for (const a of lista) {
            const titulo = String(a.titulo || '').trim().replace(/\s+/g, ' ').slice(0, 200);
            const estado = String(a.estado || '');
            const comentario = String(a.comentario || '').trim().slice(0, 1000);
            if (!ESTADOS_ACTIVIDAD.includes(estado)) throw errorApp(`Elige el estado de «${titulo || 'la actividad'}»`);
            if (comentario.length < COMENTARIO_MINIMO) throw errorApp(`Escribe un comentario de cómo va «${titulo || 'la actividad'}»`);
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
                const cierra = CIERRAN.includes(a.estado);
                const tarea = a.existente
                    ? { ...a.existente }
                    : { id: `rs-${crypto.randomUUID()}`, titulo: a.titulo, prioridad: 'Media', vence: '', para: nombre, creadaPor: nombre, creada: ahora, hecha: '', hechaPor: '' };
                Object.assign(tarea, {
                    estadoSemanal: a.estado, comentarioSemanal: a.comentario, reportada: semana, cuenta: usuario.email,
                    hecha: cierra ? (tarea.hecha || ahora) : '', hechaPor: cierra ? (tarea.hechaPor || nombre) : ''
                });
                await db.guardarRegistro(conexion, 'tareas', tarea, usuario.id);
                a.id = tarea.id;
            }
            await conexion.query(
                `INSERT INTO reportes_semanales (usuario_id, semana, resumen, actividades, entregado) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE resumen = VALUES(resumen), actividades = VALUES(actividades), entregado = UTC_TIMESTAMP()`,
                [usuario.id, semana, resumen, JSON.stringify(actividades.map(({ id, titulo, estado, comentario }) => ({ id, titulo, estado, comentario })))]);
            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }
        // Aviso a quien lo revisa (Master y administrativos de su país y casa)
        if (avisos.pushActivo) {
            const [personas] = await pool.query(`SELECT * FROM usuarios WHERE id <> ? AND (estado = 'aprobado' OR email IN (?))`,
                [usuario.id, config.google.admins.length ? config.google.admins : ['']]);
            const revisan = personas.filter(p => veReporteDe(ambitoDe(p, config), usuario, config));
            if (revisan.length) {
                const cuenta = (e) => actividades.filter(a => a.estado === e).length;
                const { huellas } = await destinosDe(pool, revisan.map(p => p.id));
                await encolar(pool, 'push', huellas, `📋 Reporte semanal · ${nombre}\n${cuenta('Completada')} completadas · ${cuenta('En progreso')} en progreso · ${cuenta('Retrasada')} retrasadas · ${cuenta('Terminada sin éxito')} sin éxito`);
            }
        }
        return { ok: true, semana, desbloqueado: true };
    }

    if (op === 'equipo') {
        if (!(ambito.master || ambito.cargo === 'administrativo')) throw errorApp('Los reportes del equipo los ven los Master y administración', 403, 'acceso');
        const semana = semanaValida(datos.semana) ? datos.semana : s.anterior;
        const [personas] = await pool.query(`SELECT * FROM usuarios WHERE estado = 'aprobado' AND id <> ? ORDER BY nombre`, [usuario.id]);
        const [filas] = await pool.query('SELECT * FROM reportes_semanales WHERE semana = ?', [semana]);
        const porPersona = new Map(filas.map(f => [f.usuario_id, f]));
        const equipo = personas.filter(p => debeReportar(p, config) && veReporteDe(ambito, p, config)).map(p => ({
            email: p.email, nombre: p.nombre || p.email, cargo: ambitoDe(p, config).cargo,
            reporte: leerReporte(porPersona.get(p.id)) || null
        }));
        return { ok: true, semana, dias: diasDeSemana(semana), actual: s.actual, anterior: s.anterior, equipo };
    }

    throw errorApp('Operación desconocida del reporte semanal');
}

// Recordatorio del viernes a REPORTE_HORA a quien no entregó el de esta semana (una vez por semana)
export async function recordarReportes({ pool, config, avisos }, ahora = new Date()) {
    if (!config.reporteSemanal || !(avisos.pushActivo || avisos.whatsappActivo)) return 0;
    const local = enZona(ahora, config.zonaHoraria);
    if (diaSemana(local.fecha) !== 4 || local.hora < config.reporteHora) return 0;
    const semana = semanaDe(local.fecha);
    const [personas] = await pool.query(
        `SELECT u.* FROM usuarios u LEFT JOIN reportes_semanales r ON r.usuario_id = u.id AND r.semana = ?
         WHERE u.estado = 'aprobado' AND r.usuario_id IS NULL`, [semana]);
    let n = 0;
    for (const p of personas.filter(x => debeReportar(x, config))) {
        const [r] = await pool.query('INSERT IGNORE INTO reportes_recordatorios (usuario_id, semana) VALUES (?, ?)', [p.id, semana]);
        if (!r.affectedRows) continue; // Ya se le recordó esta semana
        const { huellas, telefonos } = await destinosDe(pool, [p.id]);
        const texto = `📋 Hola, ${(p.nombre || '').split(' ')[0] || 'equipo'}: entrega hoy tu reporte semanal (menú › Reporte semanal). Desde el lunes la app lo pide antes de seguir.`;
        if (avisos.pushActivo) n += await encolar(pool, 'push', huellas, texto);
        if (avisos.whatsappActivo) n += await encolar(pool, 'whatsapp', telefonos, texto);
    }
    return n;
}

export function iniciarRecordatorios(contexto, { cadaMs = 5 * 60000 } = {}) {
    const temporizador = setInterval(() => {
        recordarReportes(contexto).catch(e => (contexto.registrar || console).error('Recordatorio del reporte semanal:', e.message));
    }, cadaMs);
    temporizador.unref();
    return () => clearInterval(temporizador);
}
