// @ts-check
/**
 * Cola sin conexión de los cambios de etapa de los clientes (embudo: Prospecto → Contactado → Reunión →
 * Propuesta → Cliente / Perdido), guardada en IndexedDB.
 *
 * Por qué, si la app ya guarda todo sin conexión (datos.js): datos.js sube el registro entero, y el último que
 * sube pisa el registro entero. Si en el campo, sin señal, alguien pasa un cliente a "Reunión" mientras en la
 * oficina otra persona le cambia el teléfono, al volver la señal la copia vieja del teléfono pisaría el número
 * nuevo. Aquí el cambio de etapa viaja solo, como operación: el servidor (lotes.js) cambia solo la etapa sobre
 * lo que tenga en ese momento y, si la etapa ya la movió otra persona, no la pisa y se avisa.
 *
 * - Entra en la cola el cambio de etapa de un cliente que ya está en el servidor cuando navigator.onLine es
 *   false, o cuando la subida normal falla por la red (TypeError de fetch). Lo nuevo sigue el camino de siempre.
 * - Cada operación: { operacionId, clienteId, cambios: { etapa }, anterior: { etapa }, cuenta, creada, orden }.
 *   anterior es la etapa que veía este teléfono: si en el servidor ya es otra, es un conflicto.
 * - Se envía sola a POST /api/sincronizar-lote al volver la red (evento online), al abrir la app y después de
 *   cada sincronización buena. El servidor aplica cada operacionId una sola vez: reenviar no duplica nada.
 * - 423 (reporte semanal sin entregar): no se pierde nada; se abre el reporte y la cola sale al entregarlo
 *   (reporte.js vuelve a sincronizar y, tras esa sincronización, sale la cola).
 * - Rechazada (sin permiso, cliente borrado, conflicto, dato no válido): se quita de la cola y se avisa; la
 *   siguiente sincronización trae lo que hay en el servidor. Red caída, 5xx o 429: se queda y se reintenta.
 * - Sin IndexedDB (algunos modos privados): no intercepta; el cambio sigue el camino normal de datos.js.
 * - Solo se envían las de la cuenta que está dentro; al cerrar sesión se vacía, como el resto de datos.js.
 *
 * Sin dependencias de la página: todo lo de fuera (fetch, sesión, avisos) llega en el constructor, así que se
 * prueba en Node (pruebas-web/colaEtapas.test.js). La conecta datos.js.
 */

/**
 * @typedef {Object} OperacionEtapa
 * @property {string} operacionId
 * @property {string} clienteId
 * @property {{ etapa: string }} cambios
 * @property {{ etapa: string }} anterior
 * @property {string} cuenta
 * @property {string} creada     fecha ISO
 * @property {number} orden      orden de llegada (las del mismo cliente se aplican en ese orden)
 */

/**
 * @typedef {Object} AlmacenOperaciones
 * @property {() => Promise<OperacionEtapa[]>} todas
 * @property {(op: OperacionEtapa) => Promise<void>} poner
 * @property {(ids: string[]) => Promise<void>} quitar
 * @property {() => Promise<void>} vaciar
 */

/**
 * @typedef {Object} ResultadoEnvio
 * @property {number} enviadas
 * @property {number} quedan
 * @property {'sin-conexion' | 'red' | 'reporte' | 'sesion' | 'servidor' | 'error'} [motivo]   por qué quedan
 */

const MAX_OPERACIONES_POR_LOTE = 100; // Lo que admite el servidor en una petición
const CODIGOS_DE_SESION = ['sesion', 'acceso', 'espera', 'rechazado'];

/**
 * Almacén en IndexedDB (base "semences-sin-conexion", almacén "etapas"), o null si el navegador no lo tiene.
 * @param {IDBFactory | undefined} [fabrica]
 * @returns {AlmacenOperaciones | null}
 */
