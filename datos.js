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
const MODULOS_DATOS = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'germinador', 'envios', 'sitios', 'mensajes', 'tareas']; // mensajes: chat y alertas del equipo · tareas: lista de tareas del equipo

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
        this.programar();
        return ok;
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
            this.error = (respuesta && respuesta.error) || 'Sin conexión con la hoja';
            // Sesión de Google caducada o cuenta sin permiso: el responsable (usuario.js) pide entrar de nuevo
            if (respuesta && respuesta.codigo && window.responsable) window.responsable.rechazado(respuesta.codigo, respuesta.error);
            this.avisar('error');
            return;
        }
        this.error = null;
        this.ultimaSincronizacion = new Date();

        // Los borrados enviados ya están hechos
        this.borrados = this.borrados.filter(b => !eliminar.some(e => e.modulo === b.modulo && e.id === b.id));

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
            this.datos[m] = [...fusion, ...localesNuevos];
        });
        this.guardarLocal();
        this.avisar('sincronizado');

        // Si algo cambió durante la petición, otra vuelta enseguida
        if (this.pendientes()) this.programar(300);
    }
}

window.baseDatos = new BaseDatos(new GoogleWorkspaceConnector(CONFIG_GOOGLE));
