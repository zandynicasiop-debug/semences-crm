/**
 * Reporte semanal de actividades (solo con el backend, CONFIG_GOOGLE.api).
 *
 * - Cada persona (menos los Master) repasa sus tareas de la semana: a cada una le pone su estado
 *   (en progreso, retrasada, completada o terminada sin éxito) y un comentario de cómo va. Puede añadir
 *   actividades nuevas. Lo que sigue en progreso o retrasado vuelve a salir la semana siguiente.
 * - Desde el lunes, quien no entregó el de la semana pasada solo ve esta pantalla hasta entregarlo
 *   (el servidor responde 423 'reporte' a todo lo demás). El viernes se le recuerda.
 * - Reportes del equipo (Master y administrativos): quién lo entregó y quién no, con cada reporte.
 * El servidor comprueba todo: esto solo lo enseña.
 */
const NOMBRE_CARGO_REPORTE = { vendedor: 'Vendedor', tecnico: 'Técnico', plantulador: 'Plantulador', administrativo: 'Administrativo', master: 'Master' };

class ReporteSemanal {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        if (!this.google.conBackend) return;
        window.addEventListener('sdc-ambito', () => this.alCambiarAmbito());
        window.addEventListener('load', () => setTimeout(() => { this.crearOpciones(); this.alCambiarAmbito(); }));
        // Cualquier acción rechazada por falta del reporte (googleSync.js) abre la pantalla bloqueada
        window.addEventListener('sdc-reporte', () => this.abrir());
        // Al volver a la app (p. ej. el lunes por la mañana) se comprueba de nuevo
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.comprobar(); });
    }

    get ambito() {
        const a = window.responsable && window.responsable.ambito;
        return a && a.estado === 'aprobado' ? a : null;
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    crearOpciones() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || this.opcion) return;
        const opcion = (texto, alPulsar) => {
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'menu-extra';
            boton.textContent = texto;
            boton.hidden = true;
            boton.addEventListener('click', () => {
                lista.hidden = true;
                document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
                alPulsar();
            });
            const referencia = document.getElementById('menu-tema');
            if (referencia) referencia.before(boton);
            else lista.appendChild(boton);
            return boton;
        };
        this.opcion = opcion('Reporte semanal', () => this.abrir());
        this.opcionEquipo = opcion('Reportes del equipo', () => this.abrirEquipo());
    }

    alCambiarAmbito() {
        const a = this.ambito;
        if (this.opcionEquipo) this.opcionEquipo.hidden = !(a && (a.master || a.cargo === 'administrativo'));
        if (this.opcion) this.opcion.hidden = true;
        if (a) this.comprobar();
    }

    // ¿Le toca? ¿Está bloqueado? Pinta la opción del menú y, si está bloqueado, abre el reporte
    async comprobar() {
        if (!this.ambito) return;
        const r = await this.google.enviar('reporteSemanal', { operacion: 'estado' }, true);
        if (!r || !r.ok) return;
        this.estado = r;
        if (this.opcion) {
            this.opcion.hidden = !r.obligado;
            this.opcion.textContent = r.entregado ? 'Reporte semanal · entregado' : 'Reporte semanal · pendiente';
        }
        if (r.bloqueado && !(this.dialogo && this.dialogo.open)) this.abrir(r);
    }

    numeroSemana(semana) {
        return Number(String(semana).slice(6));
    }

    textoDias(dias) {
        const f = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
        return `del ${f(dias.lunes)} al ${f(dias.domingo)}`;
    }

    // ----- Mi reporte -----
    crearDialogo() {
        const d = document.createElement('dialog');
        d.className = 'dialogo dialogo-tablero dialogo-reporte';
        d.setAttribute('aria-labelledby', 'reporte-titulo');
        d.innerHTML = `
            <form class="dialogo-form" novalidate>
                <div class="tablero-cabecera">
                    <div>
                        <h3 id="reporte-titulo">Reporte semanal</h3>
                        <p class="panel-alcance reporte-semana"></p>
                    </div>
                    <button type="button" class="btn-texto reporte-cerrar">Cerrar</button>
                </div>
                <p class="reporte-bloqueo" role="alert" hidden></p>
                <p class="dialogo-nota">Pon a cada actividad su estado y cuenta en una frase cómo va. Lo que quede en progreso o retrasado vuelve a salir la semana que viene.</p>
                <ul class="reporte-actividades" aria-label="Actividades de la semana"></ul>
                <button type="button" class="btn-secondary reporte-anadir">Añadir otra actividad</button>
                <div class="form-group">
                    <label for="reporte-resumen">Resumen de la semana (opcional)</label>
                    <textarea id="reporte-resumen" rows="2" maxlength="2000" placeholder="Lo más importante, lo que te frenó, lo que necesitas"></textarea>
                </div>
                <p class="form-error reporte-error" role="alert" hidden></p>
                <div class="modal-actions">
                    <button type="submit" class="btn-primary">Entregar reporte</button>
                </div>
            </form>`;
        document.body.appendChild(d);
        this.dialogo = d;
        this.lista = d.querySelector('.reporte-actividades');
        d.querySelector('.reporte-cerrar').addEventListener('click', () => d.close());
        // Bloqueado: no se puede cerrar con Escape (y si el navegador lo cierra igual, vuelve a abrirse)
        d.addEventListener('cancel', (e) => { if (this.bloqueado) e.preventDefault(); });
        d.addEventListener('close', () => { if (this.bloqueado) setTimeout(() => { if (!d.open) d.showModal(); }); });
        d.querySelector('.reporte-anadir').addEventListener('click', () => {
            const li = this.filaActividad({ nueva: true });
            this.lista.appendChild(li);
            li.querySelector('input').focus();
        });
        d.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.entregar(); });
    }

    async abrir(estado) {
        if (!this.dialogo) this.crearDialogo();
        // Ya abierto (p. ej. otra acción en segundo plano rechazada por el bloqueo): no se repinta, que se
        // perdería lo que la persona está escribiendo
        if (this.dialogo.open) return;
        const r = estado || await this.google.enviar('reporteSemanal', { operacion: 'estado' }, true);
        if (!r || !r.ok) {
            this.aviso((r && r.error) || 'No se pudo abrir el reporte. Revisa la conexión.', 'error');
            return;
        }
        this.estado = r;
        if (!r.obligado) {
            this.aviso('Tu cargo no entrega reporte semanal.');
            return;
        }
        this.bloqueado = r.bloqueado;
        const d = this.dialogo;
        d.querySelector('.reporte-semana').textContent = `Semana ${this.numeroSemana(r.semana)} · ${this.textoDias(r.dias)}${r.entregado ? ' · ya entregado, puedes corregirlo' : ''}`;
        d.querySelector('.reporte-cerrar').hidden = r.bloqueado;
        const bloqueo = d.querySelector('.reporte-bloqueo');
        bloqueo.hidden = !r.bloqueado;
        bloqueo.textContent = r.bloqueado ? '⚠️ Falta tu reporte de la semana pasada. Entrégalo para seguir usando la app; tus cambios sin subir no se pierden.' : '';
        d.querySelector('.reporte-error').hidden = true;
        d.querySelector('#reporte-resumen').value = (r.entregado && r.entregado.resumen) || '';
        // Lo ya entregado esta semana manda sobre lo de la tarea
        const previo = new Map(((r.entregado && r.entregado.actividades) || []).map(a => [a.id, a]));
        this.lista.innerHTML = '';
        r.actividades.forEach(a => this.lista.appendChild(this.filaActividad({ ...a, ...(previo.get(a.id) || {}) })));
        if (!r.actividades.length) this.lista.appendChild(this.filaActividad({ nueva: true }));
        if (!d.open) d.showModal();
    }

    filaActividad(a) {
        const li = document.createElement('li');
        li.className = 'reporte-actividad';
        if (a.id) li.dataset.id = a.id;
        const sufijo = Math.random().toString(36).slice(2, 8);
        const cabecera = document.createElement('div');
        cabecera.className = 'reporte-actividad-cabecera';
        if (a.nueva) {
            const input = document.createElement('input');
            input.type = 'text';
            input.name = 'titulo';
            input.maxLength = 200;
            input.placeholder = 'Qué actividad (p. ej. Demostración en Jarabacoa)';
            input.setAttribute('aria-label', 'Actividad nueva');
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'btn-texto btn-peligro';
            quitar.textContent = 'Quitar';
            quitar.addEventListener('click', () => li.remove());
            cabecera.append(input, quitar);
        } else {
            const titulo = document.createElement('strong');
            titulo.textContent = a.titulo;
            cabecera.appendChild(titulo);
            if (a.vence) {
                const vence = document.createElement('span');
                vence.className = 'panel-subtitulo';
                vence.textContent = `para el ${formatearFecha(a.vence)}`;
                cabecera.appendChild(vence);
            }
        }
        const estado = document.createElement('select');
        estado.name = 'estado';
        estado.id = `reporte-estado-${sufijo}`;
        [['', 'Elige el estado'], ...(this.estado.estados || []).map(e => [e, e])].forEach(([valor, texto]) => {
            const o = document.createElement('option');
            o.value = valor;
            o.textContent = texto;
            if (valor && valor === a.estado && a.comentario) o.selected = true;
            estado.appendChild(o);
        });
        const etiquetaEstado = document.createElement('label');
        etiquetaEstado.htmlFor = estado.id;
        etiquetaEstado.className = 'sr-only';
        etiquetaEstado.textContent = 'Estado';
        const comentario = document.createElement('textarea');
        comentario.name = 'comentario';
        comentario.rows = 2;
        comentario.maxLength = 1000;
        comentario.placeholder = 'Cómo va (mínimo una frase)';
        comentario.setAttribute('aria-label', `Comentario de ${a.titulo || 'la actividad'}`);
        comentario.value = a.comentario || '';
        li.append(cabecera, etiquetaEstado, estado, comentario);
        return li;
    }

    async entregar() {
        const d = this.dialogo;
        const error = d.querySelector('.reporte-error');
        const mostrar = (texto, foco) => { error.textContent = texto; error.hidden = false; if (foco) foco.focus(); };
        error.hidden = true;
        const actividades = [];
        for (const li of this.lista.querySelectorAll('.reporte-actividad')) {
            const titulo = li.querySelector('input[name="titulo"]');
            const estado = li.querySelector('select');
            const comentario = li.querySelector('textarea');
            const nombre = titulo ? titulo.value.trim() : li.querySelector('strong').textContent;
            if (titulo && !nombre) return mostrar('Escribe qué actividad es, o quítala.', titulo);
            if (!estado.value) return mostrar(`Elige el estado de «${nombre}».`, estado);
            if (comentario.value.trim().length < 5) return mostrar(`Escribe cómo va «${nombre}».`, comentario);
            actividades.push({ id: li.dataset.id || undefined, titulo: nombre, estado: estado.value, comentario: comentario.value.trim() });
        }
        if (!actividades.length) return mostrar('Añade al menos una actividad de la semana.');
        const boton = d.querySelector('button[type="submit"]');
        boton.disabled = true;
        const r = await this.google.enviar('reporteSemanal', {
            operacion: 'entregar', semana: this.estado.semana, resumen: d.querySelector('#reporte-resumen').value, actividades
        }, true);
        boton.disabled = false;
        if (!r || !r.ok) return mostrar((r && r.error) || 'No se pudo entregar. Revisa la conexión.');
        const estabaBloqueado = this.bloqueado;
        this.bloqueado = false;
        d.close();
        this.aviso(estabaBloqueado ? 'Reporte entregado. Ya puedes seguir usando la app.' : 'Reporte entregado. Gracias.');
        // Las tareas cambiaron (y si estaba bloqueado, suben los cambios que esperaban)
        if (window.baseDatos) window.baseDatos.sincronizar();
        this.comprobar();
    }

    // ----- Reportes del equipo (Master y administrativos) -----
    async abrirEquipo(semana) {
        if (!this.dialogoEquipo) {
            const d = document.createElement('dialog');
            d.className = 'dialogo dialogo-tablero dialogo-reporte';
            d.setAttribute('aria-labelledby', 'reportes-equipo-titulo');
            d.innerHTML = `
                <div class="dialogo-form">
                    <div class="tablero-cabecera">
                        <div>
                            <h3 id="reportes-equipo-titulo">Reportes del equipo</h3>
                            <p class="panel-alcance reportes-semana"></p>
                        </div>
                        <button type="button" class="btn-texto">Cerrar</button>
                    </div>
                    <div class="tablero-botones reportes-semanas"></div>
                    <ul class="reportes-equipo" aria-label="Personas del equipo"></ul>
                </div>`;
            d.querySelector('.tablero-cabecera button').addEventListener('click', () => d.close());
            document.body.appendChild(d);
            this.dialogoEquipo = d;
        }
        const d = this.dialogoEquipo;
        if (!d.open) d.showModal();
        const r = await this.google.enviar('reporteSemanal', { operacion: 'equipo', ...(semana ? { semana } : {}) }, true);
        const ul = d.querySelector('.reportes-equipo');
        ul.innerHTML = '';
        if (!r || !r.ok) {
            const li = document.createElement('li');
            li.className = 'form-error';
            li.textContent = (r && r.error) || 'No se pudo cargar. Revisa la conexión.';
            ul.appendChild(li);
            return;
        }
        const entregados = r.equipo.filter(p => p.reporte).length;
        d.querySelector('.reportes-semana').textContent = `Semana ${this.numeroSemana(r.semana)} · ${this.textoDias(r.dias)} · ${entregados} de ${r.equipo.length} entregados`;
        const botones = d.querySelector('.reportes-semanas');
        botones.innerHTML = '';
        [[r.anterior, 'Semana pasada'], [r.actual, 'Esta semana']].forEach(([s, texto]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = s === r.semana ? 'btn-primary' : 'btn-secondary';
            b.textContent = texto;
            b.setAttribute('aria-pressed', String(s === r.semana));
            b.addEventListener('click', () => this.abrirEquipo(s));
            botones.appendChild(b);
        });
        if (!r.equipo.length) {
            const li = document.createElement('li');
            li.className = 'dialogo-nota';
            li.textContent = 'No hay personas de tu país y casa que entreguen reporte.';
            ul.appendChild(li);
        }
        // Primero quien no lo entregó
        [...r.equipo].sort((x, y) => Number(Boolean(x.reporte)) - Number(Boolean(y.reporte))).forEach(p => {
            const li = document.createElement('li');
            li.className = `acceso${p.reporte ? '' : ' acceso-pendiente'}`;
            const cab = document.createElement('div');
            const nombre = document.createElement('strong');
            nombre.textContent = p.nombre;
            const detalle = document.createElement('span');
            detalle.textContent = ` · ${NOMBRE_CARGO_REPORTE[p.cargo] || p.cargo || ''} · ${p.reporte
                ? `✅ entregado el ${new Date(p.reporte.entregado).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'short' })}`
                : '⚠️ sin entregar'}`;
            cab.append(nombre, detalle);
            li.appendChild(cab);
            if (p.reporte) {
                const det = document.createElement('details');
                const resumen = document.createElement('summary');
                const cuenta = (e) => p.reporte.actividades.filter(a => a.estado === e).length;
                resumen.textContent = `${p.reporte.actividades.length} actividades: ${cuenta('Completada')} completadas, ${cuenta('En progreso')} en progreso, ${cuenta('Retrasada')} retrasadas, ${cuenta('Terminada sin éxito')} sin éxito`;
                det.appendChild(resumen);
                if (p.reporte.resumen) {
                    const texto = document.createElement('p');
                    texto.className = 'reporte-resumen-texto';
                    texto.textContent = p.reporte.resumen;
                    det.appendChild(texto);
                }
                const lista = document.createElement('ul');
                lista.className = 'reporte-detalle';
                p.reporte.actividades.forEach(a => {
                    const item = document.createElement('li');
                    const t = document.createElement('strong');
                    const aviso = ['Retrasada', 'Terminada sin éxito'].includes(a.estado);
                    t.textContent = `${aviso ? '⚠️ ' : ''}${a.titulo} · ${a.estado}`;
                    const c = document.createElement('span');
                    c.textContent = a.comentario;
                    item.append(t, c);
                    lista.appendChild(item);
                });
                det.appendChild(lista);
                li.appendChild(det);
            }
            ul.appendChild(li);
        });
    }
}

window.reporteSemanal = new ReporteSemanal();
