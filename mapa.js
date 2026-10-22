/**
 * Mapa interactivo: al pulsar un edificio o una parcela del simulador 3D se abre un panel con su
 * información, que se puede editar (por ejemplo, la lista de precios de las oficinas).
 *
 * Cada lugar tiene una caja invisible que recibe los clics (los edificios están hechos de muchas
 * piezas y algunas se agrupan en instancias). El botón "Lugares" da acceso a todos sin ratón.
 * Los textos editados se guardan en la base compartida (pestaña "CRM · sitios" de la hoja), así que
 * todo el equipo ve la misma lista de precios y las mismas notas.
 *
 * Debajo del texto, algunas fichas traen más: las oficinas, el cotizador (cotizador.js), y cada parcela,
 * sus ensayos por variedad, sacados de los procesos agronómicos registrados en ese lote.
 */

// Lugares de la finca: centro (x, z), tamaño de la zona que recibe clics (ancho, alto, fondo) y texto inicial
const SITIOS_MAPA = [
    {
        id: 'oficina', titulo: 'Oficinas', centro: [-26.5, 5.4], zona: [8.3, 4, 5.3],
        texto: 'Lista de precios vigente:\n- Semilla de tomate saladette F1: $45 / sobre\n- Semilla de pimiento blocky: $50 / sobre\n- Asesoría técnica: incluida'
    },
    {
        id: 'empaque', titulo: 'Almacén, laboratorio y empaque', centro: [-23, -14], zona: [10, 8, 8],
        texto: 'Cada lote se prueba en el laboratorio antes de salir. Los tractores descargan las cajas frente al portón.'
    },
    {
        id: 'agroquimicos', titulo: 'Almacén de agroquímicos', centro: [-12, 20], zona: [7.4, 4, 4.4],
        texto: 'Productos para enfermedades, virus y plagas. Acceso restringido; uso obligatorio de equipo de protección.'
    },
    {
        id: 'riego', titulo: 'Cuarto de riego', centro: [-26.1, 20.8], zona: [11.6, 3.5, 4.5],
        texto: 'Fertirriego: reservorio de agua, tanques de solución A, B y ácido, y filtros de arena.'
    },
    {
        id: 'germinador', titulo: 'Germinador', centro: [22, 21], zona: [22.4, 3.2, 4.8],
        texto: 'Bandejas identificadas por lote. La emergencia se cuenta lote por lote y va en la ficha de entrega.'
    },
    {
        id: 'entrada', titulo: 'Entrada y vigilancia', centro: [-1, 23], zona: [11, 5, 3.5],
        texto: 'Portón principal con caseta de vigilancia y pluma de control de acceso.'
    },
    {
        id: 'marcas', titulo: 'Marcas que representamos', centro: [18, -19.6], zona: [30, 9, 2],
        texto: 'Gautier Semences, Hexagon Seeds, Genome Seeds y Fitó.'
    },
    {
        id: 'parcela-libre', titulo: 'Parcela libre', centro: [29, 8], zona: [8, 1, 10],
        texto: 'Tierra preparada, en espera de siembra.'
    }
];

class MapaInteractivo {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.db = window.baseDatos;
        this.sitios = [];
        this.zonas = [];
        this.raycaster = new THREE.Raycaster();
        this.puntero = new THREE.Vector2();
        this.contenedor = document.getElementById('canvas-container');
        this.lienzo = dashboard.renderer.domElement;

        this.crearZonas();
        this.crearPanel();
        this.crearEtiqueta();
        this.crearMenuLugares();
        this.escucharPuntero();

