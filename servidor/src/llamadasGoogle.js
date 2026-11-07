/**
 * Errores para la app y llamadas a Google con la cuenta de una persona (con reintentos y reconexión).
 * Lo usan las acciones (acciones.js) y las tareas automáticas de Google Workspace (workspace.js).
 */
import { descifrarToken, actualizarToken, olvidarToken } from './cuentas.js';
import { conReintentos } from './reintentos.js';
import { cuotaGoogle } from './cuotas.js';

export function errorApp(mensaje, estado = 400, codigo = 'datos') {
    const error = new Error(mensaje);
    error.estado = estado;
    error.codigo = codigo;
    return error;
}

/**
 * Llamada a Google con la cuenta de la persona: reintenta lo pasajero y avisa si hay que volver a autorizar.
 * Cada intento espera su turno en la cuota de esa persona (cuotas.js: 10 seguidas, luego 5 por segundo), así
 * que ninguna parte del sistema (acciones, flujos, agenda, respaldos) puede pasarse de los límites de Google.
 * Guardar un token (renovado por Google, o vuelto a cifrar al rotar la clave) nunca tumba la llamada: si falla,
 * queda en el registro, porque perderlo en silencio obligaría luego a la persona a volver a conectar Google.
 */
export async function conGoogle({ pool, config, usuario }, tarea) {
    const { token, conClaveAnterior } = descifrarToken(usuario, config);
    if (!token) throw errorApp('Conecta tu cuenta de Google para usar esta función', 403, 'google');
    const guardar = (nuevo, que) => actualizarToken(pool, config, usuario, nuevo)
        .catch((error) => console.error(`Google: no se pudo guardar ${que} de ${usuario.email}:`, error.message));
    // Rotación de la clave: el token cifrado con la anterior se guarda ya con la nueva
    if (conClaveAnterior) await guardar(token, 'el token cifrado con la clave nueva');
    const alRenovar = (nuevo) => guardar(nuevo, 'el token renovado');
    try {
        return await conReintentos(async () => {
            await cuotaGoogle.esperar(usuario.id);
            return tarea(token, alRenovar);
        });
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
