/**
 * Metas mensuales por persona y su avance, calculado aquí con los datos del CRM (nadie lo escribe a mano).
 *
 * - Las fijan los Master (a cualquiera) y los administrativos (a quien comparte país y casa con ellos,
 *   no a sí mismos). Cada persona ve solo las suyas; administración, las de su equipo.
 * - Indicadores y de dónde sale el avance en el mes (en la zona horaria del equipo):
 *   ventas: miles de semillas de los pedidos Confirmados o Entregados de sus clientes (el vendedor
 *     asignado al cliente o, si no tiene, quien registró el pedido);
 *   clientes: clientes creados en el mes asignados a la persona (o creados por ella sin asignar);
 *   visitas: visitas con fecha del mes registradas por la persona;
 *   ensayos: ensayos de validación por variedad (cliente + lote + variedad distintos) con inicio en el mes;
 *   actividades: % de actividades completadas en sus reportes semanales de las semanas del mes.
 */
import { ambitoDe } from './permisos.js';
import { enZona } from './fechas.js';
import { diasDeSemana } from './reportes.js';
import { registrarAviso } from './campana.js';
import * as db from './db.js';

export const INDICADORES = {
    ventas: 'Ventas (miles de semillas)',
    clientes: 'Clientes nuevos',
    visitas: 'Visitas a clientes',
    ensayos: 'Ensayos de validación por variedad',
    actividades: 'Actividades cumplidas (%)'
};

