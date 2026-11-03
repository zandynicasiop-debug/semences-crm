/**
 * Auditoría (solo Master, con el backend): quién entró y qué creó, cambió o borró cada persona.
 *
 * - Actividad: las entradas más recientes, con filtros (persona, qué, módulo, fechas, texto). Cada una
 *   se abre para ver campo a campo el antes y el después, la IP y el navegador. Se exporta a CSV.
 * - Por persona: cuántas veces entró, su último ingreso y cuánto creó, cambió y borró en el periodo.
 * - Comprobar integridad: el servidor recorre la cadena firmada y dice si alguien tocó la tabla a mano.
 * El registro solo se añade: desde la app no se puede cambiar ni borrar nada (servidor/src/auditoria.js).
 */
const NOMBRE_ACCION_AUDITORIA = {
    ingreso: 'Entró', ingreso_rechazado: 'Entrada rechazada', salida: 'Salió', crear: 'Creó', modificar: 'Cambió', eliminar: 'Borró',
    accesos: 'Accesos', equipo: 'Equipo', metas: 'Metas', instagram: 'Instagram', exportar: 'Exportó', respaldo: 'Respaldo',
    correo: 'Correo', documento: 'Documento', reporte: 'Reporte', reunion: 'Reunión', calendario: 'Calendario', perfil: 'Perfil',
    alerta: 'Alerta', dispositivo: 'Dispositivo', denegado: 'Sin permiso'
};
// Color de cada clase de acción (style.css): lo que entra y sale, lo que crea, lo que cambia, lo que borra o se niega
const TONO_ACCION_AUDITORIA = { ingreso: 'sesion', salida: 'sesion', crear: 'crea', modificar: 'cambia', eliminar: 'borra', ingreso_rechazado: 'borra', denegado: 'borra' };
const MODULOS_AUDITORIA_EXTRA = { tareas: 'Tareas', reuniones: 'Reuniones' };
// Nombres de los datos que no son campos del CRM (accesos, metas, correos…)
const CAMPOS_AUDITORIA = {
    estado: 'Estado', cargo: 'Cargo', paises: 'Países', casas: 'Casas comerciales', operacion: 'Operación', mes: 'Mes',
    indicador: 'Qué se mide', objetivo: 'Meta', para: 'Para', adjunto: 'Adjunto', inicio: 'Inicio', participantes: 'Participantes',
    invitados: 'Invitados', mensaje: 'Mensaje', texto: 'Texto', vendedor: 'Vendedor', telefono: 'Teléfono', nombre: 'Nombre',
    token: 'Token', pais: 'País', casa: 'Casa comercial', actividades: 'Actividades'
};
const escaparAuditoria = (texto) => String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class Auditoria {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        if (!this.google.conBackend) return;
        this.filtro = {};
        this.entradas = [];
        window.addEventListener('sdc-ambito', () => this.alCambiarAmbito());
        window.addEventListener('load', () => setTimeout(() => { this.crearOpcion(); this.alCambiarAmbito(); }));
    }

    get ambito() {
        const a = window.responsable && window.responsable.ambito;
        return a && a.estado === 'aprobado' ? a : null;
    }

    alCambiarAmbito() {
        if (this.opcion) this.opcion.hidden = !(this.ambito && this.ambito.master);
    }

    crearOpcion() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || this.opcion) return;
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'menu-extra';
        boton.textContent = 'Auditoría';
        boton.hidden = true;
        boton.addEventListener('click', () => {
            lista.hidden = true;
            document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
            this.abrir();
        });
        const referencia = document.getElementById('menu-tema');
        if (referencia) referencia.before(boton);
        else lista.appendChild(boton);
        this.opcion = boton;
    }

    async pedir(datos) {
        const respuesta = await this.google.enviar('auditoria', datos, true);
        if (!respuesta) throw new Error('Sin conexión con el servidor. Inténtalo de nuevo.');
        if (!respuesta.ok) throw new Error(respuesta.error || 'No se pudo hacer.');
        return respuesta;
    }

    // Nombre legible de un módulo y de un campo del CRM (los de crm.js; si no, el que guarda la base)
    nombreModulo(modulo) {
        const crm = typeof MODULOS_CRM !== 'undefined' ? MODULOS_CRM : {};
        return (crm[modulo] && crm[modulo].pestana) || MODULOS_AUDITORIA_EXTRA[modulo] || modulo;
    }

    nombreCampo(modulo, campo) {
        const crm = typeof MODULOS_CRM !== 'undefined' ? MODULOS_CRM : {};
        const def = crm[modulo] && (crm[modulo].campos || []).find(c => c.id === campo);
        return def ? def.etiqueta : CAMPOS_AUDITORIA[campo] || campo;
    }

    // ----- Pantalla -----
    crearDialogo() {
        const d = document.createElement('dialog');
        d.className = 'dialogo dialogo-auditoria';
        d.setAttribute('aria-labelledby', 'auditoria-titulo');
        const opcionesAccion = Object.entries(NOMBRE_ACCION_AUDITORIA).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
        const modulos = [...Object.keys(typeof MODULOS_CRM !== 'undefined' ? MODULOS_CRM : {}), ...Object.keys(MODULOS_AUDITORIA_EXTRA)];
        const opcionesModulo = modulos.map(m => `<option value="${m}">${escaparAuditoria(this.nombreModulo(m))}</option>`).join('');
        d.innerHTML = `
            <div class="dialogo-form">
                <div class="tablero-cabecera">
                    <div>
                        <h3 id="auditoria-titulo">Auditoría</h3>
                        <p class="dialogo-subtitulo">Quién entró y qué creó, cambió o borró cada persona. Solo se añade: nada se puede cambiar ni borrar.</p>
                    </div>
                    <button type="button" class="btn-texto auditoria-cerrar">Cerrar</button>
                </div>
                <div class="auditoria-pestanas" role="tablist">
                    <button type="button" role="tab" class="auditoria-pestana" data-vista="actividad" aria-selected="true">Actividad</button>
                    <button type="button" role="tab" class="auditoria-pestana" data-vista="personas" aria-selected="false">Por persona</button>
                </div>
                <form class="auditoria-filtros">
                    <div class="form-group"><label for="auditoria-persona">Persona</label><select id="auditoria-persona" name="email"><option value="">Todas</option></select></div>
                    <div class="form-group"><label for="auditoria-tipo">Qué</label><select id="auditoria-tipo" name="tipo"><option value="">Todo</option>${opcionesAccion}</select></div>
                    <div class="form-group"><label for="auditoria-modulo">Módulo</label><select id="auditoria-modulo" name="modulo"><option value="">Todos</option>${opcionesModulo}</select></div>
                    <div class="form-group"><label for="auditoria-desde">Desde</label><input id="auditoria-desde" name="desde" type="date"></div>
                    <div class="form-group"><label for="auditoria-hasta">Hasta</label><input id="auditoria-hasta" name="hasta" type="date"></div>
                    <div class="form-group auditoria-buscar"><label for="auditoria-texto">Buscar</label><input id="auditoria-texto" name="texto" type="search" placeholder="Nombre, cliente, guía…"></div>
                </form>
                <div class="auditoria-barra">
                    <button type="button" class="btn-secondary auditoria-verificar">Comprobar integridad</button>
                    <button type="button" class="btn-secondary auditoria-csv">Exportar a CSV</button>
                    <p class="dialogo-nota auditoria-integridad" aria-live="polite"></p>
                </div>
                <p class="form-error auditoria-error" role="alert" hidden></p>
                <div class="auditoria-contenido"></div>
            </div>`;
        document.body.appendChild(d);
        d.querySelector('.auditoria-cerrar').addEventListener('click', () => d.close());
        d.querySelectorAll('.auditoria-pestana').forEach(b => b.addEventListener('click', () => this.verVista(b.dataset.vista)));
        const form = d.querySelector('.auditoria-filtros');
        form.addEventListener('submit', (e) => e.preventDefault());
        let espera = null;
        form.addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(() => this.cargar(), 350); });
        d.querySelector('.auditoria-verificar').addEventListener('click', () => this.verificar());
        d.querySelector('.auditoria-csv').addEventListener('click', () => this.exportarCSV());
        this.dialogo = d;
        this.vista = 'actividad';
    }

    abrir() {
        if (!this.dialogo) this.crearDialogo();
        if (!this.dialogo.open) this.dialogo.showModal();
        this.cargarPersonas();
        this.cargar();
    }

    verVista(vista) {
        this.vista = vista;
        this.dialogo.querySelectorAll('.auditoria-pestana').forEach(b => b.setAttribute('aria-selected', String(b.dataset.vista === vista)));
        // Por persona solo filtra por fechas
        this.dialogo.querySelectorAll('.auditoria-filtros .form-group').forEach(g => {
            g.hidden = vista === 'personas' && !g.querySelector('input[type="date"]');
        });
        this.dialogo.querySelector('.auditoria-csv').hidden = vista === 'personas';
        this.cargar();
    }

    leerFiltros() {
        const datos = Object.fromEntries(new FormData(this.dialogo.querySelector('.auditoria-filtros')).entries());
        return Object.fromEntries(Object.entries(datos).filter(([, v]) => String(v).trim()));
    }

    error(texto) {
        const p = this.dialogo.querySelector('.auditoria-error');
        p.textContent = texto || '';
        p.hidden = !texto;
    }

    async cargarPersonas() {
        try {
            const r = await this.pedir({ operacion: 'personas' });
            const select = this.dialogo.querySelector('#auditoria-persona');
            const elegida = select.value;
            select.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
            r.personas.filter(p => p.email).sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach(p => {
                const o = document.createElement('option');
                o.value = p.email;
                o.textContent = p.nombre && p.nombre !== p.email ? `${p.nombre} (${p.email})` : p.email;
                o.translate = false;
                select.appendChild(o);
            });
            select.value = elegida;
        } catch (e) {
            // La lista de personas es una ayuda: sin ella se puede filtrar igual
        }
    }

    async cargar(mas = false) {
        const contenido = this.dialogo.querySelector('.auditoria-contenido');
        this.error('');
        const filtros = this.leerFiltros();
        const turno = (this.turno || 0) + 1;
        this.turno = turno;
        if (!mas) contenido.innerHTML = `<p class="dialogo-nota">${escaparAuditoria(traducir('Cargando…'))}</p>`;
        try {
            if (this.vista === 'personas') {
                const r = await this.pedir({ operacion: 'personas', desde: filtros.desde, hasta: filtros.hasta });
                if (turno === this.turno) this.pintarPersonas(r.personas);
                return;
            }
            const antesDe = mas && this.entradas.length ? this.entradas[this.entradas.length - 1].id : undefined;
            const r = await this.pedir({ operacion: 'listar', ...filtros, antesDe });
            if (turno !== this.turno) return;
            this.entradas = mas ? [...this.entradas, ...r.entradas] : r.entradas;
            this.hayMas = r.hayMas;
            this.pintarActividad();
        } catch (e) {
            if (turno !== this.turno) return;
            contenido.innerHTML = '';
            this.error(e.message);
        }
    }

    cuando(fecha) {
        return new Date(fecha).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    valor(v) {
        if (v === null || v === undefined || v === '') return '—';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    }

    pintarActividad() {
        const contenido = this.dialogo.querySelector('.auditoria-contenido');
        contenido.innerHTML = '';
        if (!this.entradas.length) {
            contenido.innerHTML = `<p class="dialogo-nota">${escaparAuditoria(traducir('No hay nada con esos filtros.'))}</p>`;
            return;
        }
        const ul = document.createElement('ul');
        ul.className = 'auditoria-lista';
        this.entradas.forEach(e => ul.appendChild(this.fila(e)));
        contenido.appendChild(ul);
        if (this.hayMas) {
            const mas = document.createElement('button');
            mas.type = 'button';
            mas.className = 'btn-secondary auditoria-mas';
            mas.textContent = 'Cargar más';
            mas.addEventListener('click', () => { mas.disabled = true; this.cargar(true); });
            contenido.appendChild(mas);
        }
    }

    fila(e) {
        const li = document.createElement('li');
        const detalle = document.createElement('details');
        detalle.className = 'auditoria-entrada';
        const resumen = document.createElement('summary');
        const cuando = document.createElement('time');
        cuando.className = 'auditoria-cuando';
        cuando.dateTime = new Date(e.creado).toISOString();
        cuando.textContent = this.cuando(e.creado);
        const etiqueta = document.createElement('span');
        etiqueta.className = `auditoria-accion auditoria-${TONO_ACCION_AUDITORIA[e.accion] || 'otra'}`;
        etiqueta.textContent = NOMBRE_ACCION_AUDITORIA[e.accion] || e.accion;
        const quien = document.createElement('strong');
        quien.className = 'auditoria-quien';
        quien.translate = false;
        quien.textContent = e.nombre || e.email || 'Sistema';
        const que = document.createElement('span');
        que.className = 'auditoria-que';
        const registro = ['crear', 'modificar', 'eliminar'].includes(e.accion);
        if (e.modulo && registro) {
            const modulo = document.createElement('span');
            modulo.className = 'auditoria-modulo';
            modulo.textContent = this.nombreModulo(e.modulo);
            que.append(modulo, ' · ');
        }
        const texto = document.createElement('span');
        // El nombre de un registro es un dato (no se traduce); lo demás es texto de la app
        if (registro) texto.translate = false;
        texto.textContent = e.resumen || e.objeto || '';
        que.appendChild(texto);
        resumen.append(cuando, etiqueta, quien, que);
        detalle.appendChild(resumen);
        detalle.addEventListener('toggle', () => { if (detalle.open && !detalle.dataset.pintado) { detalle.dataset.pintado = '1'; this.pintarDetalle(detalle, e); } });
        li.appendChild(detalle);
        return li;
    }

    pintarDetalle(detalle, e) {
        const caja = document.createElement('div');
        caja.className = 'auditoria-detalle';
        const cambios = e.cambios && typeof e.cambios === 'object' ? Object.entries(e.cambios) : [];
        if (cambios.length) {
            const tabla = document.createElement('table');
            const registro = ['crear', 'modificar', 'eliminar'].includes(e.accion);
            const pares = cambios.map(([campo, v]) => (registro && Array.isArray(v) ? [campo, v[0], v[1]] : [campo, null, v]));
            // Al cambiar: antes y después; al crear o en lo que no es un registro, el dato; al borrar, lo que había
            const columnas = e.accion === 'modificar' ? ['Antes', 'Después'] : e.accion === 'eliminar' ? ['Lo que había'] : ['Dato'];
            tabla.innerHTML = `<thead><tr>${['Campo', ...columnas].map(c => `<th scope="col">${escaparAuditoria(traducir(c))}</th>`).join('')}</tr></thead>`;
            const tbody = document.createElement('tbody');
            pares.forEach(([campo, antes, despues]) => {
                const tr = document.createElement('tr');
                const celda = (t, dato) => { const td = document.createElement('td'); td.textContent = t; if (dato) td.translate = false; tr.appendChild(td); };
                celda(this.nombreCampo(e.modulo, campo), false);
                if (e.accion === 'modificar') celda(this.valor(antes), true);
                celda(this.valor(e.accion === 'eliminar' ? antes : despues), true);
                tbody.appendChild(tr);
            });
            tabla.appendChild(tbody);
            const envoltura = document.createElement('div');
            envoltura.className = 'indicadores-tabla';
            envoltura.appendChild(tabla);
            caja.appendChild(envoltura);
        }
        const meta = document.createElement('p');
        meta.className = 'dialogo-nota auditoria-meta';
        meta.translate = false;
        meta.textContent = [e.email, e.objeto && `id ${e.objeto}`, e.ip && `IP ${e.ip}`, e.agente].filter(Boolean).join(' · ');
        caja.appendChild(meta);
        detalle.appendChild(caja);
    }

    pintarPersonas(personas) {
        const contenido = this.dialogo.querySelector('.auditoria-contenido');
        contenido.innerHTML = '';
        if (!personas.length) {
            contenido.innerHTML = `<p class="dialogo-nota">${escaparAuditoria(traducir('No hay nada con esos filtros.'))}</p>`;
            return;
        }
        const envoltura = document.createElement('div');
        envoltura.className = 'indicadores-tabla';
        const tabla = document.createElement('table');
        const cabeceras = ['Persona', 'Ingresos', 'Último ingreso', 'Creó', 'Cambió', 'Borró', 'Sin permiso', 'Última actividad'];
        tabla.innerHTML = `<thead><tr>${cabeceras.map(c => `<th scope="col">${escaparAuditoria(traducir(c))}</th>`).join('')}</tr></thead>`;
        const tbody = document.createElement('tbody');
        personas.forEach(p => {
            const tr = document.createElement('tr');
            const persona = document.createElement('td');
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'btn-texto auditoria-ver-persona';
            boton.translate = false;
            boton.textContent = p.nombre || p.email || 'Sistema';
            boton.title = traducir('Ver su actividad');
            boton.disabled = !p.email;
            boton.addEventListener('click', () => {
                this.dialogo.querySelector('#auditoria-persona').value = p.email;
                this.verVista('actividad');
            });
            persona.appendChild(boton);
            tr.appendChild(persona);
            [p.ingresos + (p.rechazados ? ` (+${p.rechazados} ${traducir('rechazados')})` : ''), p.ultimoIngreso ? this.cuando(p.ultimoIngreso) : '—',
                p.creados, p.modificados, p.eliminados, p.denegados, this.cuando(p.ultimaActividad)].forEach((t, i) => {
                const td = document.createElement('td');
                td.textContent = String(t);
                if (i === 5 && p.denegados) td.className = 'indicadores-aviso';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        tabla.appendChild(tbody);
        envoltura.appendChild(tabla);
        contenido.appendChild(envoltura);
    }

    async verificar() {
        const salida = this.dialogo.querySelector('.auditoria-integridad');
        const boton = this.dialogo.querySelector('.auditoria-verificar');
        boton.disabled = true;
        salida.textContent = 'Comprobando…';
        try {
            const r = await this.pedir({ operacion: 'verificar' });
            salida.className = `dialogo-nota auditoria-integridad${r.ok ? '' : ' auditoria-rota'}`;
            salida.textContent = r.ok
                ? `✅ Cadena íntegra: ${r.revisadas} entradas comprobadas.`
                : `⚠️ La cadena está rota en la entrada ${r.rota.id}: ${r.rota.motivo}.`;
        } catch (e) {
            salida.textContent = e.message;
        } finally {
            boton.disabled = false;
        }
    }

    // Lo que hay en la lista ahora (con sus filtros), en CSV para Excel
    exportarCSV() {
        const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const filas = [['Fecha', 'Persona', 'Correo', 'Acción', 'Módulo', 'Id', 'Resumen', 'Cambios', 'IP', 'Navegador'].map(t => celda(traducir(t))).join(',')];
        this.entradas.forEach(e => filas.push([new Date(e.creado).toISOString(), e.nombre, e.email, traducir(NOMBRE_ACCION_AUDITORIA[e.accion] || e.accion),
            e.modulo ? this.nombreModulo(e.modulo) : '', e.objeto, e.resumen, e.cambios ? JSON.stringify(e.cambios) : '', e.ip, e.agente].map(celda).join(',')));
        // Con BOM: Excel abre bien las tildes
        const texto = `\uFEFF${filas.join('\r\n')}`;
        const nombre = `auditoria_${new Date().toISOString().slice(0, 10)}.csv`;
        // En las apps (Android, iPhone, escritorio), compartir o "Guardar como"
        if (window.AppNativa && window.AppNativa.guardarArchivo) {
            let binario = '';
            new TextEncoder().encode(texto).forEach(b => { binario += String.fromCharCode(b); });
            window.AppNativa.guardarArchivo(nombre, btoa(binario), 'text/csv');
            return;
        }
        const archivo = new Blob([texto], { type: 'text/csv;charset=utf-8' });
        const enlace = document.createElement('a');
        enlace.href = URL.createObjectURL(archivo);
        enlace.download = nombre;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
    }
}

window.auditoria = new Auditoria();
