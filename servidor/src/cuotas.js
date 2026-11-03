// @ts-check
/**
 * Cubo de fichas (token bucket) para no pasar de las cuotas de las API externas (Google: Calendar, Drive,
 * Gmail), por persona. Cada clave tiene `capacidad` fichas que se rellenan a `porSegundo`; cada llamada
 * gasta una. Con el cubo vacío, se espera lo justo. Las esperas de una misma clave van en fila (una
 * promesa detrás de otra): dos llamadas a la vez no pueden gastar la misma ficha.
 *
 * Vive en memoria: con varios procesos de Passenger, cada uno lleva su cuenta (el límite real queda en
 * capacidad × procesos). Para eso están además los reintentos con espera ante un 429 (reintentos.js).
 */
export class CuboDeFichas {
    /**
     * @param {{ capacidad?: number, porSegundo?: number, ahora?: () => number, dormir?: (ms: number) => Promise<void> }} [opciones]
     */
    constructor({ capacidad = 10, porSegundo = 5, ahora = Date.now, dormir = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
        if (capacidad < 1 || porSegundo <= 0) throw new Error('El cubo necesita capacidad ≥ 1 y un ritmo > 0');
        this.capacidad = capacidad;
        this.porSegundo = porSegundo;
        this.ahora = ahora;
        this.dormir = dormir;
        /** @type {Map<string, { fichas: number, ultima: number, fila: Promise<void> }>} */
        this.cubos = new Map();
    }

    /**
     * Espera (si hace falta) y gasta una ficha de esa clave. Devuelve los milisegundos que esperó.
     * @param {string | number} clave
     * @returns {Promise<number>}
     */
    esperar(clave) {
        const id = String(clave);
        let cubo = this.cubos.get(id);
        if (!cubo) {
            cubo = { fichas: this.capacidad, ultima: this.ahora(), fila: Promise.resolve() };
            this.cubos.set(id, cubo);
        }
        const actual = cubo;
        const turno = actual.fila.then(async () => {
            const ahora = this.ahora();
            actual.fichas = Math.min(this.capacidad, actual.fichas + ((ahora - actual.ultima) / 1000) * this.porSegundo);
            actual.ultima = ahora;
            let espera = 0;
            if (actual.fichas < 1) {
                espera = Math.ceil(((1 - actual.fichas) / this.porSegundo) * 1000);
                await this.dormir(espera);
                actual.fichas = 1;
                actual.ultima = this.ahora();
            }
            actual.fichas -= 1;
            return espera;
        });
        actual.fila = turno.then(() => undefined, () => undefined);
        if (this.cubos.size > 5000) this.limpiar();
        return turno;
    }

    // Quita los cubos llenos (nadie los usa desde hace rato): la memoria no crece sin fin
    limpiar() {
        const ahora = this.ahora();
        for (const [id, cubo] of this.cubos) {
            if (cubo.fichas + ((ahora - cubo.ultima) / 1000) * this.porSegundo >= this.capacidad) this.cubos.delete(id);
        }
    }
}

// Google, por persona: hasta 10 llamadas seguidas y luego 5 por segundo (muy por debajo de los límites
// por usuario de Calendar, Drive y Gmail, que así nunca devuelven 429 por ráfagas del CRM)
export const cuotaGoogle = new CuboDeFichas({ capacidad: 10, porSegundo: 5 });
