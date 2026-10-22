/**
 * CRM interno de Semences del Caribe: clientes, visitas a finca, procesos agronómicos y rendimiento
 * de parcelas. Cada módulo es una pestaña con su tabla y un formulario de registro en un diálogo.
 *
 * Todo lo de un cliente queda en el mismo sitio: visitas, procesos y rendimientos se unen al cliente
 * por su identificador (clienteId), se eligen de la lista de clientes registrados y se ven juntos en
 * su expediente. La pestaña de procesos agronómicos los agrupa por cliente.
 *
 * Los datos viven en la base compartida (datos.js): Google Sheets a través del Apps Script, con una
 * copia en este navegador para trabajar sin conexión. Así todo el equipo ve los mismos clientes y
 * expedientes. Los procesos agronómicos se agendan además en Google Calendar.
 */

// Fases del proceso agronómico, en el orden en que ocurren
const FASES_AGRONOMICAS = [
    'Inicio de germinación',
    'Fin de germinación',
    'Trasplante',
    'Inicio de cosecha',
    'Fin de cosecha'
];

// El % de germinación se mide al terminar la germinación: el campo solo aparece en esa fase
const FASE_CONTEO_GERMINACION = 'Fin de germinación';

// Marcas que representa Semences del Caribe (las de los carteles de la finca)
const MARCAS = ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó', 'Varias marcas'];

const ESTADOS_CULTIVO = [
    'Bueno',
    'Regular',
    'Con plagas o enfermedades',
    'Estrés hídrico',
    'Listo para cosecha'
];

/**
 * Definición de cada módulo: campos del formulario y columnas de la tabla.
 * Tipos de campo: text, tel, date, number, select, textarea y cliente (lista de clientes registrados).
 * lista: id de un <datalist> con sugerencias. sinCliente: la columna se oculta dentro de un expediente.
 */
const MODULOS_CRM = {
    clientes: {
        pestana: 'Clientes',
        titulo: 'Registro de clientes',
        nuevo: 'Registrar cliente',
        vacio: 'Todavía no hay clientes. Registra el primero: sus visitas, procesos y rendimientos quedarán en su expediente.',
        campos: [
            { id: 'nombre', etiqueta: 'Nombre', tipo: 'text', requerido: true, autocomplete: 'name' },
            { id: 'telefono', etiqueta: 'Teléfono', tipo: 'tel', ejemplo: '809 555 1234' },
            { id: 'whatsapp', etiqueta: 'WhatsApp', tipo: 'tel', ejemplo: '829 555 1234' },
            { id: 'ubicacion', etiqueta: 'Ubicación', tipo: 'text', ejemplo: 'Constanza, La Vega' },
            { id: 'marca', etiqueta: 'Marca que compra', tipo: 'select', opciones: MARCAS, vacia: 'Sin indicar' },
            { id: 'seguimiento', etiqueta: 'Próximo seguimiento', tipo: 'date' }
        ],
        columnas: [
            { titulo: 'Nombre', valor: r => r.nombre, expediente: true },
            { titulo: 'Teléfono', valor: r => r.telefono, enlace: r => r.telefono && `tel:${soloDigitos(r.telefono)}` },
            { titulo: 'WhatsApp', valor: r => r.whatsapp, enlace: r => r.whatsapp && enlaceWhatsApp(r.whatsapp) },
            { titulo: 'Ubicación', valor: r => r.ubicacion },
            { titulo: 'Marca', valor: r => r.marca },
            { titulo: 'Próx. seguimiento', valor: r => formatearFecha(r.seguimiento), orden: r => r.seguimiento },
            { titulo: 'Procesos', valor: r => resumenCliente(r.id), dato: true },
            { titulo: 'Registró', valor: r => r.responsable }
        ]
    },
    visitas: {
        pestana: 'Visitas a finca',
        titulo: 'Visitas a clientes y fincas',
        nuevo: 'Registrar visita',
        vacio: 'Todavía no hay visitas registradas.',
        campos: [
            { id: 'clienteId', etiqueta: 'Cliente', tipo: 'cliente', requerido: true },
            { id: 'fecha', etiqueta: 'Fecha', tipo: 'date', requerido: true, hoy: true },
            { id: 'ubicacion', etiqueta: 'Ubicación', tipo: 'text', ejemplo: 'Finca, municipio o parcela' },
            { id: 'estado', etiqueta: 'Estado del cultivo', tipo: 'select', opciones: ESTADOS_CULTIVO, requerido: true },
            { id: 'comentarios', etiqueta: 'Comentarios', tipo: 'textarea' }
        ],
        columnas: [
            { titulo: 'Fecha', valor: r => formatearFecha(r.fecha), orden: r => r.fecha },
            { titulo: 'Cliente', valor: r => nombreCliente(r), expediente: true, sinCliente: true },
            { titulo: 'Ubicación', valor: r => r.ubicacion },
            { titulo: 'Estado del cultivo', valor: r => r.estado, etiqueta: true },
            { titulo: 'Comentarios', valor: r => r.comentarios, largo: true },
            { titulo: 'Registró', valor: r => r.responsable }
        ]
    },
    agronomia: {
        pestana: 'Procesos agronómicos',
        titulo: 'Procesos agronómicos',
        subtitulo: 'Agrupados por cliente y en orden de fechas: germinación, trasplante y cosecha de cada lote. Cada proceso se agenda en Google Calendar.',
        nuevo: 'Nuevo proceso',
        vacio: 'Todavía no hay procesos. Registra una germinación, un trasplante o una cosecha.',
        agruparPorCliente: true,
        campos: [
            { id: 'clienteId', etiqueta: 'Cliente', tipo: 'cliente', requerido: true },
            { id: 'lote', etiqueta: 'Lote o parcela', tipo: 'text', requerido: true, lista: 'lista-parcelas' },
            { id: 'variedad', etiqueta: 'Variedad', tipo: 'text', requerido: true, lista: 'lista-variedades', falta: 'Escribe la variedad sembrada.' },
            { id: 'proceso', etiqueta: 'Fase', tipo: 'select', opciones: FASES_AGRONOMICAS, requerido: true },
            {
                id: 'germinacion', etiqueta: '% de germinación', tipo: 'number', requerido: true, min: 0, max: 100, paso: 'any',
                ejemplo: 'Ej.: 92', falta: 'Escribe el % de germinación del lote.', soloSi: (f) => f.proceso.value === FASE_CONTEO_GERMINACION
            },
            { id: 'fechaInicio', etiqueta: 'Fecha de inicio', tipo: 'date', requerido: true, hoy: true },
            { id: 'fechaFin', etiqueta: 'Fecha de fin o estimada', tipo: 'date' },
            { id: 'comentarios', etiqueta: 'Comentarios', tipo: 'textarea' }
        ],
        columnas: [
            { titulo: 'Lote', valor: r => r.lote },
            { titulo: 'Variedad', valor: r => r.variedad },
            { titulo: 'Fase', valor: r => r.proceso, etiqueta: true },
            { titulo: 'Germinación', valor: r => porcentaje(r.germinacion), dato: true },
            { titulo: 'Fechas', valor: r => `${formatearFecha(r.fechaInicio)} – ${r.fechaFin ? formatearFecha(r.fechaFin) : 'pendiente'}` },
            { titulo: 'Comentarios', valor: r => r.comentarios, largo: true },
            { titulo: 'Registró', valor: r => r.responsable }
        ],
        // Dentro de un cliente: por lote y, en cada lote, de la fecha más antigua a la más reciente
        ordenar: (a, b) => a.lote.localeCompare(b.lote, 'es') || String(a.fechaInicio).localeCompare(String(b.fechaInicio)) ||
            FASES_AGRONOMICAS.indexOf(a.proceso) - FASES_AGRONOMICAS.indexOf(b.proceso)
    },
    rendimiento: {
        pestana: 'Rendimiento',
        titulo: 'Rendimiento de parcelas',
        nuevo: 'Registrar rendimiento',
        vacio: 'Todavía no hay rendimientos registrados.',
        campos: [
            { id: 'clienteId', etiqueta: 'Cliente', tipo: 'cliente' },
            { id: 'lote', etiqueta: 'Parcela o lote', tipo: 'text', requerido: true, lista: 'lista-parcelas' },
            { id: 'fecha', etiqueta: 'Fecha', tipo: 'date', requerido: true, hoy: true },
            { id: 'rendimientoPlanta', etiqueta: 'Rendimiento por planta (unidades)', tipo: 'number', min: 0, paso: 'any' },
            { id: 'canastos', etiqueta: 'Canastos', tipo: 'number', min: 0, paso: 1 },
            { id: 'unidades', etiqueta: 'Unidades totales', tipo: 'number', requerido: true, min: 0, paso: 1 },
            { id: 'detalles', etiqueta: 'Detalles', tipo: 'textarea' }
        ],
        columnas: [
            { titulo: 'Parcela o lote', valor: r => r.lote },
            { titulo: 'Cliente', valor: r => nombreCliente(r), expediente: true, sinCliente: true },
            { titulo: 'Fecha', valor: r => formatearFecha(r.fecha), orden: r => r.fecha },
            { titulo: 'Por planta', valor: r => numero(r.rendimientoPlanta), dato: true },
            { titulo: 'Canastos', valor: r => numero(r.canastos), dato: true },
            { titulo: 'Unidades totales', valor: r => numero(r.unidades), dato: true },
            { titulo: 'Detalles', valor: r => r.detalles, largo: true },
            { titulo: 'Registró', valor: r => r.responsable }
        ]
    }
};

