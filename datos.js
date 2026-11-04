/**
 * Base de datos compartida del CRM y del mapa, sobre Google Sheets (a través del Apps Script).
 *
 * - La hoja es la fuente de verdad: una pestaña por módulo y una fila por registro (columna "id").
 * - Este navegador guarda una copia (localStorage) para abrir al instante y para seguir trabajando
 *   sin conexión. Lo que aún no ha llegado a la hoja queda marcado como pendiente.
 * - Una sola petición sincroniza: sube los cambios pendientes y baja todos los datos.
 *   Se sincroniza al abrir, cada 30 s, al volver a la pestaña y poco después de cada cambio.
 * - Sin URL de Google configurada, todo funciona igual pero solo en este navegador.
 *
 * Marcas internas de cada registro (no se suben a la hoja):
 *   _remoto: el registro ya está en la hoja · _pendiente: tiene cambios que aún no se subieron
 */
const MODULOS_DATOS = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'pedidos', 'cotizaciones', 'sitios', 'mensajes', 'tareas', 'reuniones']; // mensajes: chat y alertas del equipo · tareas: lista de tareas del equipo

// Tope por sincronización (el backend admite 500 cambios y 10 MB por petición). Si hay más pendientes
// (p. ej. tras días sin señal en el campo), salen en varias vueltas seguidas en vez de rechazarse siempre
const MAX_CAMBIOS_POR_ENVIO = 200;
const MAX_BYTES_POR_ENVIO = 4 * 1024 * 1024;

// En la hoja todo es texto: estos campos vuelven a ser números al leer
const CAMPOS_NUMERICOS = {
    agronomia: ['germinacion'],
    rendimiento: ['rendimientoPlanta', 'canastos', 'unidades'],
    germinador: ['bandejas', 'semillasMiles', 'germinacion', 'temperatura', 'humedad'],
    envios: ['semillasMiles']
};

class BaseDatos {
    constructor(conector) {
        this.conector = conector;
        this.datos = {};
        MODULOS_DATOS.forEach(m => { this.datos[m] = this.leerLocal(`sdc_${m}`, []); });
        this.borrados = this.leerLocal('sdc_borrados', []); // [{ modulo, id }] por borrar en la hoja
        this.migrarFichasMapa();
        this.oyentes = [];
        // Cola sin conexión de los cambios de etapa (colaEtapas.js; la conecta el final de este archivo) y los
        // cambios de etapa hechos con conexión que aún no han llegado: si la subida falla por la red, pasan a la cola
        this.colaEtapas = null;
        this.etapasEnCamino = new Map();
        this.sincronizando = false;
        this.ultimaSincronizacion = null;
        this.error = null;
    }

    get compartida() {
        return Boolean(this.conector && this.conector.activo);
    }

    leerLocal(clave, defecto) {
        try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch (e) { return defecto; }
    }

    guardarLocal() {
        try {
            MODULOS_DATOS.forEach(m => localStorage.setItem(`sdc_${m}`, JSON.stringify(this.datos[m])));
            localStorage.setItem('sdc_borrados', JSON.stringify(this.borrados));
            return true;
        } catch (e) {
            return false;
        }
    }

    // Las fichas del mapa se guardaban antes como { id: texto }: pasan a ser registros normales
    // Al cerrar sesión con el backend: lo de esta cuenta no se queda en el navegador para la siguiente
    olvidarTodo() {
        MODULOS_DATOS.forEach(m => { this.datos[m] = []; });
        this.borrados = [];
        this.etapasEnCamino.clear();
        if (this.colaEtapas) this.colaEtapas.olvidarTodo();
        this.guardarLocal();
        this.avisar('sincronizado'); // Las pantallas se repintan vacías
    }

    migrarFichasMapa() {
        const antiguas = this.leerLocal('sdc_sitios_mapa', null);
        if (!antiguas || Array.isArray(antiguas)) return;
        Object.entries(antiguas).forEach(([id, texto]) => {
            if (!this.datos.sitios.some(s => s.id === id)) {
                this.datos.sitios.push({ id, texto: String(texto), editado: new Date().toISOString() });
            }
        });
        try { localStorage.removeItem('sdc_sitios_mapa'); } catch (e) { /* sin almacenamiento */ }
        this.guardarLocal();
    }

    // ----- Lectura y escritura (las usan el CRM y el mapa) -----
    obtener(modulo, id) {
        return this.datos[modulo].find(r => r.id === id) || null;
    }

    // Crea o actualiza un registro (por id) y programa su subida a la hoja
    guardar(modulo, registro) {
        const previo = modulo === 'clientes' ? this.obtener(modulo, registro.id) : null;
        const marcado = { ...registro, _pendiente: true };
        const i = this.datos[modulo].findIndex(r => r.id === registro.id);
        if (i >= 0) {
            marcado._remoto = this.datos[modulo][i]._remoto;
            this.datos[modulo][i] = marcado;
        } else {
            this.datos[modulo].push(marcado);
        }
        // Si se había borrado y vuelve a guardarse, ya no hay que borrarlo
        this.borrados = this.borrados.filter(b => !(b.modulo === modulo && b.id === registro.id));
        const ok = this.guardarLocal();
        if (previo) this.vigilarEtapa({ ...previo }, registro);
        this.programar();
        return ok;
    }

