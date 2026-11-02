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

export function esPasajero(error) {
    if (!error) return false;
    // Tiempo agotado de AbortSignal.timeout() (avisos.js): es un DOMException cuyo .code (23) no es HTTP.
    // Las librerías de Google (gaxios) lo dejan como error.code = 'TimeoutError'
    if (error.name === 'TimeoutError' || error.code === 'TimeoutError') return true;
    const http = /^\d{3}$/.test(String(error.code)) ? Number(error.code) : NaN;
    const codigo = Number(error.status || error.statusCode || (error.response && error.response.status) || http);
    if (codigo === 429 || (codigo >= 500 && codigo < 600)) return true;
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
