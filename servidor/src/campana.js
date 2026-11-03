/**
 * Avisos por persona (la campana de la app): todo lo que le llega a alguien queda aquí, además del push
 * y el WhatsApp, para verlo junto y marcarlo como leído. Lo registran los mismos sitios que avisan:
 * mensajes directos, clientes que te pasan, tareas y reuniones, germinación baja, envíos, Instagram,
 * reportes semanales y metas.
 */
import { traducir, idiomasDe } from './idioma.js';

export const ESQUEMA_CAMPANA = [
    `CREATE TABLE IF NOT EXISTS avisos_persona (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT UNSIGNED NOT NULL,
        tipo VARCHAR(20) NOT NULL,
        texto VARCHAR(600) NOT NULL,
        enlace VARCHAR(500) NOT NULL DEFAULT '',
        leido TINYINT(1) NOT NULL DEFAULT 0,
        creado DATETIME(3) NOT NULL,
        INDEX (usuario_id, leido, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

// Qué abre la app al tocar el aviso (y su icono): un módulo, la agenda, los mensajes…
export const TIPOS_AVISO = ['mensaje', 'cliente', 'tarea', 'reunion', 'germinador', 'envio', 'instagram', 'reporte', 'meta', 'cotizacion'];

export async function registrarAviso(pool, usuarioIds, tipo, texto, enlace = '') {
    const ids = [...new Set(usuarioIds.filter(Boolean))];
    if (!ids.length) return 0;
    const t = TIPOS_AVISO.includes(tipo) ? tipo : 'mensaje';
    // Cada uno en su idioma: el aviso queda escrito como se le mostró
    const idiomas = await idiomasDe(pool, ids);
    const filas = ids.map(id => [id, t, traducir(String(texto), idiomas.get(id)).slice(0, 600), String(enlace || '').slice(0, 500), new Date()]);
    const [r] = await pool.query('INSERT INTO avisos_persona (usuario_id, tipo, texto, enlace, creado) VALUES ?', [filas]);
    return r.affectedRows;
}

export async function avisosSinLeer(pool, usuarioId) {
    const [[fila]] = await pool.query('SELECT COUNT(*) n FROM avisos_persona WHERE usuario_id = ? AND leido = 0', [usuarioId]);
    return Number(fila.n);
}

// Acción "avisos": { operacion: 'listar' (los 60 últimos) | 'leer' (ids, o todos) }
export async function accionAvisos(datos, { pool, usuario }) {
    if (datos.operacion === 'leer') {
        const ids = Array.isArray(datos.ids) ? datos.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
        if (ids.length) await pool.query('UPDATE avisos_persona SET leido = 1 WHERE usuario_id = ? AND id IN (?)', [usuario.id, ids]);
        else await pool.query('UPDATE avisos_persona SET leido = 1 WHERE usuario_id = ? AND leido = 0', [usuario.id]);
    }
    const [filas] = await pool.query(
        'SELECT id, tipo, texto, enlace, leido, creado FROM avisos_persona WHERE usuario_id = ? ORDER BY id DESC LIMIT 60', [usuario.id]);
    return { ok: true, sinLeer: await avisosSinLeer(pool, usuario.id), avisos: filas.map(f => ({ ...f, leido: Boolean(f.leido) })) };
}
