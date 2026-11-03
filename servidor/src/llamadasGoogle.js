/**
 * Errores para la app y llamadas a Google con la cuenta de una persona (con reintentos y reconexión).
 * Lo usan las acciones (acciones.js) y las tareas automáticas de Google Workspace (workspace.js).
 */
import { descifrarToken, actualizarToken, olvidarToken } from './cuentas.js';
import { conReintentos } from './reintentos.js';

export function errorApp(mensaje, estado = 400, codigo = 'datos') {
    const error = new Error(mensaje);
    error.estado = estado;
    error.codigo = codigo;
    return error;
}

// Llamada a Google con la cuenta de la persona: reintenta lo pasajero y avisa si hay que volver a autorizar
export async function conGoogle({ pool, config, usuario }, tarea) {
    const { token, conClaveAnterior } = descifrarToken(usuario, config);
    if (!token) throw errorApp('Conecta tu cuenta de Google para usar esta función', 403, 'google');
    // Rotación de la clave: el token cifrado con la anterior se guarda ya con la nueva
    if (conClaveAnterior) await actualizarToken(pool, config, usuario, token).catch(() => {});
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
