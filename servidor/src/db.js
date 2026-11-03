/**
 * Base de datos MySQL (o MariaDB, la que trae cPanel). Las tablas se crean solas al arrancar.
 *
 * Los registros del CRM se guardan como en la hoja de Google de antes: una fila por registro,
 * identificada por módulo + id, con el registro completo en JSON. Así la app no cambia y un
 * módulo nuevo o un campo nuevo no necesitan tocar la base.
 */
import mysql from 'mysql2/promise';
import { ESQUEMA_INSTAGRAM } from './instagram.js';
import { ESQUEMA_REPORTES } from './reportes.js';
import { ESQUEMA_EVENTOS } from './eventos.js';

export const MODULOS_CRM = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'sitios', 'mensajes', 'tareas'];

const ESQUEMA = [
    `CREATE TABLE IF NOT EXISTS usuarios (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        nombre VARCHAR(200) NOT NULL DEFAULT '',
        foto VARCHAR(1000) NOT NULL DEFAULT '',
        token_google TEXT NULL,
        permisos_google TEXT NULL,
        telefono VARCHAR(20) NOT NULL DEFAULT '',
        hoja_exportacion VARCHAR(100) NOT NULL DEFAULT '',
        estado ENUM('pendiente', 'aprobado', 'rechazado') NOT NULL DEFAULT 'pendiente',
        cargo VARCHAR(20) NULL,
        paises VARCHAR(100) NOT NULL DEFAULT '[]',
        casas VARCHAR(300) NOT NULL DEFAULT '[]',
        solicitado DATETIME NULL,
        aprobado_por VARCHAR(254) NULL,
        aprobado_en DATETIME NULL,
        visto DATETIME NULL,
        presencia VARCHAR(20) NOT NULL DEFAULT 'disponible',
        resumen_activo TINYINT(1) NOT NULL DEFAULT 1,
        resumen_fecha DATE NULL,
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ultimo_acceso DATETIME NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sesiones (
        huella CHAR(64) PRIMARY KEY,
        usuario_id INT UNSIGNED NOT NULL,
        creada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        caduca DATETIME NOT NULL,
        INDEX (usuario_id),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS codigos (
        huella CHAR(64) PRIMARY KEY,
        usuario_id INT UNSIGNED NOT NULL,
        reto CHAR(43) NOT NULL,
        caduca DATETIME NOT NULL,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS equipo (
        email VARCHAR(254) PRIMARY KEY,
        nombre VARCHAR(200) NOT NULL DEFAULT '',
        telefono VARCHAR(20) NOT NULL DEFAULT '',
        notas VARCHAR(500) NOT NULL DEFAULT ''
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS directos (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        de_id INT UNSIGNED NOT NULL,
        para_id INT UNSIGNED NOT NULL,
        tipo VARCHAR(20) NOT NULL DEFAULT 'mensaje',
        texto VARCHAR(2000) NOT NULL,
        enlace VARCHAR(500) NOT NULL DEFAULT '',
        leido TINYINT(1) NOT NULL DEFAULT 0,
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (para_id, id),
        FOREIGN KEY (de_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        FOREIGN KEY (para_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS registros (
        modulo VARCHAR(20) NOT NULL,
        id VARCHAR(100) NOT NULL,
        datos LONGTEXT NOT NULL,
        autor_id INT UNSIGNED NULL,
        actualizado DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (modulo, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS push_suscripciones (
        huella CHAR(64) PRIMARY KEY,
        usuario_id INT UNSIGNED NOT NULL,
        endpoint VARCHAR(1000) NOT NULL,
        p256dh VARCHAR(200) NOT NULL,
        auth VARCHAR(100) NOT NULL,
        creada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (usuario_id),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS cola_avisos (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        canal ENUM('whatsapp', 'push') NOT NULL DEFAULT 'whatsapp',
        destino VARCHAR(64) NOT NULL,
        plantilla VARCHAR(100) NULL,
        parametros TEXT NULL,
        texto VARCHAR(1000) NOT NULL,
        estado ENUM('pendiente', 'enviando', 'enviado', 'fallido') NOT NULL DEFAULT 'pendiente',
        intentos TINYINT UNSIGNED NOT NULL DEFAULT 0,
        proximo DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        marca CHAR(36) NULL,
        reclamado DATETIME NULL,
        enviado DATETIME NULL,
        error VARCHAR(500) NOT NULL DEFAULT '',
        creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (estado, proximo)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS metricas (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        fecha DATETIME NOT NULL,
        datos TEXT NOT NULL,
        usuario_id INT UNSIGNED NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

export async function conectar(configMysql) {
    const pool = mysql.createPool({
        ...configMysql,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5,      // Hosting compartido: pocas conexiones a la vez
        multipleStatements: false, // Una sentencia por consulta: un texto con "; DROP TABLE…" nunca se ejecuta
        timezone: 'Z',           // Fechas siempre en UTC dentro de la base
        dateStrings: false
    });
    // La hora de la base en UTC en cada conexión: en un hosting compartido el servidor puede estar en
    // otra zona, y CURRENT_TIMESTAMP tiene que cuadrar con UTC_TIMESTAMP() (sesiones, cola de avisos)
    pool.pool.on('connection', (conexion) => conexion.query("SET time_zone = '+00:00'"));
    const sentencias = [...ESQUEMA, ...ESQUEMA_INSTAGRAM, ...ESQUEMA_REPORTES, ...ESQUEMA_EVENTOS];
    for (const sql of sentencias) await pool.query(sql);
    await ponerAlDia(pool, sentencias);
    return pool;
}

// Columnas que cambiaron de nombre entre versiones: [tabla, nombre antiguo, nombre actual]. El dato se conserva
const RENOMBRADAS = [['cola_avisos', 'telefono', 'destino']];

// Columnas de un CREATE TABLE: una por línea, sin índices ni claves, sin comentarios "-- …"
export function columnasDe(sql) {
    const m = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*CHARACTER SET/.exec(sql);
    if (!m) return null;
    const columnas = m[2].split('\n')
        .map(linea => linea.replace(/\s--\s.*$/, '').trim().replace(/,$/, '').trim())
        .filter(linea => linea && !/^(INDEX|PRIMARY|FOREIGN|UNIQUE|KEY|CONSTRAINT)\b/i.test(linea))
        .map(definicion => ({ nombre: definicion.split(/\s+/)[0], definicion }));
    return { tabla: m[1], columnas };
}

/**
 * Pone al día una base creada por una versión anterior del backend. CREATE TABLE IF NOT EXISTS no toca una
 * tabla que ya existe: sin esto, las columnas añadidas después (estado, cargo, paises, casas… en usuarios;
 * canal, destino, plantilla… en cola_avisos) faltarían y la app fallaría con "Unknown column" al entrar.
 * Añade lo que falta con su definición actual (las filas que ya hay toman su valor por defecto) y renombra
 * lo que cambió de nombre. Nunca borra columnas ni datos. Igual en MySQL 8.4 y MariaDB 10.11.
 */
export async function ponerAlDia(pool, sentencias, registrar = console) {
    const [filas] = await pool.query('SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
    const existen = new Map();
    for (const { tabla, columna } of filas) {
        if (!existen.has(tabla)) existen.set(tabla, new Set());
        existen.get(tabla).add(columna);
    }
    const cambios = [];
    for (const sql of sentencias) {
        const esquema = columnasDe(sql);
        if (!esquema || !existen.has(esquema.tabla)) continue;
        const { tabla, columnas } = esquema;
        const actuales = existen.get(tabla);
        for (const { nombre, definicion } of columnas) {
            if (actuales.has(nombre)) continue;
            const renombrada = RENOMBRADAS.find(([t, antes, ahora]) => t === tabla && ahora === nombre && actuales.has(antes));
            if (renombrada) {
                await pool.query(`ALTER TABLE \`${tabla}\` CHANGE COLUMN \`${renombrada[1]}\` ${definicion}`);
                actuales.delete(renombrada[1]);
                cambios.push(`${tabla}.${renombrada[1]} → ${nombre}`);
            } else if (/PRIMARY KEY|AUTO_INCREMENT|UNIQUE/i.test(definicion)) {
                // Una clave no se puede añadir a ciegas a una tabla con filas: que lo vea quien despliega
                registrar.error(`Esquema: falta ${tabla}.${nombre} (${definicion}) y no se añade sola; revísalo a mano`);
                continue;
            } else {
                await pool.query(`ALTER TABLE \`${tabla}\` ADD COLUMN ${definicion}`);
                cambios.push(`${tabla}.${nombre}`);
            }
            actuales.add(nombre);
        }
    }
    if (cambios.length) registrar.log(`Base puesta al día (${cambios.length}): ${cambios.join(', ')}`);
    return cambios;
}

