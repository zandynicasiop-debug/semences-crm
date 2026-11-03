/**
 * Usuarios, quién puede entrar, sesiones de la app y códigos de un solo uso (para la app Android).
 *
 * La sesión es un valor aleatorio que la app manda como "Authorization: Bearer …". En la base solo
 * queda su huella (SHA-256): si alguien leyera la tabla, no podría usar esas sesiones.
 */
import crypto from 'node:crypto';
import { aleatorio, huella, cifrar, descifrar } from './cifrado.js';
import { ambitoDe } from './permisos.js';

const ahoraMas = (ms) => new Date(Date.now() + ms);

/**
 * ¿Puede entrar esta cuenta? Todo el dominio de Workspace, los admins y quien esté en la tabla equipo.
 * dominioCuenta: al entrar, el claim "hd" que firma Google (solo lo tienen las cuentas gestionadas por el
 * Workspace). Google recomienda fiarse de "hd" y no de cómo termina el correo: una cuenta personal de
 * Google puede llevar un correo de cualquier dominio. En cada petición se pasa el dominio del correo ya
 * verificado al entrar.
 */
export async function cuentaAutorizada(pool, config, email, dominioCuenta) {
    const correo = String(email).toLowerCase();
    const { dominio, admins, cuentasPersonales } = config.google;
    if (dominio && String(dominioCuenta || '').toLowerCase() === dominio) return true;
    // Opción B (CUENTAS_PERSONALES): cualquier cuenta de Google con el correo verificado puede entrar, pero
    // solo a la sala de espera: sin la aprobación de un Master no ve ni toca nada (permisos.js)
    if (cuentasPersonales) return true;
    if (admins.includes(correo)) return true;
    const [filas] = await pool.query('SELECT 1 FROM equipo WHERE email = ?', [correo]);
    return filas.length > 0;
}

export const esAdmin = (config, email) => config.google.admins.includes(String(email).toLowerCase());

// "empresa" si el correo es del dominio de Workspace; "personal" si es otra cuenta de Google (Gmail…)
export const tipoCuenta = (config, email) =>
    (config.google.dominio && String(email).toLowerCase().endsWith(`@${config.google.dominio}`) ? 'empresa' : 'personal');

// Crea o actualiza la persona. El token de Google solo se cambia si llega uno nuevo
export async function guardarUsuario(pool, config, { email, nombre, foto, tokenRefresco, permisos }) {
    const correo = String(email).toLowerCase();
    const cifrado = tokenRefresco ? cifrar(tokenRefresco, config.claveCifrado, contextoToken(correo)) : null;
    await pool.query(
        `INSERT INTO usuarios (email, nombre, foto, token_google, permisos_google, ultimo_acceso)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), ultimo_acceso = UTC_TIMESTAMP(),
             token_google = COALESCE(VALUES(token_google), token_google),
             permisos_google = IF(VALUES(token_google) IS NULL, permisos_google, VALUES(permisos_google))`,
        [correo, String(nombre || '').slice(0, 200), String(foto || '').slice(0, 1000), cifrado, cifrado ? permisos || '' : null]
    );
    // Los Master (ADMINS) quedan siempre aprobados también en la base (así se ordenan y cuentan bien)
    if (esAdmin(config, correo)) await pool.query("UPDATE usuarios SET estado = 'aprobado' WHERE email = ?", [correo]);
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [correo]);
    return filas[0];
}

// El token de Google de cada persona va cifrado y atado a su correo
const contextoToken = (email) => `google:${String(email).toLowerCase()}`;

/**
 * Token de Google descifrado: { token, conClaveAnterior }. Rotación de CLAVE_CIFRADO: lo que no se descifra
 * con la clave actual se prueba con CLAVE_CIFRADO_ANTERIOR (y conGoogle lo vuelve a cifrar con la nueva).
 * El contexto (AAD) es el correo de su dueño: copiado a la fila de otra persona, no se descifra con ninguna.
 */