    /**
     * Cambio de etapa de un cliente que ya está en el servidor: sin conexión, viaja también como operación
     * propia en la cola (colaEtapas.js), que el servidor aplica solo sobre la etapa. Con conexión sigue el camino
     * normal; si esa subida falla por la red (TypeError), pasa a la cola (sincronizar › etapasALaCola).
     */
    vigilarEtapa(previo, registro) {
        const cola = this.colaEtapas;
        if (!cola || !cola.activa || !previo._remoto || (previo.etapa || '') === (registro.etapa || '')) return;
        const cambio = { clienteId: registro.id, etapa: registro.etapa || '', anterior: previo.etapa || '' };
        if (cola.sinConexion()) this.pasarACola(cambio, previo);
        else this.etapasEnCamino.set(registro.id, { cambio, previo });
    }

    async pasarACola(cambio, previo) {
        const op = await this.colaEtapas.encolar(cambio);
        if (!op) return; // Sin IndexedDB: el registro sube entero, como siempre
        // Si solo cambió la etapa (y lo demás ya estaba subido), el registro no hace falta subirlo: así no pisa lo
        // que otra persona cambie entretanto en ese cliente. Con otros cambios, sube entero como siempre
        const actual = this.obtener('clientes', cambio.clienteId);
        if (actual && actual._pendiente && actual._remoto && !previo._pendiente &&
            (actual.etapa || '') === cambio.etapa && igualSalvoEtapa(this.limpio(actual), this.limpio(previo))) {
            actual._pendiente = false;
            this.guardarLocal();
            this.avisar('local');
        }
    }

    // La subida normal falló por la red: los cambios de etapa que iban en camino pasan a la cola
    etapasALaCola() {
        if (!this.colaEtapas) return;
        for (const { cambio, previo } of this.etapasEnCamino.values()) this.pasarACola(cambio, previo);
        this.etapasEnCamino.clear();
    }

    eliminar(modulo, id) {
        const registro = this.obtener(modulo, id);
        this.datos[modulo] = this.datos[modulo].filter(r => r.id !== id);
        // Solo hace falta borrarlo en la hoja si ya había llegado
        if (registro && registro._remoto) this.borrados.push({ modulo, id });
        const ok = this.guardarLocal();
        this.programar();
        return ok;
    }

    pendientes() {
        const guardar = MODULOS_DATOS.reduce((n, m) => n + this.datos[m].filter(r => r._pendiente || !r._remoto).length, 0);
        return guardar + this.borrados.length;
    }

    alCambiar(funcion) {
        this.oyentes.push(funcion);
    }

    avisar(motivo) {
        this.oyentes.forEach(f => {
            try { f(motivo); } catch (e) { console.error('Base de datos (oyente):', e); }
        });
    }

    // ----- Sincronización con la hoja -----
    programar(retraso = 1500) {
        this.avisar('local');
        if (!this.compartida) return;
        clearTimeout(this.temporizador);
        this.temporizador = setTimeout(() => this.sincronizar(), retraso);
    }

