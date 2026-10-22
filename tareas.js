/**
 * Tareas del equipo: qué hay que hacer, con qué prioridad, para cuándo y quién se encarga.
 *
 * Se guardan en la base compartida (pestaña "CRM · tareas" de la hoja), así que todo el equipo ve la
 * misma lista. Una tarea asignada a alguien se anuncia en el espacio de Google Chat.
 * El botón de la barra superior cuenta las tareas pendientes asignadas a quien usa la app.
 */

Object.assign(ICONOS, {
    tareas: ['M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5', 'm9 11 3 3L22 4']
});

const PRIORIDADES = ['Alta', 'Media', 'Baja'];
const MAX_HECHAS_VISIBLES = 15;

class TareasEquipo {
    constructor(dashboard) {
        this.db = window.baseDatos;
        this.google = dashboard.google;
        this.primeraCarga = true;
        this.conocidas = new Set(this.db.datos.tareas.map(t => t.id));

        this.crearBoton();
        this.crearPanel();
        this.pintar();

        this.db.alCambiar((motivo) => {
            if (motivo === 'sincronizado' || motivo === 'local') this.pintar();
        });
        window.responsable.alCambiar(() => this.pintar());
    }

    get yo() {
        return window.responsable ? window.responsable.nombre : '';
    }

    esMia(tarea) {
        return Boolean(this.yo) && normalizar(tarea.para) === normalizar(this.yo);
    }

    pendientes() {
        return this.db.datos.tareas.filter(t => !t.hecha);
    }

    // ----- Botón en la barra superior, junto al chat -----
    crearBoton() {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'btn-tareas';
        boton.className = 'btn-chat';
        boton.setAttribute('aria-expanded', 'false');
        boton.setAttribute('aria-controls', 'panel-tareas');
        boton.innerHTML = `${iconoSVG('tareas')}<span>Tareas</span><b class="chat-contador" hidden></b>`;
        boton.addEventListener('click', () => this.alternarPanel());
        const nav = document.getElementById('app-nav');
        nav.insertBefore(boton, document.getElementById('btn-chat'));
        this.boton = boton;
        this.contador = boton.querySelector('.chat-contador');
    }