// Módulos cuyos registros pertenecen a un cliente
const MODULOS_DEL_CLIENTE = ['agronomia', 'visitas', 'rendimiento'];

// ----- Utilidades -----
const soloDigitos = (texto) => String(texto || '').replace(/\D/g, '');

// República Dominicana: 10 dígitos (809/829/849) → se antepone el 1 para wa.me
function enlaceWhatsApp(numero) {
    let d = soloDigitos(numero);
    if (d.length === 10) d = '1' + d;
    return d ? `https://wa.me/${d}` : '';
}

// 'AAAA-MM-DD' como fecha local (new Date('AAAA-MM-DD') la toma en UTC y en RD sale el día anterior)
function fechaLocal(iso, hora = 0, minutos = 0) {
    const [a, m, d] = String(iso).split('-').map(Number);
    return new Date(a, m - 1, d, hora, minutos);
}

function formatearFecha(iso) {
    if (!iso) return '';
    return fechaLocal(iso).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });
}

function hoyISO() {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
}

const numero = (v) => (v === '' || v === undefined || v === null) ? '' : Number(v).toLocaleString('es-DO');
const porcentaje = (v) => numero(v) && `${numero(v)} %`;

const nuevoId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizar = (texto) => String(texto || '').trim().toLocaleLowerCase('es');

// Nombre del cliente de un registro: el actual de su ficha (por si se renombró) o el que se guardó
function nombreCliente(registro) {
    const crm = window.crm;
    const cliente = crm && registro.clienteId && crm.cliente(registro.clienteId);
    return cliente ? cliente.nombre : (registro.cliente || '');
}

function resumenCliente(clienteId) {
    const crm = window.crm;
    if (!crm) return '';
    const n = crm.delCliente('agronomia', clienteId).length;
    return n === 1 ? '1 proceso' : `${n} procesos`;
}

