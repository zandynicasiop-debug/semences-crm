/**
 * Fechas locales (zona horaria del equipo) para el resumen de la mañana, la agenda y los respaldos.
 */
// Fecha (AAAA-MM-DD) y hora locales de un instante en una zona horaria
export function enZona(instante, zona) {
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instante).map(p => [p.type, p.value]));
    return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: Number(partes.hour), minuto: Number(partes.minute) };
}

// Inicio del día local (00:00 en la zona) como instante UTC
export function inicioDelDia(fecha, zona) {
    const [a, m, d] = fecha.split('-').map(Number);
    const aproximado = Date.UTC(a, m - 1, d, 12);
    const local = enZona(new Date(aproximado), zona);
    const desfase = (Date.UTC(a, m - 1, d, local.hora, local.minuto) - aproximado) / 60000;
    return new Date(Date.UTC(a, m - 1, d) - desfase * 60000);
}

// AAAA-MM-DD sumando días a una fecha local AAAA-MM-DD
export function sumarDias(fecha, dias) {
    const [a, m, d] = fecha.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}