function almacenIndexedDB(fabrica = typeof indexedDB === 'undefined' ? undefined : indexedDB) {
    if (!fabrica) return null;
    const idb = fabrica;
    /** @type {Promise<IDBDatabase> | null} */
    let abierta = null;
    /** @returns {Promise<IDBDatabase>} */
    const abrir = () => abierta || (abierta = new Promise((resolver, rechazar) => {
        const peticion = idb.open('semences-sin-conexion', 1);
        peticion.onupgradeneeded = () => { peticion.result.createObjectStore('etapas', { keyPath: 'operacionId' }); };
        peticion.onsuccess = () => {
            const base = peticion.result;
            // Otra pestaña con una versión nueva de la app: se cierra para no bloquearla y se vuelve a abrir al usarla
            base.onversionchange = () => { base.close(); abierta = null; };
            resolver(base);
        };
        peticion.onerror = () => { abierta = null; rechazar(peticion.error); };
        peticion.onblocked = () => { abierta = null; rechazar(new Error('IndexedDB bloqueada por otra pestaña')); };
    }));
    /**
     * @param {IDBTransactionMode} modo
     * @param {(almacen: IDBObjectStore) => IDBRequest | void} uso
     * @returns {Promise<any>}
     */
    const transaccion = async (modo, uso) => {
        const base = await abrir();
        return new Promise((resolver, rechazar) => {
            const t = base.transaction('etapas', modo);
            const peticion = uso(t.objectStore('etapas'));
            t.oncomplete = () => resolver(peticion ? peticion.result : undefined);
            t.onerror = () => rechazar(t.error);
            t.onabort = () => rechazar(t.error || new Error('IndexedDB: transacción cancelada'));
        });
    };
    return {
        todas: async () => (await transaccion('readonly', (a) => a.getAll())) || [],
        poner: async (op) => { await transaccion('readwrite', (a) => a.put(op)); },
        quitar: async (ids) => { await transaccion('readwrite', (a) => { ids.forEach(id => a.delete(id)); }); },
        vaciar: async () => { await transaccion('readwrite', (a) => a.clear()); }
    };
}