class CRM {
    constructor(dashboard) {
        window.crm = this; // Las columnas consultan los clientes mientras se pintan las tablas
        this.dashboard = dashboard;
        this.google = dashboard && dashboard.google;
        this.db = window.baseDatos;
        this.unirRegistrosSueltos();

        this.tablist = document.querySelector('.nav-tabs');
        this.contenedor = document.getElementById('modules-container');
        this.dialogo = document.getElementById('dialogo-registro');

        this.crearListas();
        Object.keys(MODULOS_CRM).forEach(m => this.crearModulo(m));
        this.iniciarPestanas();
        this.crearIndicadorSync();
        this.renderTodo();

        // Cuando llegan datos de la hoja (o cambian aquí), se repintan tablas, listas y el expediente abierto
        this.db.alCambiar((motivo) => {
            this.pintarIndicadorSync();
            if (motivo !== 'sincronizado') return;
            this.unirRegistrosSueltos();
            this.renderTodo();
            this.actualizarListas();
            if (this.expedienteAbierto && this.dialogo.open && this.dialogo.querySelector('.expediente')) {
                if (this.cliente(this.expedienteAbierto)) this.abrirExpediente(this.expedienteAbierto, { enfocar: false });
                else this.dialogo.close(); // Otra persona eliminó al cliente
            }
        });
        this.db.iniciar();
    }

    // Los datos son los de la base compartida
    get datos() {
        return this.db.datos;
    }

    // ----- Estado de la sincronización, en la barra superior -----
    crearIndicadorSync() {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'estado-sync';
        boton.className = 'estado-sync';
        boton.addEventListener('click', () => this.db.sincronizar());
        const texto = document.createElement('span');
        texto.setAttribute('aria-live', 'polite');
        boton.append(document.createElement('i'), texto);
        document.getElementById('app-nav').appendChild(boton);
        this.indicador = boton;
        this.pintarIndicadorSync();
        // "hace X s" avanza solo
        setInterval(() => this.pintarIndicadorSync(), 15000);
    }

    pintarIndicadorSync() {
        const db = this.db;
        const pendientes = db.pendientes();
        let estado, texto, titulo;
        if (!db.compartida) {
            estado = 'local';
            texto = 'Solo en este navegador';
            titulo = 'Sin URL del Apps Script: los datos no se comparten con el equipo (ver googleSync.js)';
        } else if (db.sincronizando) {
            estado = 'trabajando';
            texto = 'Sincronizando…';
            titulo = 'Enviando cambios y trayendo los del equipo';
        } else if (db.error) {
            estado = 'error';
            texto = pendientes ? `Sin conexión · ${pendientes} ${pendientes === 1 ? 'cambio pendiente' : 'cambios pendientes'}` : 'Sin conexión';
            titulo = `${db.error}. Pulsa para reintentar.`;
        } else if (pendientes) {
            estado = 'trabajando';
            texto = `${pendientes} ${pendientes === 1 ? 'cambio' : 'cambios'} por subir`;
            titulo = 'Se suben en unos segundos. Pulsa para sincronizar ahora.';
        } else {
            estado = 'ok';
            const s = db.ultimaSincronizacion ? Math.round((Date.now() - db.ultimaSincronizacion) / 1000) : null;
            texto = s === null ? 'Conectando…' : s < 10 ? 'Sincronizado' : `Sincronizado hace ${s < 60 ? `${s} s` : `${Math.round(s / 60)} min`}`;
            titulo = 'Los datos coinciden con la hoja compartida. Pulsa para sincronizar ahora.';
        }
        this.indicador.dataset.estado = estado;
        this.indicador.title = titulo;
        this.indicador.setAttribute('aria-label', `${texto}. ${titulo}`);
        const span = this.indicador.querySelector('span');
        if (span.textContent !== texto) span.textContent = texto;
    }

    cliente(id) {
        return this.datos.clientes.find(c => c.id === id) || null;
    }

    delCliente(modulo, clienteId) {
        return this.datos[modulo].filter(r => r.clienteId === clienteId);
    }

    /**
     * Registros guardados antes de unirse por identificador (con el cliente escrito a mano):
     * si el nombre coincide con un cliente registrado, pasan a su expediente.
     */
    unirRegistrosSueltos() {
        const porNombre = new Map(this.datos.clientes.map(c => [normalizar(c.nombre), c.id]));
        MODULOS_DEL_CLIENTE.forEach(modulo => {
            [...this.datos[modulo]].forEach(r => {
                const sinId = !r.id;
                const unible = !r.clienteId && r.cliente && porNombre.has(normalizar(r.cliente));
                if (!sinId && !unible) return;
                const copia = { ...r };
                delete copia._remoto;
                delete copia._pendiente;
                if (sinId) copia.id = nuevoId();
                if (unible) copia.clienteId = porNombre.get(normalizar(r.cliente));
                if (sinId) this.datos[modulo].splice(this.datos[modulo].indexOf(r), 1); // Se vuelve a añadir con id
                this.db.guardar(modulo, copia);
            });
        });
    }

    // Sugerencias para el campo de parcela
    crearListas() {
        this.listaParcelas = document.createElement('datalist');
        this.listaParcelas.id = 'lista-parcelas';
        this.listaVariedades = document.createElement('datalist');
        this.listaVariedades.id = 'lista-variedades';
        document.body.append(this.listaParcelas, this.listaVariedades);
        this.actualizarListas();
    }

    actualizarListas() {
        const parcelas = this.dashboard && this.dashboard.cultivos
            ? this.dashboard.cultivos.map(c => `${c.nombre} (${c.tipo === 'invernadero' ? 'invernadero' : 'campo abierto'})`)
            : [];
        const valores = [...parcelas, ...this.datos.rendimiento.map(r => r.lote), ...this.datos.agronomia.map(r => r.lote)];
        this.llenarLista(this.listaParcelas, valores);
        // Las variedades se sugieren a partir de las ya registradas
        this.llenarLista(this.listaVariedades, this.datos.agronomia.map(r => r.variedad));
    }