    // ----- Panel lateral: formulario arriba, lista debajo -----
    crearPanel() {
        const panel = document.createElement('aside');
        panel.id = 'panel-tareas';
        panel.className = 'panel-chat panel-tareas';
        panel.setAttribute('aria-labelledby', 'panel-tareas-titulo');
        panel.hidden = true;
        panel.innerHTML = `
            <div class="panel-chat-cabecera">
                <div>
                    <h2 id="panel-tareas-titulo">Tareas del equipo</h2>
                    <p class="panel-chat-nota">Las ve todo el equipo. Las asignadas a alguien se avisan en Google Chat.</p>
                </div>
                <button type="button" class="btn-texto panel-tareas-cerrar">Cerrar</button>
            </div>
            <form class="tarea-form" novalidate>
                <div class="form-group">
                    <label for="tarea-titulo">Nueva tarea</label>
                    <input id="tarea-titulo" type="text" autocomplete="off" placeholder="Qué hay que hacer" aria-describedby="tarea-error">
                </div>
                <div class="tarea-fila">
                    <div class="form-group">
                        <label for="tarea-prioridad">Prioridad</label>
                        <select id="tarea-prioridad">${PRIORIDADES.map(p => `<option${p === 'Media' ? ' selected' : ''}>${p}</option>`).join('')}</select>
                    </div>
                    <div class="form-group">
                        <label for="tarea-vence">Para cuándo (opcional)</label>
                        <input id="tarea-vence" type="date">
                    </div>
                </div>
                <div class="form-group">
                    <label for="tarea-para">Quién se encarga (opcional)</label>
                    <input id="tarea-para" type="text" list="lista-personas" autocomplete="off" placeholder="Nombre de la persona">
                    <datalist id="lista-personas"></datalist>
                </div>
                <p class="form-error" id="tarea-error" hidden></p>
                <button type="submit" class="btn-primary">Añadir tarea</button>
            </form>
            <div class="tareas-listas" tabindex="0" aria-label="Lista de tareas">
                <h3 class="tareas-subtitulo" id="tareas-pendientes-titulo"></h3>
                <ul class="tareas-lista" aria-labelledby="tareas-pendientes-titulo"></ul>
                <details class="tareas-hechas">
                    <summary></summary>
                    <ul class="tareas-lista"></ul>
                </details>
            </div>`;
        document.body.appendChild(panel);
        this.panel = panel;
        this.form = panel.querySelector('.tarea-form');
        this.inputTitulo = panel.querySelector('#tarea-titulo');
        this.error = panel.querySelector('#tarea-error');
        this.listaPendientes = panel.querySelector('.tareas-listas > .tareas-lista');
        this.tituloPendientes = panel.querySelector('#tareas-pendientes-titulo');
        this.hechas = panel.querySelector('.tareas-hechas');
        this.listaHechas = this.hechas.querySelector('.tareas-lista');

        panel.querySelector('.panel-tareas-cerrar').addEventListener('click', () => this.alternarPanel(false));
        panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.alternarPanel(false); });
        this.inputTitulo.addEventListener('input', () => { this.error.hidden = true; this.inputTitulo.removeAttribute('aria-invalid'); });
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.crear();
        });
    }

    alternarPanel(abrir = this.panel.hidden) {
        // Un panel lateral a la vez: si el chat está abierto, se cierra
        if (abrir && window.equipo && !window.equipo.panel.hidden) window.equipo.panel.hidden = true;
        this.panel.hidden = !abrir;
        this.boton.setAttribute('aria-expanded', String(abrir));
        if (abrir) this.inputTitulo.focus();
        else this.boton.focus();
    }

    crear() {
        const titulo = this.inputTitulo.value.trim();
        if (!titulo) {
            this.error.textContent = 'Escribe qué hay que hacer.';
            this.error.hidden = false;
            this.inputTitulo.setAttribute('aria-invalid', 'true');
            this.inputTitulo.focus();
            return;
        }
        const tarea = {
            id: nuevoId(),
            titulo,
            prioridad: this.form.querySelector('#tarea-prioridad').value,
            vence: this.form.querySelector('#tarea-vence').value,
            para: this.form.querySelector('#tarea-para').value.trim().replace(/\s+/g, ' '),
            creadaPor: this.yo,
            creada: new Date().toISOString(),
            hecha: '',
            hechaPor: ''
        };
        this.error.hidden = true;
        this.inputTitulo.removeAttribute('aria-invalid');
        this.conocidas.add(tarea.id);
        this.db.guardar('tareas', tarea);
        // Con fecha: también al Google Calendar del equipo (de 8:00 a 9:00 de ese día)
        if (tarea.vence && this.google) {
            this.google.agendarCalendar({
                titulo: `Tarea · ${tarea.titulo}`,
                inicio: fechaLocal(tarea.vence, 8).toISOString(),
                fin: fechaLocal(tarea.vence, 9).toISOString(),
                descripcion: [`Prioridad ${tarea.prioridad.toLowerCase()}`, tarea.para && `Se encarga: ${tarea.para}`, tarea.creadaPor && `Creó: ${tarea.creadaPor}`].filter(Boolean).join('\n')
            });
        }
        if (tarea.para && this.google) {
            const cuando = tarea.vence ? ` · para el ${formatearFecha(tarea.vence)}` : '';
            this.google.enviarGoogleChat(`📋 Tarea para ${tarea.para} (prioridad ${tarea.prioridad.toLowerCase()}${cuando}): ${tarea.titulo}\n— ${tarea.creadaPor || 'Sin nombre'}`);
        }
        this.form.reset();
        this.form.querySelector('#tarea-prioridad').value = 'Media';
        this.inputTitulo.focus();
    }

    alternarHecha(tarea) {
        const hecha = !tarea.hecha;
        this.db.guardar('tareas', {
            ...this.db.limpio(tarea),
            hecha: hecha ? new Date().toISOString() : '',
            hechaPor: hecha ? this.yo : ''
        });
    }

    eliminar(tarea) {
        if (!window.confirm(`¿Eliminar la tarea "${tarea.titulo}"? Se borra para todo el equipo.`)) return;
        this.db.eliminar('tareas', tarea.id);
    }

    // Vencida, para hoy o con fecha: lo que se muestra junto a la tarea
    estadoFecha(tarea) {
        if (!tarea.vence) return null;
        const hoy = hoyISO();
        if (!tarea.hecha && tarea.vence < hoy) return { texto: `vencida el ${formatearFecha(tarea.vence)}`, clase: 'tarea-vencida' };
        if (tarea.vence === hoy) return { texto: 'para hoy', clase: 'tarea-hoy' };
        return { texto: `para el ${formatearFecha(tarea.vence)}`, clase: '' };
    }

    // ----- Pintado -----
    pintar() {
        const tareas = this.db.datos.tareas;
        // Aviso de tareas nuevas asignadas a esta persona por otra (no en la primera carga)
        if (!this.primeraCarga) {
            tareas.filter(t => !this.conocidas.has(t.id) && !t.hecha && this.esMia(t) && normalizar(t.creadaPor) !== normalizar(this.yo))
                .forEach(t => {
                    if (window.equipo) window.equipo.mostrarAviso(`${t.creadaPor || 'Alguien'} te asignó una tarea: ${t.titulo}`);
                    if (this.google) this.google.enviarNotificacionMovil('Tarea nueva para ti', t.titulo);
                });
        }
        tareas.forEach(t => this.conocidas.add(t.id));
        this.primeraCarga = false;

        const orden = (a, b) => {
            const va = a.vence || '9999', vb = b.vence || '9999';
            return va.localeCompare(vb) || PRIORIDADES.indexOf(a.prioridad) - PRIORIDADES.indexOf(b.prioridad);
        };
        const pendientes = this.pendientes().sort(orden);
        const hechas = tareas.filter(t => t.hecha).sort((a, b) => String(b.hecha).localeCompare(String(a.hecha))).slice(0, MAX_HECHAS_VISIBLES);

        this.tituloPendientes.textContent = `Pendientes (${pendientes.length})`;
        this.listaPendientes.innerHTML = '';
        if (!pendientes.length) {
            const vacio = document.createElement('li');
            vacio.className = 'tareas-vacio';
            vacio.textContent = 'No hay tareas pendientes.';
            this.listaPendientes.appendChild(vacio);
        }
        pendientes.forEach(t => this.listaPendientes.appendChild(this.elemento(t)));

        const totalHechas = tareas.length - pendientes.length;
        this.hechas.hidden = totalHechas === 0;
        this.hechas.querySelector('summary').textContent = `Hechas (${totalHechas})`;
        this.listaHechas.innerHTML = '';
        hechas.forEach(t => this.listaHechas.appendChild(this.elemento(t)));

        // Personas conocidas para el campo "Quién se encarga"
        const personas = new Set([
            ...tareas.flatMap(t => [t.para, t.creadaPor]),
            ...this.db.datos.mensajes.map(m => m.autor),
            this.yo
        ].filter(Boolean));
        const lista = this.panel.querySelector('#lista-personas');
        lista.innerHTML = '';
        [...personas].sort((a, b) => a.localeCompare(b, 'es')).forEach(p => {
            const o = document.createElement('option');
            o.value = p;
            lista.appendChild(o);
        });

        this.pintarContador();
    }

    elemento(tarea) {
        const li = document.createElement('li');
        li.className = `tarea${tarea.hecha ? ' tarea-hecha' : ''}${tarea.prioridad === 'Alta' && !tarea.hecha ? ' tarea-alta' : ''}`;

        const marcar = document.createElement('input');
        marcar.type = 'checkbox';
        marcar.checked = Boolean(tarea.hecha);
        marcar.id = `tarea-${tarea.id}`;
        marcar.addEventListener('change', () => this.alternarHecha(tarea));

        const cuerpo = document.createElement('div');
        cuerpo.className = 'tarea-cuerpo';
        const titulo = document.createElement('label');
        titulo.htmlFor = marcar.id;
        titulo.className = 'tarea-titulo';
        titulo.textContent = tarea.titulo;

        const datos = document.createElement('p');
        datos.className = 'tarea-datos';
        const prioridad = document.createElement('span');
        prioridad.className = `tarea-prioridad prioridad-${normalizar(tarea.prioridad)}`;
        prioridad.textContent = tarea.prioridad;
        datos.appendChild(prioridad);
        const fecha = this.estadoFecha(tarea);
        if (fecha) {
            const f = document.createElement('span');
            if (fecha.clase) f.className = fecha.clase;
            f.textContent = fecha.texto;
            datos.appendChild(f);
        }
        const quien = tarea.hecha
            ? `hecha${tarea.hechaPor ? ` por ${tarea.hechaPor}` : ''}`
            : [tarea.para && `${this.esMia(tarea) ? 'para ti' : `para ${tarea.para}`}`, tarea.creadaPor && `creó ${tarea.creadaPor}`].filter(Boolean).join(' · ');
        if (quien) {
            const q = document.createElement('span');
            q.textContent = quien;
            datos.appendChild(q);
        }
        cuerpo.append(titulo, datos);

        const borrar = document.createElement('button');
        borrar.type = 'button';
        borrar.className = 'btn-texto tarea-eliminar';
        borrar.textContent = 'Eliminar';
        borrar.setAttribute('aria-label', `Eliminar la tarea ${tarea.titulo}`);
        borrar.addEventListener('click', () => this.eliminar(tarea));

        li.append(marcar, cuerpo, borrar);
        return li;
    }

    pintarContador() {
        const mias = this.pendientes().filter(t => this.esMia(t)).length;
        this.contador.hidden = mias === 0;
        this.contador.textContent = mias > 9 ? '9+' : String(mias);
        this.boton.setAttribute('aria-label', mias ? `Tareas del equipo, ${mias} pendientes para ti` : 'Tareas del equipo');
    }
}

window.addEventListener('load', () => {
    if (window.appDashboard) window.tareas = new TareasEquipo(window.appDashboard);
});