        // Si otra persona cambia la ficha abierta, se ve aquí (salvo mientras se está editando)
        this.db.alCambiar((motivo) => {
            if (!this.actual || this.panel.hidden) return;
            if (motivo === 'sincronizado' && this.edicion.hidden) this.pintarTexto();
            // Los ensayos de la parcela, también con lo registrado aquí mismo
            if ((motivo === 'sincronizado' || motivo === 'local') && this.actual.cultivo) this.pintarEnsayos();
        });
    }

    // Una caja invisible por lugar: edificios fijos y una por parcela de cultivo
    crearZonas() {
        const material = new THREE.MeshBasicMaterial();
        const agregar = (sitio) => {
            const [ancho, alto, fondo] = sitio.zona;
            const caja = new THREE.Mesh(new THREE.BoxGeometry(ancho, alto, fondo), material);
            caja.position.set(sitio.centro[0], alto / 2, sitio.centro[1]);
            caja.visible = false; // No se dibuja, pero el raycaster la detecta igual
            caja.userData.sitio = sitio;
            this.dashboard.scene.add(caja);
            this.zonas.push(caja);
            this.sitios.push(sitio);
        };
        SITIOS_MAPA.forEach(agregar);
        this.dashboard.cultivos.forEach(c => {
            const invernadero = c.tipo === 'invernadero';
            agregar({
                id: `parcela-${c.clave}`,
                titulo: `${c.nombre} · ${invernadero ? 'invernadero' : 'campo abierto'}`,
                centro: [c.mesh.position.x, c.mesh.position.z],
                zona: invernadero ? [4.6, 4.9, 10] : [8, 1.2, 10],
                texto: '',
                cultivo: c
            });
        });
    }

    // ----- Panel de información (no modal: el mapa sigue usable detrás) -----
    crearPanel() {
        const panel = document.createElement('section');
        panel.id = 'mapa-panel';
        panel.className = 'mapa-panel';
        panel.setAttribute('aria-labelledby', 'mapa-panel-titulo');
        panel.hidden = true;
        panel.innerHTML = `
            <div class="mapa-panel-cabecera">
                <h3 id="mapa-panel-titulo"></h3>
                <button type="button" class="btn-texto mapa-cerrar" aria-label="Cerrar información del lugar">Cerrar</button>
            </div>
            <p class="mapa-panel-estado" hidden></p>
            <div class="mapa-panel-vista">
                <p class="mapa-panel-texto"></p>
                <button type="button" class="btn-secondary mapa-editar">Editar información</button>
            </div>
            <div class="mapa-extra" hidden></div>
            <form class="mapa-panel-edicion" hidden>
                <label class="solo-lector" for="mapa-panel-textarea">Información del lugar</label>
                <textarea id="mapa-panel-textarea" rows="7"></textarea>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary mapa-cancelar">Cancelar</button>
                    <button type="submit" class="btn-primary">Guardar</button>
                </div>
            </form>`;
        this.contenedor.appendChild(panel);
        this.panel = panel;
        this.panelTitulo = panel.querySelector('#mapa-panel-titulo');
        this.panelEstado = panel.querySelector('.mapa-panel-estado');
        this.panelTexto = panel.querySelector('.mapa-panel-texto');
        this.vista = panel.querySelector('.mapa-panel-vista');
        this.extra = panel.querySelector('.mapa-extra');
        this.edicion = panel.querySelector('.mapa-panel-edicion');
        this.textarea = panel.querySelector('textarea');

        panel.querySelector('.mapa-cerrar').addEventListener('click', () => this.cerrar());
        panel.querySelector('.mapa-editar').addEventListener('click', () => this.editar(true));
        panel.querySelector('.mapa-cancelar').addEventListener('click', () => this.editar(false));
        this.edicion.addEventListener('submit', (e) => {
            e.preventDefault();
            this.guardar();
        });
        panel.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (!this.edicion.hidden) this.editar(false);
            else this.cerrar();
        });
    }

    textoDe(sitio) {
        const guardado = this.db.obtener('sitios', sitio.id);
        return guardado ? (guardado.texto || '') : sitio.texto;
    }

    pintarTexto() {
        const texto = this.textoDe(this.actual);
        this.panelTexto.textContent = texto || 'Sin información registrada. Pulsa "Editar información" para añadirla.';
        this.panelTexto.classList.toggle('mapa-panel-vacio', !texto);
    }

    abrir(sitio, { volar = false } = {}) {
        this.actual = sitio;
        this.panelTitulo.textContent = sitio.titulo;
        this.editar(false);
        this.pintarEstado();
        this.pintarTexto();
        this.pintarExtra();
        this.panel.hidden = false;
        if (volar) this.dashboard.volarA(new THREE.Vector3(sitio.centro[0], 0, sitio.centro[1]));
        this.panel.querySelector('.mapa-cerrar').focus({ preventScroll: true });
    }

    // Parcelas: estado de maduración en vivo, sacado de la simulación
    pintarEstado() {
        const c = this.actual && this.actual.cultivo;
        this.panelEstado.hidden = !c;
        if (!c) return;
        const texto = c.listoParaCosechar
            ? (c.asignadoATractor ? 'Lista · tractor en camino' : 'Lista para cosechar')
            : `Madurando · ${Math.floor(c.progreso)} %`;
        if (this.panelEstado.textContent !== texto) this.panelEstado.textContent = texto;
    }

    // ----- Lo que va debajo del texto: cotizador u ensayos por variedad -----
    pintarExtra() {
        const sitio = this.actual;
        this.extra.innerHTML = '';
        this.extra.hidden = true;
        this.filtroCliente = '';
        if (sitio.id === 'oficina' && window.cotizador) {
            this.extra.hidden = false;
            window.cotizador.pintar(this.extra, this.textoDe(sitio));
        } else if (sitio.cultivo) {
            this.pintarEnsayos();
        }
    }

    // Mismo nombre de lote que sugiere el formulario de procesos agronómicos
    loteDe(cultivo) {
        return `${cultivo.nombre} (${cultivo.tipo === 'invernadero' ? 'invernadero' : 'campo abierto'})`;
    }

    pintarEnsayos() {
        const lote = this.loteDe(this.actual.cultivo);
        const registros = this.db.datos.agronomia.filter(r => normalizar(r.lote) === normalizar(lote));
        const caja = this.extra;
        caja.innerHTML = '';
        caja.hidden = false;

        const titulo = document.createElement('h4');
        titulo.className = 'mapa-extra-titulo';
        titulo.textContent = 'Ensayos por variedad';
        caja.appendChild(titulo);

        const registrar = document.createElement('button');
        registrar.type = 'button';
        registrar.className = 'btn-secondary';
        registrar.textContent = 'Registrar proceso en esta parcela';
        registrar.addEventListener('click', () => window.crm && window.crm.abrirFormulario('agronomia', { lote }));

        if (!registros.length) {
            const vacio = document.createElement('p');
            vacio.className = 'mapa-extra-vacio';
            vacio.textContent = `Aún no hay procesos en el lote «${lote}».`;
            caja.append(vacio, registrar);
            return;
        }

        // Filtro por cliente: solo los que tienen algo en esta parcela
        const clientes = [...new Set(registros.map(r => r.cliente).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
        if (!clientes.includes(this.filtroCliente)) this.filtroCliente = '';
        if (clientes.length > 1) {
            const grupo = document.createElement('div');
            grupo.className = 'form-group';
            const label = document.createElement('label');
            label.htmlFor = 'mapa-filtro-cliente';
            label.textContent = 'Cliente';
            const select = document.createElement('select');
            select.id = 'mapa-filtro-cliente';
            [['', 'Todos los clientes'], ...clientes.map(c => [c, c])].forEach(([valor, texto]) => {
                const o = document.createElement('option');
                o.value = valor;
                o.textContent = texto;
                select.appendChild(o);
            });
            select.value = this.filtroCliente;
            select.addEventListener('change', () => {
                this.filtroCliente = select.value;
                this.pintarEnsayos();
                document.getElementById('mapa-filtro-cliente').focus();
            });
            grupo.append(label, select);
            caja.appendChild(grupo);
        }

        // Una tarjeta por variedad: clientes, fase más reciente y % de germinación medido
        const visibles = registros.filter(r => !this.filtroCliente || r.cliente === this.filtroCliente);
        const porVariedad = new Map();
        visibles.forEach(r => {
            const v = r.variedad || 'Sin variedad registrada';
            if (!porVariedad.has(v)) porVariedad.set(v, []);
            porVariedad.get(v).push(r);
        });
        const lista = document.createElement('ul');
        lista.className = 'ensayos-lista';
        [...porVariedad].sort((a, b) => a[0].localeCompare(b[0], 'es')).forEach(([variedad, procesos]) => {
            procesos.sort((a, b) => String(a.fechaInicio).localeCompare(String(b.fechaInicio)) ||
                FASES_AGRONOMICAS.indexOf(a.proceso) - FASES_AGRONOMICAS.indexOf(b.proceso));
            const ultimo = procesos[procesos.length - 1];
            // Último conteo de germinación de cada cliente (no se mezclan los de clientes distintos)
            const conteos = new Map();
            procesos.forEach(p => { if (porcentaje(p.germinacion)) conteos.set(p.cliente || '', porcentaje(p.germinacion)); });

            const li = document.createElement('li');
            const nombre = document.createElement('p');
            nombre.className = 'ensayo-variedad';
            nombre.textContent = variedad;
            const fase = document.createElement('p');
            fase.className = 'ensayo-dato';
            fase.textContent = `${ultimo.proceso} · ${formatearFecha(ultimo.fechaInicio)}`;
            const germ = document.createElement('p');
            germ.className = 'ensayo-dato';
            germ.textContent = !conteos.size ? 'Germinación: sin conteo'
                : conteos.size === 1 ? `Germinación: ${[...conteos.values()][0]}`
                : `Germinación: ${[...conteos].map(([cliente, pct]) => `${pct} (${cliente})`).join(' · ')}`;
            li.append(nombre, fase, germ);
            if (!this.filtroCliente) {
                const quienes = [...new Set(procesos.map(p => p.cliente).filter(Boolean))];
                const cli = document.createElement('p');
                cli.className = 'ensayo-dato';
                cli.textContent = quienes.join(', ');
                li.appendChild(cli);
            }
            lista.appendChild(li);
        });
        caja.append(lista, registrar);
    }

    editar(activo) {
        this.vista.hidden = activo;
        this.extra.hidden = activo || !this.extra.childElementCount;
        this.edicion.hidden = !activo;
        if (activo) {
            this.textarea.value = this.textoDe(this.actual);
            this.textarea.focus();
        }
    }

    guardar() {
        const texto = this.textarea.value.trim();
        const guardado = this.db.guardar('sitios', {
            id: this.actual.id,
            titulo: this.actual.titulo,
            texto,
            editado: new Date().toISOString(),
            editadoPor: window.responsable ? window.responsable.nombre : ''
        });
        if (!guardado) window.alert('El navegador no permite guardar datos en este momento: el cambio se perderá al cerrar la página.');
        this.abrir(this.actual);
    }

    cerrar() {
        this.panel.hidden = true;
        this.actual = null;
        this.lienzo.focus({ preventScroll: true });
    }

    // ----- Etiqueta que sigue al puntero sobre un lugar -----
    crearEtiqueta() {
        this.etiqueta = document.createElement('div');
        this.etiqueta.className = 'mapa-etiqueta';
        this.etiqueta.setAttribute('aria-hidden', 'true');
        this.etiqueta.hidden = true;
        this.contenedor.appendChild(this.etiqueta);
        this.lienzo.tabIndex = -1; // Para devolverle el foco al cerrar el panel
    }

    // ----- Lista de lugares (acceso sin ratón y en pantallas táctiles) -----
    crearMenuLugares() {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'btn-lugares';
        boton.textContent = 'Lugares';
        boton.setAttribute('aria-expanded', 'false');
        boton.setAttribute('aria-controls', 'menu-lugares');
        const menu = document.createElement('ul');
        menu.id = 'menu-lugares';
        menu.className = 'menu-lugares';
        menu.hidden = true;
        this.sitios.forEach(sitio => {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = sitio.titulo;
            b.addEventListener('click', () => {
                cerrarMenu();
                this.abrir(sitio, { volar: true });
            });
            li.appendChild(b);
            menu.appendChild(li);
        });
        const cerrarMenu = () => {
            menu.hidden = true;
            boton.setAttribute('aria-expanded', 'false');
        };
        boton.addEventListener('click', () => {
            const abrir = menu.hidden;
            menu.hidden = !abrir;
            boton.setAttribute('aria-expanded', String(abrir));
            if (abrir) menu.querySelector('button').focus();
        });
        menu.addEventListener('keydown', (e) => {
            const items = [...menu.querySelectorAll('button')];
            const i = items.indexOf(document.activeElement);
            if (e.key === 'Escape') { cerrarMenu(); boton.focus(); }
            if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        });
        document.addEventListener('click', (e) => {
            if (!menu.hidden && !menu.contains(e.target) && e.target !== boton) cerrarMenu();
        });
        this.contenedor.append(boton, menu);
    }

    // ----- Clics y paso del puntero sobre el mapa -----
    sitioBajo(evento) {
        const r = this.lienzo.getBoundingClientRect();
        this.puntero.x = ((evento.clientX - r.left) / r.width) * 2 - 1;
        this.puntero.y = -((evento.clientY - r.top) / r.height) * 2 + 1;
        this.raycaster.setFromCamera(this.puntero, this.dashboard.camera);
        const impacto = this.raycaster.intersectObjects(this.zonas, false)[0];
        return impacto ? impacto.object.userData.sitio : null;
    }

    escucharPuntero() {
        // Un arrastre gira la cámara: solo cuenta como clic si el puntero casi no se movió
        let inicio = null;
        this.lienzo.addEventListener('pointerdown', (e) => { inicio = { x: e.clientX, y: e.clientY }; });
        this.lienzo.addEventListener('pointerup', (e) => {
            if (!inicio || e.button !== 0) return;
            const movido = Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y);
            inicio = null;
            if (movido > 6) return;
            const sitio = this.sitioBajo(e);
            if (sitio) this.abrir(sitio);
        });

        let ultimo = 0;
        this.lienzo.addEventListener('pointermove', (e) => {
            if (e.pointerType !== 'mouse' || e.buttons) return;
            const ahora = performance.now();
            if (ahora - ultimo < 80) return; // Sin raycast en cada movimiento: basta ~12 veces por segundo
            ultimo = ahora;
            const sitio = this.sitioBajo(e);
            this.lienzo.style.cursor = sitio ? 'pointer' : '';
            this.etiqueta.hidden = !sitio;
            if (sitio) {
                const r = this.contenedor.getBoundingClientRect();
                this.etiqueta.textContent = sitio.titulo;
                this.etiqueta.style.left = `${e.clientX - r.left + 14}px`;
                this.etiqueta.style.top = `${e.clientY - r.top + 14}px`;
            }
        });
        this.lienzo.addEventListener('pointerleave', () => { this.etiqueta.hidden = true; });
    }

    // Lo llama el bucle del simulador para refrescar el estado de una parcela abierta
    actualizar() {
        if (!this.panel.hidden) this.pintarEstado();
    }
}

window.addEventListener('load', () => {
    if (window.appDashboard) window.appDashboard.mapa = new MapaInteractivo(window.appDashboard);
});
