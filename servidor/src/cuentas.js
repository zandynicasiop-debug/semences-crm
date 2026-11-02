/**
 * Usuarios, quién puede entrar, sesiones de la app y códigos de un solo uso (para la app Android).
 *
 * La sesión es un valor aleatorio que la app manda como "Authorization: Bearer …". En la base solo
 * queda su huella (SHA-256): si alguien leyera la tabla, no podría usar esas sesiones.
 */
import crypto from 'node:crypto';
import { aleatorio, huella, cifrar, descifrar } from './cifrado.js';

const ahoraMas = (ms) => new Date(Date.now() + ms);

// ¿Puede entrar esta cuenta? Todo el dominio de Workspace, los admins y quien esté en la tabla equipo
export async function cuentaAutorizada(pool, config, email, dominioCuenta) {
    const correo = String(email).toLowerCase();
    const { dominio, admins } = config.google;
    if (dominio && (dominioCuenta === dominio || correo.endsWith(`@${dominio}`))) return true;
    if (admins.includes(correo)) return true;
    const [filas] = await pool.query('SELECT 1 FROM equipo WHERE email = ?', [correo]);
    return filas.length > 0;
}

export const esAdmin = (config, email) => config.google.admins.includes(String(email).toLowerCase());

// Crea o actualiza la persona. El token de Google solo se cambia si llega uno nuevo
export async function guardarUsuario(pool, config, { email, nombre, foto, tokenRefresco, permisos }) {
    const correo = String(email).toLowerCase();
    const cifrado = tokenRefresco ? cifrar(tokenRefresco, config.claveCifrado) : null;
    await pool.query(
        `INSERT INTO usuarios (email, nombre, foto, token_google, permisos_google, ultimo_acceso)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), ultimo_acceso = UTC_TIMESTAMP(),
             token_google = COALESCE(VALUES(token_google), token_google),
             permisos_google = IF(VALUES(token_google) IS NULL, permisos_google, VALUES(permisos_google))`,
        [correo, String(nombre || '').slice(0, 200), String(foto || '').slice(0, 1000), cifrado, cifrado ? permisos || '' : null]
    );
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [correo]);
    return filas[0];
}

export function tokenDe(usuario, config) {
    return usuario.token_google ? descifrar(usuario.token_google, config.claveCifrado) : '';
}

// Google cambió el token de refresco: se guarda el nuevo cifrado
export async function actualizarToken(pool, config, usuarioId, tokenRefresco) {
    await pool.query('UPDATE usuarios SET token_google = ? WHERE id = ?', [cifrar(tokenRefresco, config.claveCifrado), usuarioId]);
}

// Google ya no acepta el token (la persona quitó el permiso): se borra para pedirlo de nuevo
export async function olvidarToken(pool, usuarioId) {
    await pool.query('UPDATE usuarios SET token_google = NULL, permisos_google = NULL WHERE id = ?', [usuarioId]);
}

export async function crearSesion(pool, config, usuarioId) {
    const sesion = aleatorio(32);
    await pool.query('INSERT INTO sesiones (huella, usuario_id, caduca) VALUES (?, ?, ?)',
        [huella(sesion), usuarioId, ahoraMas(config.diasSesion * 86400000)]);
    // De paso se limpian las caducadas
    await pool.query('DELETE FROM sesiones WHERE caduca < UTC_TIMESTAMP()');
    return sesion;
}

// La persona de esta sesión, o null si no existe o caducó. Cada uso alarga la sesión
export async function usuarioDeSesion(pool, config, sesion) {
    if (!sesion || sesion.length < 20) return null;
    const [filas] = await pool.query(
        `SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.huella = ? AND s.caduca > UTC_TIMESTAMP()`, [huella(sesion)]);
    if (!filas.length) return null;
    await pool.query('UPDATE sesiones SET caduca = ? WHERE huella = ?', [ahoraMas(config.diasSesion * 86400000), huella(sesion)]);
    return filas[0];
}

export async function cerrarSesion(pool, sesion) {
    await pool.query('DELETE FROM sesiones WHERE huella = ?', [huella(sesion)]);
}