    llenarLista(lista, valores) {
        lista.innerHTML = '';
        [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')).forEach(v => {
            const o = document.createElement('option');
            o.value = v;
            lista.appendChild(o);
        });
    }

    // ----- Pestaña y panel de un módulo -----
    crearModulo(modulo) {
        const def = MODULOS_CRM[modulo];

        const pestana = document.createElement('button');
        pestana.type = 'button';
        pestana.className = 'nav-tab';
        pestana.id = `tab-${modulo}`;
        pestana.setAttribute('aria-controls', `mod-${modulo}`);
        pestana.textContent = def.pestana;
        this.tablist.appendChild(pestana);

        const seccion = document.createElement('section');
        seccion.id = `mod-${modulo}`;
        seccion.className = 'app-module modulo-crm';
        seccion.setAttribute('role', 'region');
        seccion.setAttribute('aria-labelledby', `tab-${modulo}`);
        seccion.hidden = true;

        const cabecera = document.createElement('div');
        cabecera.className = 'module-header';
        const textos = document.createElement('div');
        const h2 = document.createElement('h2');
        h2.textContent = def.titulo;
        textos.appendChild(h2);
        const contador = document.createElement('p');
        contador.className = 'module-sub';
        contador.id = `contador-${modulo}`;
        textos.appendChild(contador);
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'btn-primary';
        boton.textContent = def.nuevo;
        boton.addEventListener('click', () => this.abrirFormulario(modulo));
        cabecera.append(textos, boton);

        const cuerpo = document.createElement('div');
        cuerpo.className = 'table-container';
        if (def.subtitulo) {
            const nota = document.createElement('p');
            nota.className = 'module-nota';
            nota.textContent = def.subtitulo;
            cuerpo.appendChild(nota);
        }
        const contenido = document.createElement('div');
        contenido.id = `contenido-${modulo}`;
        const vacio = document.createElement('p');
        vacio.className = 'tabla-vacia';
        vacio.id = `vacio-${modulo}`;
        vacio.textContent = def.vacio;
        cuerpo.append(contenido, vacio);

        seccion.append(cabecera, cuerpo);
        this.contenedor.appendChild(seccion);
    }

    // Menú de módulos: botón con el módulo actual y lista (flechas arriba/abajo, Inicio, Fin y Escape)
    iniciarPestanas() {
        const boton = document.getElementById('btn-modulos');
        const textoBoton = boton.querySelector('.btn-modulos-texto');
        const pestanas = () => [...this.tablist.querySelectorAll('.nav-tab')];
        const abrirMenu = (abrir, enfocar = abrir) => {
            this.tablist.hidden = !abrir;
            boton.setAttribute('aria-expanded', String(abrir));
            if (abrir && enfocar) (this.tablist.querySelector('[aria-current="true"]') || pestanas()[0]).focus();
        };
        this.activarPestana = (pestana) => {
            pestanas().forEach(p => {
                const activa = p === pestana;
                if (activa) p.setAttribute('aria-current', 'true');
                else p.removeAttribute('aria-current');
                document.getElementById(p.getAttribute('aria-controls')).hidden = !activa;
            });
            textoBoton.textContent = pestana.textContent;
            const enSimulador = pestana.id === 'tab-simulador';
            if (this.dashboard) {
                this.dashboard.simuladorVisible = enSimulador;
                // Al volver, el canvas recupera su tamaño (oculto medía 0 x 0)
                if (enSimulador) window.dispatchEvent(new Event('resize'));
            }
        };
        boton.addEventListener('click', () => abrirMenu(this.tablist.hidden));
        boton.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            abrirMenu(true);
        });
        pestanas().forEach(p => p.addEventListener('click', () => {
            this.activarPestana(p);
            abrirMenu(false);
            boton.focus();
        }));
        this.tablist.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                abrirMenu(false);
                boton.focus();
                return;
            }
            const lista = pestanas();
            const i = lista.indexOf(document.activeElement);
            let j = null;
            if (e.key === 'ArrowDown') j = (i + 1) % lista.length;
            if (e.key === 'ArrowUp') j = (i - 1 + lista.length) % lista.length;
            if (e.key === 'Home') j = 0;
            if (e.key === 'End') j = lista.length - 1;
            if (j === null) return;
            e.preventDefault();
            lista[j].focus();
        });
        // Se cierra al pulsar fuera o al salir con el tabulador
        document.addEventListener('click', (e) => {
            if (!this.tablist.hidden && !e.target.closest('.menu-modulos')) abrirMenu(false);
        });
        this.tablist.addEventListener('focusout', (e) => {
            if (e.relatedTarget && !e.relatedTarget.closest('.menu-modulos')) abrirMenu(false);
        });
        this.activarPestana(document.getElementById('tab-simulador'));
    }

    // ----- Tablas -----
    renderTodo() {
        Object.keys(MODULOS_CRM).forEach(m => this.renderTabla(m));
    }

    /**
     * Tabla de registros de un módulo. dentroDeCliente: se omite la columna de cliente
     * (en el expediente y en los grupos por cliente ya se sabe de quién es).
     */
    construirTabla(modulo, filas, { titulo, dentroDeCliente = false, conAcciones = true } = {}) {
        const def = MODULOS_CRM[modulo];
        const columnas = def.columnas.filter(c => !(dentroDeCliente && c.sinCliente));
        const tabla = document.createElement('table');
        const caption = document.createElement('caption');
        caption.className = 'solo-lector';
        caption.textContent = titulo || def.titulo;
        const thead = document.createElement('thead');
        const filaCab = document.createElement('tr');
        [...columnas.map(c => c.titulo), ...(conAcciones ? ['Acciones'] : [])].forEach((t, i) => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = t;
            if (conAcciones && i === columnas.length) th.className = 'col-acciones';
            filaCab.appendChild(th);
        });
        thead.appendChild(filaCab);
        const tbody = document.createElement('tbody');

        filas.forEach(registro => {
            const tr = document.createElement('tr');
            columnas.forEach(col => {
                const td = document.createElement('td');
                td.dataset.titulo = col.titulo; // Para la vista en tarjetas del móvil
                if (col.dato) td.className = 'celda-dato';
                if (col.largo) td.classList.add('celda-larga');
                const texto = col.valor(registro) || '';
                const enlace = col.enlace && col.enlace(registro);
                const idCliente = modulo === 'clientes' ? registro.id : registro.clienteId;
                if (col.expediente && texto && idCliente && this.cliente(idCliente)) {
                    // Nombre del cliente: abre su expediente
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'enlace-cliente';
                    b.textContent = texto;
                    b.title = 'Ver expediente';
                    b.addEventListener('click', () => this.abrirExpediente(idCliente));
                    td.appendChild(b);
                } else if (enlace) {
                    const a = document.createElement('a');
                    a.href = enlace;
                    a.textContent = texto;
                    if (enlace.startsWith('http')) {
                        a.target = '_blank';
                        a.rel = 'noopener';
                    }
                    td.appendChild(a);
                } else if (col.etiqueta && texto) {
                    const span = document.createElement('span');
                    span.className = 'etiqueta';
                    span.textContent = texto;
                    td.appendChild(span);
                } else {
                    td.textContent = texto || '—';
                }
                tr.appendChild(td);
            });
            if (conAcciones) {
                const acciones = document.createElement('td');
                acciones.className = 'col-acciones';
                const eliminar = document.createElement('button');
                eliminar.type = 'button';
                eliminar.className = 'btn-texto btn-peligro';
                eliminar.textContent = 'Eliminar';
                eliminar.setAttribute('aria-label', `Eliminar ${columnas[0].valor(registro)}`);
                eliminar.addEventListener('click', () => this.eliminar(modulo, registro.id));
                acciones.appendChild(eliminar);
                tr.appendChild(acciones);
            }
            tbody.appendChild(tr);
        });
        tabla.append(caption, thead, tbody);
        return tabla;
    }

    renderTabla(modulo) {
        const def = MODULOS_CRM[modulo];
        const contenido = document.getElementById(`contenido-${modulo}`);
        contenido.innerHTML = '';
        const registros = this.datos[modulo];

        if (def.agruparPorCliente) {
            // Un bloque por cliente con todo su historial; los de clientes sin ficha, al final por nombre
            const grupos = new Map();
            registros.forEach(r => {
                const clave = r.clienteId && this.cliente(r.clienteId) ? r.clienteId : `sin:${normalizar(r.cliente)}`;
                if (!grupos.has(clave)) grupos.set(clave, []);
                grupos.get(clave).push(r);
            });
            [...grupos.entries()]
                .sort(([, a], [, b]) => nombreCliente(a[0]).localeCompare(nombreCliente(b[0]), 'es'))
                .forEach(([clave, filas]) => {
                    const bloque = document.createElement('section');
                    bloque.className = 'grupo-cliente';
                    const cab = document.createElement('div');
                    cab.className = 'grupo-cliente-cabecera';
                    const h3 = document.createElement('h3');
                    h3.textContent = nombreCliente(filas[0]) || 'Sin cliente';
                    const meta = document.createElement('span');
                    const lotes = new Set(filas.map(f => f.lote)).size;
                    meta.className = 'grupo-cliente-meta';
                    meta.textContent = `${filas.length} ${filas.length === 1 ? 'proceso' : 'procesos'} · ${lotes} ${lotes === 1 ? 'lote' : 'lotes'}`;
                    const titulo = document.createElement('div');
                    titulo.append(h3, meta);
                    cab.appendChild(titulo);
                    if (!clave.startsWith('sin:')) {
                        const ver = document.createElement('button');
                        ver.type = 'button';
                        ver.className = 'btn-secondary';
                        ver.textContent = 'Ver expediente';
                        ver.addEventListener('click', () => this.abrirExpediente(clave));
                        cab.appendChild(ver);
                    } else {
                        const aviso = document.createElement('span');
                        aviso.className = 'grupo-cliente-meta';
                        aviso.textContent = 'Cliente sin ficha: regístralo en Clientes con este mismo nombre para unirlo';
                        titulo.appendChild(aviso);
                    }
                    bloque.append(cab, this.construirTabla(modulo, [...filas].sort(def.ordenar), {
                        titulo: `Procesos de ${h3.textContent}`,
                        dentroDeCliente: true
                    }));
                    contenido.appendChild(bloque);
                });
        } else {
            // Lo más reciente primero (por la columna de fecha si la hay)
            const columnaOrden = def.columnas.find(c => c.orden);
            const filas = [...registros];
            if (columnaOrden) filas.sort((a, b) => String(columnaOrden.orden(b)).localeCompare(String(columnaOrden.orden(a))));
            else filas.reverse();
            if (filas.length) contenido.appendChild(this.construirTabla(modulo, filas));
        }

        const total = registros.length;
        document.getElementById(`vacio-${modulo}`).hidden = total > 0;
        document.getElementById(`contador-${modulo}`).textContent =
            total === 1 ? '1 registro' : `${total.toLocaleString('es-DO')} registros`;
    }

    eliminar(modulo, id) {
        const registro = this.datos[modulo].find(r => r.id === id);
        if (!registro) return;
        const nombre = MODULOS_CRM[modulo].columnas[0].valor(registro);
        let aviso = `¿Eliminar "${nombre}"? Se elimina para todo el equipo y no se puede deshacer.`;
        if (modulo === 'clientes') {
            const n = MODULOS_DEL_CLIENTE.reduce((acc, m) => acc + this.delCliente(m, id).length, 0);
            if (n) aviso += `\n\nTiene ${n} ${n === 1 ? 'registro' : 'registros'} (procesos, visitas o rendimientos). Se conservan con su nombre, pero sin expediente.`;
        }
        if (!window.confirm(aviso)) return;
        if (modulo === 'clientes') {
            // Los registros del cliente guardan su nombre para seguir identificándose
            MODULOS_DEL_CLIENTE.forEach(m => {
                this.delCliente(m, id).forEach(r => {
                    const copia = { ...r, cliente: registro.nombre };
                    delete copia.clienteId;
                    delete copia._remoto;
                    delete copia._pendiente;
                    this.db.guardar(m, copia);
                });
            });
        }
        this.db.eliminar(modulo, id);
        this.renderTodo();
        this.actualizarListas();
        if (this.expedienteAbierto && this.dialogo.open) {
            if (modulo === 'clientes' && id === this.expedienteAbierto) this.dialogo.close();
            else this.abrirExpediente(this.expedienteAbierto);
        }
    }

    // ----- Expediente del cliente: todo lo suyo en un solo sitio -----
    abrirExpediente(clienteId, { enfocar = true } = {}) {
        const cliente = this.cliente(clienteId);
        if (!cliente) return;
        this.expedienteAbierto = clienteId;
        const caja = document.createElement('div');
        caja.className = 'expediente';

        const cab = document.createElement('div');
        cab.className = 'expediente-cabecera';
        const titulo = document.createElement('h3');
        titulo.id = 'dialogo-titulo';
        titulo.textContent = cliente.nombre;
        const datos = document.createElement('p');
        datos.className = 'expediente-datos';
        datos.textContent = [cliente.ubicacion, cliente.telefono && `Tel. ${cliente.telefono}`, cliente.whatsapp && `WhatsApp ${cliente.whatsapp}`,
            cliente.marca, cliente.seguimiento && `Próximo seguimiento: ${formatearFecha(cliente.seguimiento)}`]
            .filter(Boolean).join(' · ') || 'Sin datos de contacto';
        const cerrar = document.createElement('button');
        cerrar.type = 'button';
        cerrar.className = 'btn-texto';
        cerrar.textContent = 'Cerrar';
        cerrar.addEventListener('click', () => this.dialogo.close());
        const textos = document.createElement('div');
        textos.append(titulo, datos);
        cab.append(textos, cerrar);
        caja.appendChild(cab);

        // Atajos para registrar algo de este cliente sin volver a elegirlo
        const atajos = document.createElement('div');
        atajos.className = 'expediente-atajos';
        [['agronomia', 'Nuevo proceso'], ['visitas', 'Registrar visita'], ['rendimiento', 'Registrar rendimiento']].forEach(([m, texto]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = m === 'agronomia' ? 'btn-primary' : 'btn-secondary';
            b.textContent = texto;
            b.addEventListener('click', () => this.abrirFormulario(m, { clienteId }, () => this.abrirExpediente(clienteId)));
            atajos.appendChild(b);
        });
        caja.appendChild(atajos);

        // Procesos agronómicos: un bloque por lote, en orden de fechas (línea de tiempo)
        const procesos = this.delCliente('agronomia', clienteId).sort(MODULOS_CRM.agronomia.ordenar);
        const seccion = (texto, cantidad) => {
            const s = document.createElement('section');
            s.className = 'expediente-seccion';
            const h4 = document.createElement('h4');
            h4.textContent = `${texto} (${cantidad})`;
            s.appendChild(h4);
            caja.appendChild(s);
            return s;
        };
        const sProc = seccion('Procesos agronómicos', procesos.length);
        if (!procesos.length) {
            sProc.appendChild(this.textoVacio('Aún no tiene procesos registrados.'));
        } else {
            const porLote = new Map();
            procesos.forEach(p => {
                if (!porLote.has(p.lote)) porLote.set(p.lote, []);
                porLote.get(p.lote).push(p);
            });
            porLote.forEach((lista, lote) => {
                const bloque = document.createElement('div');
                bloque.className = 'linea-lote';
                const h5 = document.createElement('h5');
                h5.textContent = lote;
                const ol = document.createElement('ol');
                ol.className = 'linea-tiempo';
                lista.forEach(p => {
                    const li = document.createElement('li');
                    const fase = document.createElement('span');
                    fase.className = 'etiqueta';
                    fase.textContent = p.proceso;
                    const fechas = document.createElement('span');
                    fechas.className = 'linea-fechas';
                    fechas.textContent = `${formatearFecha(p.fechaInicio)} – ${p.fechaFin ? formatearFecha(p.fechaFin) : 'pendiente'}`;
                    li.append(fase, fechas);
                    const datos = [p.variedad && `Variedad ${p.variedad}`, porcentaje(p.germinacion) && `${porcentaje(p.germinacion)} de germinación`,
                        p.responsable && `registró ${p.responsable}`].filter(Boolean);
                    if (datos.length) {
                        const det = document.createElement('p');
                        det.className = 'linea-datos';
                        det.textContent = datos.join(' · ');
                        li.appendChild(det);
                    }
                    if (p.comentarios) {
                        const com = document.createElement('p');
                        com.className = 'linea-comentario';
                        com.textContent = p.comentarios;
                        li.appendChild(com);
                    }
                    ol.appendChild(li);
                });
                bloque.append(h5, ol);
                sProc.appendChild(bloque);
            });
        }

        const visitas = this.delCliente('visitas', clienteId).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
        const sVis = seccion('Visitas', visitas.length);
        sVis.appendChild(visitas.length
            ? this.envolverTabla(this.construirTabla('visitas', visitas, { titulo: `Visitas a ${cliente.nombre}`, dentroDeCliente: true, conAcciones: false }))
            : this.textoVacio('Aún no tiene visitas registradas.'));

        const rend = this.delCliente('rendimiento', clienteId).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
        const sRen = seccion('Rendimientos', rend.length);
        sRen.appendChild(rend.length
            ? this.envolverTabla(this.construirTabla('rendimiento', rend, { titulo: `Rendimientos de ${cliente.nombre}`, dentroDeCliente: true, conAcciones: false }))
            : this.textoVacio('Aún no tiene rendimientos registrados.'));

        this.dialogo.classList.add('dialogo-ancho');
        this.dialogo.innerHTML = '';
        this.dialogo.appendChild(caja);
        if (!this.dialogo.open) this.dialogo.showModal();
        if (enfocar) cerrar.focus();
        this.dialogo.addEventListener('close', () => {
            this.expedienteAbierto = null;
            this.dialogo.classList.remove('dialogo-ancho');
        }, { once: true });
    }

    // Las tablas del expediente usan los mismos estilos que las de los módulos (y sus tarjetas en el móvil)
    envolverTabla(tabla) {
        const envoltorio = document.createElement('div');
        envoltorio.className = 'table-container expediente-tabla';
        envoltorio.appendChild(tabla);
        return envoltorio;
    }

    textoVacio(texto) {
        const p = document.createElement('p');
        p.className = 'expediente-vacio';
        p.textContent = texto;
        return p;
    }

    // ----- Formulario en el diálogo -----
    /**
     * valores: datos con los que empieza el formulario (p. ej. { clienteId } desde un expediente).
     * alTerminar: qué hacer al guardar o cancelar (volver al expediente); si no, se cierra el diálogo.
     */
    abrirFormulario(modulo, valores = {}, alTerminar = null) {
        const def = MODULOS_CRM[modulo];
        const terminar = () => (alTerminar ? alTerminar() : this.dialogo.close());
        this.dialogo.classList.remove('dialogo-ancho');
        const form = document.createElement('form');
        form.className = 'dialogo-form';
        form.noValidate = true; // Validación propia, con los mensajes junto a cada campo

        const titulo = document.createElement('h3');
        titulo.id = 'dialogo-titulo';
        titulo.textContent = def.nuevo;
        form.appendChild(titulo);

        // Sin clientes registrados no se puede unir el registro a nadie: se invita a registrar uno
        const pideCliente = def.campos.some(c => c.tipo === 'cliente' && c.requerido);
        if (pideCliente && !this.datos.clientes.length) {
            const p = document.createElement('p');
            p.className = 'expediente-vacio';
            p.textContent = 'Primero registra al cliente: así todo lo suyo queda en su expediente.';
            const acciones = document.createElement('div');
            acciones.className = 'modal-actions';
            const cancelar = document.createElement('button');
            cancelar.type = 'button';
            cancelar.className = 'btn-secondary';
            cancelar.textContent = 'Cancelar';
            cancelar.addEventListener('click', terminar);
            const registrar = document.createElement('button');
            registrar.type = 'button';
            registrar.className = 'btn-primary';
            registrar.textContent = 'Registrar cliente';
            registrar.addEventListener('click', () => this.abrirFormulario('clientes', {}, () => this.abrirFormulario(modulo, valores, alTerminar)));
            acciones.append(cancelar, registrar);
            form.append(p, acciones);
            this.mostrarEnDialogo(form);
            registrar.focus();
            return;
        }

        def.campos.forEach(campo => {
            const grupo = document.createElement('div');
            grupo.className = 'form-group';
            const id = `campo-${modulo}-${campo.id}`;
            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = campo.etiqueta + (campo.requerido ? '' : ' (opcional)');

            let control;
            if (campo.tipo === 'textarea') {
                control = document.createElement('textarea');
                control.rows = 3;
            } else if (campo.tipo === 'select' || campo.tipo === 'cliente') {
                control = document.createElement('select');
                const opciones = campo.tipo === 'cliente'
                    ? [...this.datos.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map(c => [c.id, c.nombre])
                    : campo.opciones.map(o => [o, o]);
                if (campo.vacia) {
                    const vacia = document.createElement('option');
                    vacia.value = '';
                    vacia.textContent = campo.vacia;
                    control.appendChild(vacia);
                }
                if (campo.tipo === 'cliente') {
                    const vacia = document.createElement('option');
                    vacia.value = '';
                    vacia.textContent = campo.requerido ? 'Elige un cliente' : 'Sin cliente';
                    control.appendChild(vacia);
                }
                opciones.forEach(([valor, texto]) => {
                    const o = document.createElement('option');
                    o.value = valor;
                    o.textContent = texto;
                    control.appendChild(o);
                });
            } else {
                control = document.createElement('input');
                control.type = campo.tipo;
                if (campo.lista) control.setAttribute('list', campo.lista);
                if (campo.autocomplete) control.autocomplete = campo.autocomplete;
                if (campo.min !== undefined) control.min = campo.min;
                if (campo.max !== undefined) control.max = campo.max;
                if (campo.paso !== undefined) control.step = campo.paso;
                if (campo.tipo === 'tel') control.inputMode = 'tel';
                if (campo.tipo === 'number') control.inputMode = campo.paso === 1 ? 'numeric' : 'decimal';
            }
            control.id = id;
            control.name = campo.id;
            if (campo.requerido) control.required = true;
            if (campo.ejemplo) control.placeholder = campo.ejemplo;
            if (campo.hoy) control.value = hoyISO();
            if (valores[campo.id] !== undefined) control.value = valores[campo.id];

            const error = document.createElement('p');
            error.className = 'form-error';
            error.id = `${id}-error`;
            error.hidden = true;
            control.setAttribute('aria-describedby', error.id);
            control.addEventListener('input', () => this.limpiarError(control));

            grupo.append(label, control, error);
            if (campo.soloSi) grupo.dataset.condicional = campo.id;
            form.appendChild(grupo);
        });

        // Campos que dependen de otro (p. ej. el % de germinación según la fase)
        const condicionales = def.campos.filter(c => c.soloSi);
        if (condicionales.length) {
            const mostrar = () => condicionales.forEach(c => {
                form.querySelector(`[data-condicional="${c.id}"]`).hidden = !c.soloSi(form.elements);
            });
            form.addEventListener('change', mostrar);
            mostrar();
        }

        // Al elegir el cliente se completa la ubicación de la visita con la de su ficha
        if (modulo === 'visitas') {
            const rellenar = () => {
                const c = this.cliente(form.elements.clienteId.value);
                if (c && c.ubicacion && !form.elements.ubicacion.value) form.elements.ubicacion.value = c.ubicacion;
            };
            form.elements.clienteId.addEventListener('change', rellenar);
            rellenar();
        }

        const acciones = document.createElement('div');
        acciones.className = 'modal-actions';
        const cancelar = document.createElement('button');
        cancelar.type = 'button';
        cancelar.className = 'btn-secondary';
        cancelar.textContent = 'Cancelar';
        cancelar.addEventListener('click', terminar);
        const guardar = document.createElement('button');
        guardar.type = 'submit';
        guardar.className = 'btn-primary';
        guardar.textContent = modulo === 'agronomia' ? 'Guardar y agendar' : 'Guardar';
        acciones.append(cancelar, guardar);
        form.appendChild(acciones);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!this.validar(modulo, form)) return;
            this.guardar(modulo, form);
            terminar();
        });

        this.mostrarEnDialogo(form);
        // El foco va al primer campo por rellenar (si el cliente ya viene puesto, al siguiente)
        const primero = [...form.querySelectorAll('input, select, textarea')].find(c => !c.value) || form.querySelector('input, select, textarea');
        primero.focus();
    }

    mostrarEnDialogo(contenido) {
        this.dialogo.innerHTML = '';
        this.dialogo.appendChild(contenido);
        if (!this.dialogo.open) this.dialogo.showModal();
    }

    mostrarError(control, mensaje) {
        const error = document.getElementById(`${control.id}-error`);
        error.textContent = mensaje;
        error.hidden = false;
        control.setAttribute('aria-invalid', 'true');
    }

    limpiarError(control) {
        const error = document.getElementById(`${control.id}-error`);
        if (error) error.hidden = true;
        control.removeAttribute('aria-invalid');
    }

    validar(modulo, form) {
        let primero = null;
        const fallo = (control, mensaje) => {
            this.mostrarError(control, mensaje);
            if (!primero) primero = control;
        };
        MODULOS_CRM[modulo].campos.forEach(campo => {
            const control = form.elements[campo.id];
            const valor = control.value.trim();
            this.limpiarError(control);
            if (campo.soloSi && !campo.soloSi(form.elements)) return;
            if (campo.requerido && !valor) {
                return fallo(control, campo.falta || (campo.tipo === 'cliente' ? 'Elige el cliente.' : `Escribe ${campo.etiqueta.toLowerCase()}.`));
            }
            if (campo.tipo === 'number' && valor !== '') {
                const n = Number(valor);
                if (campo.max !== undefined && (Number.isNaN(n) || n < campo.min || n > campo.max)) {
                    return fallo(control, `Escribe un número entre ${campo.min} y ${campo.max}.`);
                }
                if (Number.isNaN(n) || n < (campo.min ?? -Infinity)) return fallo(control, 'Escribe un número válido, 0 o mayor.');
                if (campo.paso === 1 && !Number.isInteger(n)) return fallo(control, 'Escribe un número entero.');
            }
            if (campo.tipo === 'tel' && valor !== '' && soloDigitos(valor).length < 10) {
                return fallo(control, 'El número necesita al menos 10 dígitos, por ejemplo 809 555 1234.');
            }
        });
        if (modulo === 'agronomia') {
            const ini = form.elements.fechaInicio.value, fin = form.elements.fechaFin.value;
            if (ini && fin && fin < ini) fallo(form.elements.fechaFin, 'La fecha de fin no puede ser anterior a la de inicio.');
        }
        if (modulo === 'clientes') {
            const nombre = normalizar(form.elements.nombre.value);
            if (nombre && this.datos.clientes.some(c => normalizar(c.nombre) === nombre)) {
                fallo(form.elements.nombre, 'Ya hay un cliente con ese nombre.');
            }
        }
        if (primero) primero.focus();
        return !primero;
    }

    guardar(modulo, form) {
        // Quién lo registró: el responsable de este navegador (usuario.js)
        const registro = { id: nuevoId(), creado: new Date().toISOString(), responsable: window.responsable ? window.responsable.nombre : '' };
        MODULOS_CRM[modulo].campos.forEach(campo => {
            const visible = !campo.soloSi || campo.soloSi(form.elements);
            const v = visible ? form.elements[campo.id].value.trim() : '';
            registro[campo.id] = campo.tipo === 'number' && v !== '' ? Number(v) : v;
        });
        // Se guarda también el nombre del cliente: la hoja de cálculo y los avisos lo muestran legible
        if ('clienteId' in registro) {
            const c = this.cliente(registro.clienteId);
            registro.cliente = c ? c.nombre : '';
            if (!registro.clienteId) delete registro.clienteId;
        }
        const guardado = this.db.guardar(modulo, registro); // Se sube a la hoja compartida en unos segundos

        // Un cliente nuevo con el mismo nombre que registros sueltos: se los queda
        if (modulo === 'clientes') this.unirRegistrosSueltos();

        this.renderTodo();
        this.actualizarListas();
        if (!guardado) {
            window.alert('El navegador no permite guardar datos en este momento: el registro se perderá al cerrar la página.');
        }

        // Cliente con próximo seguimiento: recordatorio en Google Calendar (9:00 a 9:30 de ese día)
        if (modulo === 'clientes' && registro.seguimiento && this.google) {
            this.google.agendarCalendar({
                titulo: `Seguimiento · ${registro.nombre}`,
                inicio: fechaLocal(registro.seguimiento, 9).toISOString(),
                fin: fechaLocal(registro.seguimiento, 9, 30).toISOString(),
                descripcion: [registro.ubicacion, registro.telefono && `Tel. ${registro.telefono}`,
                    registro.whatsapp && `WhatsApp ${registro.whatsapp}`, registro.marca, registro.responsable && `Registró: ${registro.responsable}`]
                    .filter(Boolean).join('\n')
            });
        }

        // Procesos agronómicos: se agendan en Google Calendar (de 8:00 a 17:00 del último día)
        if (modulo === 'agronomia' && this.google) {
            const inicio = fechaLocal(registro.fechaInicio, 8);
            const fin = registro.fechaFin ? fechaLocal(registro.fechaFin, 17) : fechaLocal(registro.fechaInicio, 8, 30);
            this.google.agendarCalendar({
                titulo: `${registro.proceso} · ${registro.cliente} · ${registro.lote}`,
                inicio: inicio.toISOString(),
                fin: fin.toISOString(),
                descripcion: [
                    `Variedad: ${registro.variedad}`,
                    porcentaje(registro.germinacion) && `Germinación: ${porcentaje(registro.germinacion)}`,
                    registro.comentarios
                ].filter(Boolean).join('\n')
            });
            this.google.enviarNotificacionMovil('Proceso agendado',
                `${registro.proceso} de ${registro.cliente}, ${formatearFecha(registro.fechaInicio)}.`);
        }
    }
}

window.addEventListener('load', () => {
    new CRM(window.appDashboard);
});