    iniciar() {
        if (!this.compartida) {
            this.avisar('local');
            return;
        }
        this.sincronizar();
        setInterval(() => { if (!document.hidden) this.sincronizar(); }, 30000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sincronizar(); });
        window.addEventListener('online', () => this.sincronizar());
    }

    limpio(registro) {
        const copia = { ...registro };
        delete copia._remoto;
        delete copia._pendiente;
        return copia;
    }

    // Texto de la hoja → tipos de la app
    desdeHoja(modulo, registro) {
        const r = { ...registro, _remoto: true };
        (CAMPOS_NUMERICOS[modulo] || []).forEach(c => {
            if (r[c] !== undefined && r[c] !== '') {
                const n = Number(String(r[c]).replace(',', '.'));
                r[c] = Number.isNaN(n) ? r[c] : n;
            }
        });
        return r;
    }

    async sincronizar() {
        if (!this.compartida || this.sincronizando) return;
        this.sincronizando = true;
        this.avisar('sincronizando');

        // Lo que se envía en esta vuelta (lo que cambie mientras tanto queda para la siguiente)
        // (en tandas: lo que no quepa en esta vuelta sigue pendiente y sale en la siguiente)
        const guardar = [];
        const enviados = new Map();
        let bytes = 0;
        MODULOS_DATOS.forEach(m => this.datos[m].forEach(r => {
            if (!(r._pendiente || !r._remoto) || guardar.length >= MAX_CAMBIOS_POR_ENVIO) return;
            const texto = JSON.stringify(this.limpio(r));
            if (guardar.length && bytes + texto.length > MAX_BYTES_POR_ENVIO) return;
            bytes += texto.length;
            guardar.push({ modulo: m, registro: this.limpio(r) });
            enviados.set(`${m}|${r.id}`, texto);
        }));
        const eliminar = this.borrados.slice(0, MAX_CAMBIOS_POR_ENVIO);

        const respuesta = await this.conector.sincronizarDatos({ guardar, eliminar });
        this.sincronizando = false;

        // El backend rechazó los cambios por permisos (país, casa comercial o módulo): no se reintentan para
        // siempre. Se descartan y se vuelve a pedir lo que hay en el servidor
        if (respuesta && respuesta.codigo === 'permiso') {
            MODULOS_DATOS.forEach(m => { this.datos[m] = this.datos[m].filter(r => r._remoto && !r._pendiente); });
            this.borrados = [];
            this.guardarLocal();
            if (window.equipo) window.equipo.mostrarAviso(`${respuesta.error}. Esos cambios no se guardaron.`, 'error');
            this.programar(300);
            return;
        }
        if (!respuesta || !respuesta.ok || !respuesta.datos) {
            if (!respuesta && this.conector.falloDeRed) this.etapasALaCola();
            this.error = (respuesta && respuesta.error) || 'Sin conexión con la hoja';
            // Sesión de Google caducada o cuenta sin permiso: el responsable (usuario.js) pide entrar de nuevo
            if (respuesta && respuesta.codigo && window.responsable) window.responsable.rechazado(respuesta.codigo, respuesta.error);
            this.avisar('error');
            return;
        }
        this.error = null;
        this.ultimaSincronizacion = new Date();

        // Los borrados enviados ya están hechos; los cambios de etapa que viajaban, también
        this.borrados = this.borrados.filter(b => !eliminar.some(e => e.modulo === b.modulo && e.id === b.id));
        for (const id of [...this.etapasEnCamino.keys()]) if (enviados.has(`clientes|${id}`)) this.etapasEnCamino.delete(id);

        // La hoja manda; encima se conservan los cambios hechos aquí mientras viajaba la petición
        MODULOS_DATOS.forEach(m => {
            const remotos = (respuesta.datos[m] || []).map(r => this.desdeHoja(m, r));
            const localesNuevos = this.datos[m].filter(r => {
                const enviado = enviados.get(`${m}|${r.id}`);
                const sigueIgual = enviado !== undefined && enviado === JSON.stringify(this.limpio(r));
                return (r._pendiente || !r._remoto) && !sigueIgual;
            });
            const fusion = remotos.filter(r =>
                !localesNuevos.some(l => l.id === r.id) &&
                !this.borrados.some(b => b.modulo === m && b.id === r.id));
            // Lo cambiado aquí que el servidor ya tiene queda como subido: si se borra antes de la siguiente
            // vuelta, hay que pedir que se borre también allí (si no, volvería a aparecer)
            const enServidor = new Set(remotos.map(r => r.id));
            this.datos[m] = [...fusion, ...localesNuevos.map(l => (enServidor.has(l.id) && !l._remoto ? { ...l, _remoto: true } : l))];
        });
        // Mientras la cola sin conexión no sale, el servidor aún tiene la etapa vieja: se ve la de la cola
        if (this.colaEtapas) this.colaEtapas.aplicarEncima(this.datos.clientes);
        this.guardarLocal();
        this.avisar('sincronizado');

        // Si algo cambió durante la petición, otra vuelta enseguida
        if (this.pendientes()) this.programar(300);
    }
}

// Iguales salvo la etapa (los campos en cualquier orden)
function igualSalvoEtapa(a, b) {
    const campos = new Set([...Object.keys(a), ...Object.keys(b)]);
    campos.delete('etapa');
    return [...campos].every(c => JSON.stringify(a[c]) === JSON.stringify(b[c]));
}

window.baseDatos = new BaseDatos(new GoogleWorkspaceConnector(CONFIG_GOOGLE));

// Cola sin conexión de los cambios de etapa de los clientes (colaEtapas.js, IndexedDB): sale sola a
// POST /api/sincronizar-lote al volver la red, al abrir la app y tras cada sincronización buena
if (typeof ColaEtapas === 'function') {
    const cola = new ColaEtapas({
        almacen: almacenIndexedDB(),
        api: () => CONFIG_GOOGLE.api || '',
        sesion: () => (window.responsable ? window.responsable.sesionBackend() : ''),
        cuenta: () => { const s = window.responsable && window.responsable.sesion; return (s && s.email) || ''; },
        nombreCliente: (id) => { const c = window.baseDatos.obtener('clientes', id); return (c && c.nombre) || id; },
        avisar: (texto, tipo) => { if (window.equipo) window.equipo.mostrarAviso(texto, tipo); },
        alReporte: () => window.dispatchEvent(new CustomEvent('sdc-reporte')),
        alSesion: (codigo, error) => { if (window.responsable) window.responsable.rechazado(codigo, error); },
        alAplicar: () => window.baseDatos.programar(300)
    });
    window.baseDatos.colaEtapas = cola;
    window.colaEtapas = cola;
    cola.cargar().then(() => cola.enviar());
    window.addEventListener('online', () => cola.enviar());
    window.baseDatos.alCambiar(motivo => { if (motivo === 'sincronizado') cola.enviar(); });
}