export const ESQUEMA_METAS = [
    `CREATE TABLE IF NOT EXISTS metas (
        usuario_id INT UNSIGNED NOT NULL,
        mes CHAR(7) NOT NULL,
        indicador VARCHAR(20) NOT NULL,
        objetivo DECIMAL(12, 2) NOT NULL,
        fijada_por VARCHAR(190) NOT NULL DEFAULT '',
        actualizada DATETIME NOT NULL,
        PRIMARY KEY (usuario_id, mes, indicador)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

const mesValido = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const correo = (t) => String(t || '').trim().toLowerCase();

// ¿Puede fijar metas a esta persona? Master: a cualquiera. Administrativo: a quien comparte país y casa (no a sí mismo)
function puedeFijar(ambito, yo, persona, config) {
    if (ambito.master) return true;
    if (ambito.cargo !== 'administrativo' || persona.id === yo.id) return false;
    const otra = ambitoDe(persona, config);
    return otra.paises.some(p => ambito.paises.includes(p)) && otra.casas.some(c => ambito.casas.includes(c));
}

/**
 * Avance de cada indicador de una persona en un mes. datos: todo el CRM (db.listarTodo).
 */
export async function avanceDe(pool, config, persona, mes, datos) {
    const email = correo(persona.email);
    const delMes = (fecha) => String(fecha || '').startsWith(mes);
    const creadoEnMes = (iso) => iso && !Number.isNaN(new Date(iso).getTime()) && enZona(new Date(iso), config.zonaHoraria).fecha.startsWith(mes);
    const autor = (r) => correo(r.creadoPor || r.cuenta);
    const clientes = new Map((datos.clientes || []).map(c => [c.id, c]));

    const ventas = (datos.pedidos || [])
        .filter(p => delMes(p.fecha) && ['Confirmado', 'Entregado'].includes(p.estado))
        .filter(p => correo((clientes.get(p.clienteId) || {}).asignado || p.creadoPor || p.cuenta) === email)
        .reduce((s, p) => s + (Number(p.semillasMiles) || 0), 0);
    const clientesNuevos = (datos.clientes || []).filter(c => creadoEnMes(c.creado) && correo(c.asignado || c.creadoPor || c.cuenta) === email).length;
    const visitas = (datos.visitas || []).filter(v => delMes(v.fecha) && autor(v) === email).length;
    const ensayos = new Set((datos.agronomia || [])
        .filter(a => delMes(a.fechaInicio) && a.variedad && autor(a) === email)
        .map(a => `${a.clienteId || a.cliente || ''}|${String(a.lote || '').toLowerCase()}|${String(a.variedad).toLowerCase()}`)).size;

    // Actividades: las de los reportes de las semanas que empiezan en el mes
    const [reportes] = await pool.query('SELECT semana, actividades FROM reportes_semanales WHERE usuario_id = ?', [persona.id]);
    let total = 0, hechas = 0;
    reportes.filter(r => diasDeSemana(r.semana).lunes.startsWith(mes)).forEach(r => {
        JSON.parse(r.actividades || '[]').forEach(a => { total++; if (a.estado === 'Completada') hechas++; });
    });
    return {
        ventas: Math.round(ventas * 10) / 10,
        clientes: clientesNuevos,
        visitas,
        ensayos,
        actividades: total ? Math.round((hechas / total) * 100) : 0
    };
}

/**
 * Acción "metas". operacion:
 * - listar { mes }: las metas del mes con su avance; administración ve las de su equipo (y a quién puede fijar);
 * - guardar { email, mes, indicador, objetivo } y quitar { email, mes, indicador }: Master y administración.
 */
export async function accionMetas(datos, contexto, { errorApp }) {
    const { pool, config, usuario, ambito } = contexto;
    const hoy = enZona(new Date(), config.zonaHoraria).fecha;
    const mes = mesValido(datos.mes) ? datos.mes : hoy.slice(0, 7);
    const op = datos.operacion || 'listar';
    const fija = ambito.master || ambito.cargo === 'administrativo';

    if (op === 'guardar' || op === 'quitar') {
        if (!fija) throw errorApp('Las metas las fijan los Master y administración', 403, 'acceso');
        const [[persona]] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [correo(datos.email)]);
        if (!persona || ambitoDe(persona, config).estado !== 'aprobado') throw errorApp('Esa persona no está en el equipo', 404);
        if (!puedeFijar(ambito, usuario, persona, config)) throw errorApp('No puedes fijar metas a esa persona (país o casa comercial, o es tu propia meta)', 403, 'permiso');
        if (!Object.hasOwn(INDICADORES, datos.indicador)) throw errorApp('Elige qué se mide');
        if (op === 'quitar') {
            await pool.query('DELETE FROM metas WHERE usuario_id = ? AND mes = ? AND indicador = ?', [persona.id, mes, datos.indicador]);
        } else {
            const objetivo = Number(datos.objetivo);
            if (!(objetivo > 0) || objetivo > 1e7 || (datos.indicador === 'actividades' && objetivo > 100)) throw errorApp('Escribe una meta mayor que 0 (en actividades, un % hasta 100)');
            await pool.query(
                `INSERT INTO metas (usuario_id, mes, indicador, objetivo, fijada_por, actualizada) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE objetivo = VALUES(objetivo), fijada_por = VALUES(fijada_por), actualizada = UTC_TIMESTAMP()`,
                [persona.id, mes, datos.indicador, objetivo, usuario.email]);
            if (persona.id !== usuario.id) {
                await registrarAviso(pool, [persona.id], 'meta', `${usuario.nombre || usuario.email} fijó tu meta de ${mes}: ${INDICADORES[datos.indicador]} = ${objetivo}`);
            }
        }
    } else if (op !== 'listar') {
        throw errorApp('Operación desconocida de metas');
    }

    // Personas que ve: administración, su equipo (y a sí misma); el resto, solo a sí misma
    const [aprobados] = await pool.query(`SELECT * FROM usuarios WHERE estado = 'aprobado' OR email IN (?) ORDER BY nombre`,
        [config.google.admins.length ? config.google.admins : ['']]);
    const personas = aprobados.filter(p => p.id === usuario.id || (fija && puedeFijar(ambito, usuario, p, config)));
    const [filas] = personas.length
        ? await pool.query('SELECT * FROM metas WHERE mes = ? AND usuario_id IN (?)', [mes, personas.map(p => p.id)])
        : [[]];
    const crm = await db.listarTodo(pool);
    const resultado = [];
    for (const p of personas) {
        const suyas = filas.filter(f => f.usuario_id === p.id);
        const avance = await avanceDe(pool, config, p, mes, crm);
        resultado.push({
            email: p.email, nombre: p.nombre || p.email, cargo: ambitoDe(p, config).cargo, yo: p.id === usuario.id,
            puedoFijar: fija && puedeFijar(ambito, usuario, p, config),
            metas: suyas.map(f => {
                const objetivo = Number(f.objetivo);
                const valor = avance[f.indicador] ?? 0;
                return { indicador: f.indicador, nombre: INDICADORES[f.indicador], objetivo, avance: valor, porcentaje: Math.min(100, Math.round((valor / objetivo) * 100)), fijadaPor: f.fijada_por };
            }),
            avance
        });
    }
    return { ok: true, mes, indicadores: INDICADORES, puedoFijar: fija, personas: resultado };
}