// ----- Registros del CRM -----

export function comprobarModulo(modulo) {
    if (!MODULOS_CRM.includes(modulo)) {
        const error = new Error(`Módulo de CRM desconocido: ${modulo}`);
        error.estado = 400;
        throw error;
    }
}

export async function guardarRegistro(conexion, modulo, registro, autorId) {
    comprobarModulo(modulo);
    if (!registro || typeof registro !== 'object' || Array.isArray(registro) || !registro.id) {
        const error = new Error('Registro sin id');
        error.estado = 400;
        throw error;
    }
    const id = String(registro.id).slice(0, 100);
    await conexion.query(
        `INSERT INTO registros (modulo, id, datos, autor_id) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE datos = VALUES(datos), autor_id = VALUES(autor_id)`,
        [modulo, id, JSON.stringify({ ...registro, id }), autorId || null]
    );
}

export async function eliminarRegistro(conexion, modulo, id) {
    comprobarModulo(modulo);
    await conexion.query('DELETE FROM registros WHERE modulo = ? AND id = ?', [modulo, String(id)]);
}

// Todos los registros, agrupados por módulo: { clientes: [...], visitas: [...], ... }
export async function listarTodo(conexion) {
    const datos = Object.fromEntries(MODULOS_CRM.map(m => [m, []]));
    const [filas] = await conexion.query('SELECT modulo, datos FROM registros ORDER BY actualizado');
    for (const fila of filas) {
        if (!datos[fila.modulo]) continue;
        try { datos[fila.modulo].push(JSON.parse(fila.datos)); } catch (e) { /* fila dañada: se ignora */ }
    }
    return datos;
}