/** UUID v4 para el operacionId (crypto.randomUUID solo existe en https; aquí, también sin él). */
function nuevoIdOperacion() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class ColaEtapas {
    /**
     * @param {{
     *   almacen: AlmacenOperaciones | null,
     *   api: () => string,
     *   sesion: () => string,
     *   cuenta: () => string,
     *   enLinea?: () => boolean,
     *   pedir?: (url: string, opciones: RequestInit) => Promise<Response>,
     *   nuevoId?: () => string,
     *   ahora?: () => Date,
     *   nombreCliente?: (id: string) => string,
     *   avisar?: (texto: string, tipo: string) => void,
     *   alReporte?: () => void,
     *   alSesion?: (codigo: string, error: string) => void,
     *   alAplicar?: () => void
     * }} opciones
     */
    constructor(opciones) {
        this.almacen = opciones.almacen;
        this.api = opciones.api;
        this.sesion = opciones.sesion;
        this.cuenta = opciones.cuenta;
        this.enLinea = opciones.enLinea || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
        this.pedir = opciones.pedir || ((url, op) => fetch(url, op));
        this.nuevoId = opciones.nuevoId || nuevoIdOperacion;
        this.ahora = opciones.ahora || (() => new Date());
        this.nombreCliente = opciones.nombreCliente || ((id) => id);
        this.avisar = opciones.avisar || (() => {});
        this.alReporte = opciones.alReporte || (() => {});
        this.alSesion = opciones.alSesion || (() => {});
        this.alAplicar = opciones.alAplicar || (() => {});
        /** @type {OperacionEtapa[]} */
        this.operaciones = [];
        this.orden = 0;
        /** @type {Promise<ResultadoEnvio> | null} */
        this.enCurso = null;
    }

    /** Hay dónde guardar y a quién enviar (con el Apps Script, o sin IndexedDB, no hay cola). */
    get activa() {
        return Boolean(this.almacen && this.api());
    }

    sinConexion() {
        return !this.enLinea();
    }

    /** Las operaciones de la cuenta que está dentro, en orden. */
    get mias() {
        const cuenta = this.cuenta();
        return this.operaciones.filter(o => o.cuenta === cuenta);
    }

    /** Lee la cola guardada (al abrir la app). Si IndexedDB no responde, la cola se desactiva. */
    async cargar() {
        if (!this.almacen) return;
        try {
            this.operaciones = (await this.almacen.todas()).sort((a, b) => a.orden - b.orden);
            this.orden = this.operaciones.reduce((n, o) => Math.max(n, o.orden), 0);
        } catch (error) {
            console.warn('Cola sin conexión (IndexedDB):', error);
            this.almacen = null;
        }
    }

    /**
     * La etapa que tendrá el cliente cuando salga la cola (la de su última operación), o undefined.
     * @param {string} clienteId
     */
    etapaEnCola(clienteId) {
        const suyas = this.mias.filter(o => o.clienteId === clienteId);
        return suyas.length ? suyas[suyas.length - 1].cambios.etapa : undefined;
    }

    /**
     * Guarda un cambio de etapa. Devuelve la operación, o null si no se pudo guardar (entonces el cambio sigue
     * el camino normal y no se pierde).
     * @param {{ clienteId: string, etapa: string, anterior: string }} cambio
     * @returns {Promise<OperacionEtapa | null>}
     */
    async encolar({ clienteId, etapa, anterior }) {
        if (!this.activa || !this.almacen) return null;
        const previa = this.etapaEnCola(clienteId);
        /** @type {OperacionEtapa} */
        const op = {
            operacionId: this.nuevoId(),
            clienteId,
            cambios: { etapa },
            // Con otra operación del mismo cliente en la cola, la etapa de partida es la de esa operación
            anterior: { etapa: previa !== undefined ? previa : anterior },
            cuenta: this.cuenta(),
            creada: this.ahora().toISOString(),
            orden: this.orden + 1
        };
        try {
            await this.almacen.poner(op);
        } catch (error) {
            console.warn('Cola sin conexión: no se pudo guardar', error);
            return null;
        }
        this.orden = op.orden;
        this.operaciones.push(op);
        return op;
    }

    /**
     * Mientras la cola no sale, lo que baja del servidor trae la etapa vieja: se pone encima la de la cola.
     * @param {{ id: string, etapa?: string }[]} clientes
     * @returns {number} cuántos se cambiaron
     */
    aplicarEncima(clientes) {
        let cambiados = 0;
        for (const op of this.mias) {
            const cliente = clientes.find(c => c.id === op.clienteId);
            if (cliente && (cliente.etapa || '') !== op.cambios.etapa) {
                cliente.etapa = op.cambios.etapa;
                cambiados++;
            }
        }
        return cambiados;
    }

    /**
     * Envía la cola (en tandas de 100). Una sola vez a la vez: si ya se está enviando, espera a ese envío.
     * @returns {Promise<ResultadoEnvio>}
     */
    enviar() {
        if (!this.enCurso) this.enCurso = this.vaciar().finally(() => { this.enCurso = null; });
        return this.enCurso;
    }

    /** @returns {Promise<ResultadoEnvio>} */
    async vaciar() {
        let enviadas = 0;
        for (;;) {
            const pendientes = this.mias;
            if (!pendientes.length) return { enviadas, quedan: 0 };
            if (!this.activa || this.sinConexion() || !this.sesion()) return { enviadas, quedan: pendientes.length, motivo: 'sin-conexion' };
            const lote = pendientes.slice(0, MAX_OPERACIONES_POR_LOTE);
            /** @type {Response} */
            let respuesta;
            try {
                respuesta = await this.pedir(`${this.api()}/api/sincronizar-lote`, {
                    method: 'POST',
                    mode: 'cors',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.sesion()}` },
                    body: JSON.stringify({ operaciones: lote.map(({ operacionId, clienteId, cambios, anterior }) => ({ operacionId, clienteId, cambios, anterior })) })
                });
            } catch (error) {
                // Red caída (fetch lanza TypeError): se queda todo y sale al volver la red
                return { enviadas, quedan: pendientes.length, motivo: error instanceof TypeError ? 'red' : 'error' };
            }
            /** @type {any} */
            let datos = null;
            try { datos = await respuesta.json(); } catch (e) { /* sin cuerpo JSON */ }
            // Reporte semanal sin entregar: el servidor no aplicó nada. Se abre el reporte; la cola espera
            if (respuesta.status === 423 || (datos && datos.codigo === 'reporte')) {
                this.alReporte();
                return { enviadas, quedan: pendientes.length, motivo: 'reporte' };
            }
            if (datos && CODIGOS_DE_SESION.includes(datos.codigo)) {
                this.alSesion(datos.codigo, String(datos.error || ''));
                return { enviadas, quedan: pendientes.length, motivo: 'sesion' };
            }
            if (!respuesta.ok || !datos || !Array.isArray(datos.resultados)) return { enviadas, quedan: pendientes.length, motivo: 'servidor' };

            const delLote = new Set(lote.map(o => o.operacionId));
            /** @type {Set<string>} */
            const terminadas = new Set();
            /** @type {{ operacionId: string, motivo?: string, actual?: { etapa: string } }[]} */
            const rechazadas = [];
            for (const r of datos.resultados) {
                if (!r || !delLote.has(r.operacionId) || !['aplicado', 'duplicado', 'rechazado'].includes(r.estado)) continue;
                terminadas.add(r.operacionId);
                if (r.estado === 'rechazado') rechazadas.push(r);
            }
            if (!terminadas.size) return { enviadas, quedan: pendientes.length, motivo: 'servidor' };
            // Si no se pudieran quitar de IndexedDB, volverían a salir y el servidor contestaría "duplicado"
            try { if (this.almacen) await this.almacen.quitar([...terminadas]); } catch (e) { console.warn('Cola sin conexión:', e); }
            this.operaciones = this.operaciones.filter(o => !terminadas.has(o.operacionId));
            enviadas += terminadas.size;
            if (rechazadas.length) this.avisar(this.textoRechazo(rechazadas, lote), 'error');
            this.alAplicar();
            // Alguna sin respuesta: se reintenta más tarde, no en bucle
            if (terminadas.size < lote.length) return { enviadas, quedan: this.mias.length, motivo: 'servidor' };
        }
    }

    /**
     * @param {{ operacionId: string, motivo?: string, actual?: { etapa: string } }[]} rechazadas
     * @param {OperacionEtapa[]} lote
     */
    textoRechazo(rechazadas, lote) {
        const detalle = rechazadas.slice(0, 3).map(r => {
            const op = lote.find(o => o.operacionId === r.operacionId);
            const nombre = op ? this.nombreCliente(op.clienteId) : '';
            const ahora = r.actual ? ` (ahora: ${r.actual.etapa || 'Sin indicar'})` : '';
            return `${nombre}: ${r.motivo || 'rechazado'}${ahora}`;
        }).join(' · ');
        const n = rechazadas.length;
        // Separado con « · »: idioma.js traduce cada trozo (el nombre del cliente se queda como está)
        return `${n === 1 ? 'Un cambio de etapa hecho sin conexión no se guardó' : `${n} cambios de etapa hechos sin conexión no se guardaron`} · ${detalle}`;
    }

    /** Al cerrar sesión: lo de esta cuenta no se queda en el navegador para la siguiente (como datos.js). */
    async olvidarTodo() {
        this.operaciones = [];
        try { if (this.almacen) await this.almacen.vaciar(); } catch (e) { /* sin IndexedDB */ }
    }
}
