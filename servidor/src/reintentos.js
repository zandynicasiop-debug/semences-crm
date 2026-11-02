/**
 * Reintentos con espera creciente (1 s, 2 s, 4 s) cuando el fallo es pasajero: Google o Meta
 * saturados (429) o caídos un momento (500–599), o la red cortada. Los demás errores no se repiten.
 * A cada espera se le suma hasta un 25 % al azar: así, si fallan varias peticiones a la vez, no
 * vuelven todas en el mismo instante a saturar el servicio.
 */
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

export const conVariacion = (ms) => ms + Math.floor(Math.random() * ms * 0.25);

export function esPasajero(error) {
    const codigo = Number(error && (error.status || error.code || (error.response && error.response.status)));
    if (codigo === 429 || (codigo >= 500 && codigo < 600)) return true;
    return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error && error.code);
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