export async function leerRegistro(conexion, modulo, id, bloquear = false) {
    const [filas] = await conexion.query(`SELECT datos FROM registros WHERE modulo = ? AND id = ?${bloquear ? ' FOR UPDATE' : ''}`, [modulo, String(id)]);
    if (!filas.length) return null;
    try { return JSON.parse(filas[0].datos); } catch (e) { return null; }
}

/**
 * Aplica los cambios de la app y devuelve la foto completa, todo en una transacción.
 * permitido(modulo, registro) decide si la persona puede escribir ese registro: se mira el registro
 * nuevo y también el que ya había (nadie puede pisar ni borrar lo que no le toca).
 * Devuelve { datos, guardados: [{ modulo, registro, anterior }] } (los guardados, para los avisos).
 * alConfirmar(conexion, guardados): se ejecuta dentro de la transacción, justo antes de confirmarla
 * (outbox transaccional: los eventos de eventos.js se guardan o se deshacen junto con los cambios).
 */
export async function sincronizar(pool, { guardar = [], eliminar = [] }, usuario, permitido = () => true, { alConfirmar = null } = {}) {
    // Cada cambio tiene que ser un objeto: un null o un texto en la lista es un 400, no un fallo interno
    const malformado = [...guardar, ...eliminar].some(op => !op || typeof op !== 'object' || Array.isArray(op));
    if (malformado) throw Object.assign(new Error('Cada cambio tiene que ser un objeto { modulo, registro } o { modulo, id }'), { estado: 400 });
    const conexion = await pool.getConnection();
    const rechazo = () => Object.assign(new Error('No tienes permiso para cambiar uno de esos registros (módulo, país o casa comercial)'), { estado: 403, codigo: 'permiso' });
    const guardados = [];
    try {
        await conexion.beginTransaction();
        for (const op of guardar) {
            comprobarModulo(op.modulo);
            const anterior = op.registro && op.registro.id ? await leerRegistro(conexion, op.modulo, op.registro.id, true) : null;
            if (!permitido(op.modulo, op.registro || {}) || (anterior && !permitido(op.modulo, anterior))) throw rechazo();
            // Cada registro guarda la cuenta verificada que lo subió, no lo que diga la app
            const registro = { ...op.registro, cuenta: usuario.email };
            await guardarRegistro(conexion, op.modulo, registro, usuario.id);
            guardados.push({ modulo: op.modulo, registro, anterior });
        }
        for (const op of eliminar) {
            comprobarModulo(op.modulo);
            const anterior = await leerRegistro(conexion, op.modulo, op.id, true);
            if (anterior && !permitido(op.modulo, anterior)) throw rechazo();
            await eliminarRegistro(conexion, op.modulo, op.id);
        }
        if (alConfirmar) await alConfirmar(conexion, guardados);
        const datos = await listarTodo(conexion);
        await conexion.commit();
        return { datos, guardados };
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
}