/**
 * Código de un solo uso, válido 2 minutos: la app Android lo recibe al volver de Google y lo canjea.
 * Va atado al "reto" que mandó la app al empezar (SHA-256 de un secreto que solo ella guarda, como en
 * PKCE): otra app del teléfono que abra semences://sesion?codigo=… no puede canjearlo sin ese secreto.
 */
export async function crearCodigo(pool, usuarioId, reto) {
    const codigo = aleatorio(24);
    await pool.query('INSERT INTO codigos (huella, usuario_id, reto, caduca) VALUES (?, ?, ?, ?)', [huella(codigo), usuarioId, reto, ahoraMas(120000)]);
    await pool.query('DELETE FROM codigos WHERE caduca < UTC_TIMESTAMP()');
    return codigo;
}

export const retoDe = (verificador) => crypto.createHash('sha256').update(String(verificador)).digest('base64url');

export async function canjearCodigo(pool, codigo, verificador) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        const [filas] = await conexion.query(
            'SELECT usuario_id, reto FROM codigos WHERE huella = ? AND caduca > UTC_TIMESTAMP() FOR UPDATE', [huella(codigo)]);
        await conexion.query('DELETE FROM codigos WHERE huella = ?', [huella(codigo)]);
        await conexion.commit();
        if (!filas.length || !verificador || retoDe(verificador) !== filas[0].reto) return null;
        return filas[0].usuario_id;
    } catch (error) {
        await conexion.rollback();
        throw error;
    } finally {
        conexion.release();
    }
}

// Teléfonos para los avisos por WhatsApp: los de la tabla equipo y los que cada persona guardó
export async function telefonosDelEquipo(pool) {
    const [filas] = await pool.query(
        `SELECT telefono FROM equipo WHERE telefono <> ''
         UNION SELECT telefono FROM usuarios WHERE telefono <> ''`);
    return [...new Set(filas.map(f => f.telefono))];
}

export async function guardarTelefono(pool, usuarioId, telefono) {
    await pool.query('UPDATE usuarios SET telefono = ? WHERE id = ?', [telefono, usuarioId]);
}

// Vista pública de la persona (lo que se devuelve a la app)
export const publico = (usuario, config) => ({
    email: usuario.email,
    nombre: usuario.nombre,
    foto: usuario.foto,
    telefono: usuario.telefono,
    admin: esAdmin(config, usuario.email),
    googleConectado: Boolean(usuario.token_google),
    hojaExportacion: usuario.hoja_exportacion ? `https://docs.google.com/spreadsheets/d/${usuario.hoja_exportacion}/edit` : '',
    permisos: String(usuario.permisos_google || '').split(' ').filter(Boolean)
});

// ----- Suscripciones a avisos push (una por navegador o teléfono) -----

// Alta o actualización: si otra persona entra en el mismo navegador, la suscripción pasa a ser suya
export async function guardarSuscripcion(pool, usuarioId, { endpoint, p256dh, auth }) {
    await pool.query(
        `INSERT INTO push_suscripciones (huella, usuario_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
        [huella(endpoint), usuarioId, endpoint, p256dh, auth]);
}

export async function borrarSuscripcion(pool, usuarioId, endpoint) {
    await pool.query('DELETE FROM push_suscripciones WHERE huella = ? AND usuario_id = ?', [huella(endpoint), usuarioId]);
}

// Huellas de las suscripciones del equipo, menos las de quien avisa (ya sabe lo que mandó)
export async function suscripcionesDelEquipo(pool, excepto) {
    const [filas] = await pool.query('SELECT huella FROM push_suscripciones WHERE usuario_id <> ?', [excepto || 0]);
    return filas.map(f => f.huella);
}

export async function tieneSuscripcion(pool, usuarioId, endpoint) {
    const [filas] = await pool.query('SELECT 1 FROM push_suscripciones WHERE huella = ? AND usuario_id = ?', [huella(endpoint), usuarioId]);
    return filas.length > 0;
}