export function descifrarToken(usuario, config) {
    if (!usuario.token_google) return { token: '', conClaveAnterior: false };
    const contexto = contextoToken(usuario.email);
    try {
        return { token: descifrar(usuario.token_google, config.claveCifrado, contexto), conClaveAnterior: false };
    } catch (error) {
        if (!config.claveCifradoAnterior) throw error;
        return { token: descifrar(usuario.token_google, config.claveCifradoAnterior, contexto), conClaveAnterior: true };
    }
}

export function tokenDe(usuario, config) {
    return descifrarToken(usuario, config).token;
}

// Google cambió el token de refresco: se guarda el nuevo cifrado
export async function actualizarToken(pool, config, usuario, tokenRefresco) {
    await pool.query('UPDATE usuarios SET token_google = ? WHERE id = ?', [cifrar(tokenRefresco, config.claveCifrado, contextoToken(usuario.email)), usuario.id]);
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

// Teléfonos para los avisos por WhatsApp: los de la tabla equipo y los del equipo aprobado (y los Master).
// Quien está en la sala de espera o fue rechazado no recibe avisos del equipo
export async function telefonosDelEquipo(pool, config) {
    const [filas] = await pool.query(
        `SELECT telefono FROM equipo WHERE telefono <> ''
         UNION SELECT telefono FROM usuarios WHERE telefono <> '' AND (estado = 'aprobado' OR email IN (?))`,
        [config.google.admins.length ? config.google.admins : ['']]);
    return [...new Set(filas.map(f => f.telefono))];
}

export async function guardarTelefono(pool, usuarioId, telefono) {
    await pool.query('UPDATE usuarios SET telefono = ? WHERE id = ?', [telefono, usuarioId]);
}

// Vista pública de la persona (lo que se devuelve a la app), con su estado y su ámbito
export const publico = (usuario, config) => ({
    email: usuario.email,
    nombre: usuario.nombre,
    foto: usuario.foto,
    telefono: usuario.telefono,
    // WhatsApp: la bienvenida de Borja salió y la persona contestó (los avisos le llegan de verdad)
    whatsappBienvenida: Boolean(usuario.whatsapp_bienvenida),
    whatsappConfirmado: Boolean(usuario.whatsapp_confirmado),
    admin: esAdmin(config, usuario.email),
    tipoCuenta: tipoCuenta(config, usuario.email),
    ...ambitoDe(usuario, config),
    solicitado: Boolean(usuario.solicitado),
    resumen: usuario.resumen_activo === undefined ? true : Boolean(Number(usuario.resumen_activo)),
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

// Huellas de las suscripciones del equipo aprobado (y de los Master), menos las de quien avisa
export async function suscripcionesDelEquipo(pool, config, excepto) {
    const [filas] = await pool.query(
        `SELECT p.huella FROM push_suscripciones p JOIN usuarios u ON u.id = p.usuario_id
         WHERE p.usuario_id <> ? AND (u.estado = 'aprobado' OR u.email IN (?))`, [excepto || 0, config.google.admins.length ? config.google.admins : ['']]);
    return filas.map(f => f.huella);
}

// Suscripciones y teléfono de unas personas concretas (avisos directos o a los Master)
export async function destinosDe(pool, usuarioIds) {
    if (!usuarioIds.length) return { huellas: [], telefonos: [] };
    const [subs] = await pool.query('SELECT huella FROM push_suscripciones WHERE usuario_id IN (?)', [usuarioIds]);
    const [tels] = await pool.query("SELECT telefono FROM usuarios WHERE id IN (?) AND telefono <> ''", [usuarioIds]);
    return { huellas: subs.map(f => f.huella), telefonos: [...new Set(tels.map(f => f.telefono))] };
}

export async function tieneSuscripcion(pool, usuarioId, endpoint) {
    const [filas] = await pool.query('SELECT 1 FROM push_suscripciones WHERE huella = ? AND usuario_id = ?', [huella(endpoint), usuarioId]);
    return filas.length > 0;
}
