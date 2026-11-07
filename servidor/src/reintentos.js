/**
 * Reintentos con espera creciente (1 s, 2 s, 4 s) cuando el fallo es pasajero: Google o Meta
 * saturados (429) o caídos un momento (500–599), o la red cortada. Los demás errores no se repiten.
 * A cada espera se le suma hasta un 25 % al azar: así, si fallan varias peticiones a la vez, no
 * vuelven todas en el mismo instante a saturar el servicio.
 */
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

export const conVariacion = (ms) => ms + Math.floor(Math.random() * ms * 0.25);

// Fallos de red pasajeros: los de Node (net, dns) y los de su fetch (undici), que llegan en error.cause
const RED_PASAJERA = [
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
];

/**
 * Fallos pasajeros de la base (mysql2): la conexión se cortó, el servidor se reinició, un bloqueo mutuo
 * (deadlock) o una espera de bloqueo agotada, y el tope de conexiones del hosting compartido (FastComet
 * limita las conexiones por usuario de MySQL). Si un flujo en segundo plano tropieza con uno de estos, el
 * evento se reintenta más tarde en vez de quedar "fallido" para siempre.
 */
const BASE_PASAJERA = [
    'PROTOCOL_CONNECTION_LOST', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CON_COUNT_ERROR',
    'ER_TOO_MANY_USER_CONNECTIONS', 'ER_SERVER_SHUTDOWN'
];

/**
 * Motivos que dan las API de Google en un error (gaxios): el cuerpo del error es un OBJETO, no un texto, con
 * los motivos en errors[].reason (Drive, Gmail, Calendar: 'userRateLimitExceeded', 'insufficientPermissions'),
 * en details[].reason ('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED') y su estado ('PERMISSION_DENIED').
 * @param {any} error
 * @returns {string[]}
 */
export function motivosGoogle(error) {
    const cuerpo = error && error.response && error.response.data && error.response.data.error;
    if (!cuerpo || typeof cuerpo !== 'object') return [];
    const lista = [...(Array.isArray(cuerpo.errors) ? cuerpo.errors : []), ...(Array.isArray(cuerpo.details) ? cuerpo.details : [])];
    const motivos = lista.map(e => e && e.reason).filter(m => typeof m === 'string');
    if (typeof cuerpo.status === 'string') motivos.push(cuerpo.status);
    return motivos;
}

/**
 * Cuota por minuto de Google: Drive, Gmail y Calendar la avisan con un 403 (no un 429) y piden reintentar con
 * espera creciente. La cuota diaria ('dailyLimitExceeded', 'quotaExceeded') no se arregla en segundos: no se repite.
 */
const CUOTA_POR_MINUTO = ['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED'];

export function esPasajero(error) {
    if (!error) return false;
    if (BASE_PASAJERA.includes(error.code)) return true;
    // Tiempo agotado de AbortSignal.timeout() (avisos.js): es un DOMException cuyo .code (23) no es HTTP.
    // Las librerías de Google (gaxios) lo dejan como error.code = 'TimeoutError'
    if (error.name === 'TimeoutError' || error.code === 'TimeoutError') return true;
    const http = /^\d{3}$/.test(String(error.code)) ? Number(error.code) : NaN;
    const codigo = Number(error.status || error.statusCode || (error.response && error.response.status) || http);
    if (codigo === 429 || (codigo >= 500 && codigo < 600)) return true;
    if (codigo === 403 && motivosGoogle(error).some(m => CUOTA_POR_MINUTO.includes(m))) return true;
    // fetch de Node lanza "TypeError: fetch failed" con el motivo real en error.cause
    return [error.code, error.cause && error.cause.code].some(c => RED_PASAJERA.includes(c));
}

export async function conReintentos(tarea, { intentos = 3, esperaMs = 1000 } = {}) {
    for (let intento = 1; ; intento++) {
        try {
            return await tarea();
        } catch (error) {
            if (intento >= intentos || !esPasajero(error)) throw error;
            await pausa(conVariacion(esperaMs * 2 ** (intento - 1)));
        }
    }
}
