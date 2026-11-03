/**
 * Reuniones del equipo y metas mensuales (solo con el backend y cuenta aprobada).
 *
 * Reuniones: próximas y anteriores; "Nueva reunión" crea el evento con Meet en el Google Calendar de
 * quien la organiza e invita a las personas elegidas (les llega el aviso). Después, el acta: temas y
 * acuerdos; cada acuerdo con responsable pasa a Tareas a su nombre.
 * Metas: cada persona ve las suyas del mes con su avance (lo calcula el servidor con los pedidos,
 * clientes, visitas, ensayos y reportes). Master y administración ven las de su equipo y las fijan.
 */
const NOMBRE_INDICADOR = {
    ventas: 'Ventas (miles de semillas)',
    clientes: 'Clientes nuevos',
    visitas: 'Visitas a clientes',
    ensayos: 'Ensayos de validación por variedad',
    actividades: 'Actividades cumplidas (%)'
};

class ReunionesMetas {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        if (!this.google.conBackend) return;
        window.addEventListener('load', () => setTimeout(() => {
            this.reuniones = crearPanelLateral('panel-reuniones', 'Reuniones');
            this.metas = crearPanelLateral('panel-metas', 'Metas');
            this.metas.panel.classList.add('panel-ancho');
            window.accesos.registrar({ id: 'reuniones', titulo: 'Reuniones', icono: 'video', controla: 'panel-reuniones', backend: true, alPulsar: () => this.alternar(this.reuniones, () => this.pintarReuniones()) });
            window.accesos.registrar({ id: 'metas', titulo: 'Metas', icono: 'metas', controla: 'panel-metas', backend: true, alPulsar: () => this.alternar(this.metas, () => this.pintarMetas()) });
            if (window.baseDatos) window.baseDatos.alCambiar(() => { if (this.reuniones.abierto && this.vista === 'lista') this.pintarReuniones(); });
        }));
    }

    get disponible() {
        const a = window.responsable && window.responsable.ambito;
        return Boolean(this.google.conBackend && a && a.estado === 'aprobado');
    }

    get yoEmail() {
        const s = window.responsable && window.responsable.sesion;
        return String((s && s.email) || '').toLowerCase();
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    alternar(panel, pintar) {
        if (panel.abierto) return panel.cerrar();
        panel.abrir();
        pintar();
    }

    abrirReuniones(id = null, { nueva = false } = {}) {
        if (!this.reuniones) return;
        this.reuniones.abrir();
        if (nueva) this.formNueva();
        else this.pintarReuniones(id);
    }

    abrirMetas() {
        if (!this.metas) return;
        this.metas.abrir();
        this.pintarMetas();
    }

    equipo() {
        return ((window.tableroEquipo && window.tableroEquipo.equipo) || []).filter(p => !p.yo);
    }

    errorEn(contenedor, texto) {
        let p = contenedor.querySelector(':scope > .form-error');
        if (!p) {
            p = document.createElement('p');
            p.className = 'form-error';
            p.setAttribute('role', 'alert');
            contenedor.appendChild(p);
        }
        p.textContent = texto;
        p.hidden = false;
    }

    // ----- Reuniones -----
    pintarReuniones(resaltar = null) {
        this.vista = 'lista';
        const panel = this.reuniones;
        panel.titulo.textContent = 'Reuniones';
        panel.nota.textContent = 'Con Meet, invitación a cada participante y acta con acuerdos';
        const cuerpo = panel.cuerpo;
        cuerpo.innerHTML = '';
        const nueva = document.createElement('button');
        nueva.type = 'button';
        nueva.className = 'btn-primary';
        nueva.textContent = 'Nueva reunión';
        nueva.addEventListener('click', () => this.formNueva());
        cuerpo.appendChild(nueva);

        const todas = [...((window.baseDatos && window.baseDatos.datos.reuniones) || [])].sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
        const ahora = Date.now() - 2 * 3600000; // Hasta dos horas después de empezar sigue entre las próximas
        const proximas = todas.filter(r => new Date(r.inicio).getTime() >= ahora);
        const pasadas = todas.filter(r => new Date(r.inicio).getTime() < ahora).reverse().slice(0, 15);
        const seccion = (titulo, lista, vacio) => {
            const h = document.createElement('h3');
            h.className = 'subtitulo-acceso';
            h.textContent = titulo;
            cuerpo.appendChild(h);
            if (!lista.length) {
                const p = document.createElement('p');
                p.className = 'dialogo-nota';
                p.textContent = vacio;
                cuerpo.appendChild(p);
                return;
            }
            const ul = document.createElement('ul');
            ul.className = 'lista-acceso';
            lista.forEach(r => ul.appendChild(this.filaReunion(r, r.id === resaltar)));
            cuerpo.appendChild(ul);
        };
        seccion('Próximas', proximas, 'No hay reuniones programadas.');
        seccion('Anteriores', pasadas, 'Todavía no hubo reuniones.');
        if (resaltar) {
            const fila = cuerpo.querySelector('.fila-resaltada');
            if (fila) fila.scrollIntoView({ block: 'center' });
        }
    }

    filaReunion(r, resaltada) {
        const li = document.createElement('li');
        li.className = `tarjeta-reunion${resaltada ? ' fila-resaltada' : ''}`;
        const f = new Date(r.inicio);
        const h = document.createElement('strong');
        h.textContent = r.titulo;
        const cuando = document.createElement('span');
        cuando.className = 'fila-cuando';
        cuando.textContent = `${f.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'short' })} (${f.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })}) · organiza ${r.organizadorNombre || r.organizador}`;
        const quienes = document.createElement('span');
        quienes.className = 'fila-texto';
        quienes.textContent = `Con ${r.participantesTexto || '—'}`;
        li.append(h, cuando, quienes);
        if (r.acta) {
            const acta = document.createElement('p');
            acta.className = 'reunion-acta-resumen';
            acta.textContent = `Acta: ${r.temas || ''}${r.acuerdosTexto ? ` — Acuerdos: ${r.acuerdosTexto}` : ''}`;
            li.appendChild(acta);
        }
        const acciones = document.createElement('div');
        acciones.className = 'tablero-botones';
        if (r.meet) {
            const a = document.createElement('a');
            a.className = 'btn-secondary';
            a.href = r.meet;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'Entrar a Meet';
            acciones.appendChild(a);
        }
        const participa = r.organizador === this.yoEmail || (r.participantes || []).some(p => p.email === this.yoEmail)
            || Boolean(window.responsable && window.responsable.ambito && window.responsable.ambito.master);
        if (participa) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-texto';
            b.textContent = r.acta ? 'Corregir el acta' : 'Escribir el acta';
            b.addEventListener('click', () => this.formActa(r));
            acciones.appendChild(b);
        }
        li.appendChild(acciones);
        return li;
    }

    formNueva() {
        this.vista = 'nueva';
        const panel = this.reuniones;
        panel.titulo.textContent = 'Nueva reunión';
        panel.nota.textContent = 'Se crea en tu Google Calendar con Meet y se invita a cada persona';
        const cuerpo = panel.cuerpo;
        cuerpo.innerHTML = '';
        const manana = new Date(Date.now() + 86400000);
        const fecha = `${manana.getFullYear()}-${String(manana.getMonth() + 1).padStart(2, '0')}-${String(manana.getDate()).padStart(2, '0')}`;
        const form = document.createElement('form');
        form.className = 'form-acceso';
        form.noValidate = true;
        form.innerHTML = `
            <div class="form-group"><label for="re-titulo">Motivo</label><input id="re-titulo" type="text" maxlength="200" placeholder="Plan de siembra de diciembre" required></div>
            <div class="form-fila">
                <div class="form-group"><label for="re-fecha">Fecha</label><input id="re-fecha" type="date" value="${fecha}" required></div>
                <div class="form-group"><label for="re-hora">Hora</label><input id="re-hora" type="time" value="09:00" required></div>
                <div class="form-group"><label for="re-duracion">Duración</label><select id="re-duracion"><option value="30">30 min</option><option value="60" selected>1 hora</option><option value="90">1 h 30</option><option value="120">2 horas</option></select></div>
            </div>
            <fieldset class="acceso-grupo"><legend>Participantes</legend><div class="re-participantes"></div></fieldset>
            <div class="form-group"><label for="re-descripcion">Temas a tratar (opcional)</label><textarea id="re-descripcion" rows="3" maxlength="2000"></textarea></div>
            <div class="modal-actions">
                <button type="button" class="btn-texto re-cancelar">Cancelar</button>
                <button type="submit" class="btn-primary">Crear e invitar</button>
            </div>`;
        const lista = form.querySelector('.re-participantes');
        const equipo = this.equipo();
        if (!equipo.length) lista.innerHTML = '<p class="dialogo-nota">Cargando el equipo… abre otra vez en unos segundos.</p>';
        equipo.forEach(p => {
            const label = document.createElement('label');
            label.className = 'casilla';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = p.email;
            const span = document.createElement('span');
            span.textContent = p.nombre || p.email;
            label.append(input, span);
            lista.appendChild(label);
        });
        form.querySelector('.re-cancelar').addEventListener('click', () => this.pintarReuniones());
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const titulo = form.querySelector('#re-titulo').value.trim();
            const participantes = [...lista.querySelectorAll('input:checked')].map(i => i.value);
            const inicio = new Date(`${form.querySelector('#re-fecha').value}T${form.querySelector('#re-hora').value || '09:00'}`);
            if (!titulo) return this.errorEn(form, 'Escribe el motivo de la reunión.');
            if (Number.isNaN(inicio.getTime())) return this.errorEn(form, 'Revisa la fecha y la hora.');
            if (!participantes.length) return this.errorEn(form, 'Elige al menos una persona.');
            const fin = new Date(inicio.getTime() + Number(form.querySelector('#re-duracion').value) * 60000);
            const boton = form.querySelector('button[type="submit"]');
            boton.disabled = true;
            boton.textContent = 'Creando…';
            const r = await this.google.enviar('reunion', {
                operacion: 'crear', titulo, participantes, inicio: inicio.toISOString(), fin: fin.toISOString(),
                descripcion: form.querySelector('#re-descripcion').value
            }, true);
            boton.disabled = false;
            boton.textContent = 'Crear e invitar';
            if (!r || !r.ok) return this.errorEn(form, (r && r.error) || 'No se pudo crear. Revisa la conexión.');
            this.aviso(`Reunión creada con Meet; se invitó a ${participantes.length} persona${participantes.length === 1 ? '' : 's'}.`);
            if (window.baseDatos) await window.baseDatos.sincronizar();
            this.pintarReuniones(r.reunion.id);
        });
        cuerpo.appendChild(form);
        form.querySelector('#re-titulo').focus();
    }

    formActa(r) {
        this.vista = 'acta';
        const panel = this.reuniones;
        panel.titulo.textContent = 'Acta de la reunión';
        panel.nota.textContent = r.titulo;
        const cuerpo = panel.cuerpo;
        cuerpo.innerHTML = '';
        const personas = [{ email: r.organizador, nombre: r.organizadorNombre }, ...(r.participantes || [])];
        const form = document.createElement('form');
        form.className = 'form-acceso';
        form.noValidate = true;
        form.innerHTML = `
            <div class="form-group"><label for="acta-temas">Temas tratados</label><textarea id="acta-temas" rows="4" maxlength="4000"></textarea></div>
            <h3 class="subtitulo-acceso">Acuerdos</h3>
            <p class="dialogo-nota">Cada acuerdo con responsable pasa a Tareas a su nombre (con la fecha, si la pones) y se le avisa.</p>
            <ul class="acta-acuerdos"></ul>
            <button type="button" class="btn-secondary acta-anadir">Añadir acuerdo</button>
            <div class="modal-actions">
                <button type="button" class="btn-texto acta-cancelar">Cancelar</button>
                <button type="submit" class="btn-primary">Guardar el acta</button>
            </div>`;
        form.querySelector('#acta-temas').value = r.temas || '';
        const lista = form.querySelector('.acta-acuerdos');
        const fila = (a = {}) => {
            const li = document.createElement('li');
            li.className = 'acta-acuerdo';
            const sufijo = Math.random().toString(36).slice(2, 7);
            li.innerHTML = `
                <label class="solo-lector" for="ac-texto-${sufijo}">Acuerdo</label>
                <input id="ac-texto-${sufijo}" type="text" maxlength="300" placeholder="Qué se acordó" class="acuerdo-texto">
                <label class="solo-lector" for="ac-resp-${sufijo}">Responsable</label>
                <select id="ac-resp-${sufijo}" class="acuerdo-responsable"><option value="">Sin responsable</option></select>
                <label class="solo-lector" for="ac-vence-${sufijo}">Para cuándo</label>
                <input id="ac-vence-${sufijo}" type="date" class="acuerdo-vence">
                <button type="button" class="btn-texto btn-peligro" aria-label="Quitar este acuerdo">Quitar</button>`;
            const select = li.querySelector('select');
            personas.forEach(p => {
                const o = document.createElement('option');
                o.value = p.email;
                o.textContent = p.nombre || p.email;
                select.appendChild(o);
            });
            li.querySelector('.acuerdo-texto').value = a.texto || '';
            select.value = a.responsable || '';
            li.querySelector('.acuerdo-vence').value = a.vence || '';
            li.querySelector('button').addEventListener('click', () => li.remove());
            lista.appendChild(li);
        };
        (r.acuerdos && r.acuerdos.length ? r.acuerdos : [{}]).forEach(fila);
        form.querySelector('.acta-anadir').addEventListener('click', () => fila());
        form.querySelector('.acta-cancelar').addEventListener('click', () => this.pintarReuniones(r.id));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const acuerdos = [...lista.querySelectorAll('.acta-acuerdo')].map(li => ({
                texto: li.querySelector('.acuerdo-texto').value.trim(),
                responsable: li.querySelector('.acuerdo-responsable').value,
                vence: li.querySelector('.acuerdo-vence').value
            })).filter(a => a.texto);
            const temas = form.querySelector('#acta-temas').value.trim();
            if (!temas && !acuerdos.length) return this.errorEn(form, 'Escribe los temas tratados o al menos un acuerdo.');
            const boton = form.querySelector('button[type="submit"]');
            boton.disabled = true;
            const res = await this.google.enviar('reunion', { operacion: 'acta', id: r.id, temas, acuerdos }, true);
            boton.disabled = false;
            if (!res || !res.ok) return this.errorEn(form, (res && res.error) || 'No se pudo guardar. Revisa la conexión.');
            const conTarea = res.reunion.acuerdos.filter(a => a.tareaId).length;
            this.aviso(`Acta guardada${conTarea ? `; ${conTarea} acuerdo${conTarea === 1 ? '' : 's'} pasaron a Tareas` : ''}.`);
            if (window.baseDatos) await window.baseDatos.sincronizar();
            this.pintarReuniones(r.id);
        });
        cuerpo.appendChild(form);
    }

    // ----- Metas -----
    async pintarMetas(mes = this.mesMetas) {
        const panel = this.metas;
        panel.titulo.textContent = 'Metas';
        const hoy = new Date();
        this.mesMetas = mes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
        panel.nota.textContent = 'Cargando…';
        const r = await this.google.enviar('metas', { mes: this.mesMetas }, true);
        const cuerpo = panel.cuerpo;
        cuerpo.innerHTML = '';
        const barra = document.createElement('div');
        barra.className = 'agenda-barra';
        barra.innerHTML = '<label for="metas-mes" class="solo-lector">Mes</label><input id="metas-mes" type="month">';
        const mesInput = barra.querySelector('input');
        mesInput.value = this.mesMetas;
        mesInput.addEventListener('change', () => { if (mesInput.value) this.pintarMetas(mesInput.value); });
        cuerpo.appendChild(barra);
        if (!r || !r.ok) {
            panel.nota.textContent = '';
            return this.errorEn(cuerpo, (r && r.error) || 'No se pudieron cargar las metas.');
        }
        panel.nota.textContent = r.puedoFijar ? 'Las de tu equipo: fíjalas y sigue su avance' : 'Tus metas del mes y cómo vas';
        // Primero la persona misma; después el equipo
        const personas = [...r.personas].sort((a, b) => Number(b.yo) - Number(a.yo) || a.nombre.localeCompare(b.nombre));
        personas.forEach(p => cuerpo.appendChild(this.tarjetaMetas(p, r)));
    }

    tarjetaMetas(p, r) {
        const art = document.createElement('section');
        art.className = 'tarjeta-metas';
        const h = document.createElement('h3');
        h.textContent = p.yo ? `${p.nombre} (tú)` : p.nombre;
        const cargo = document.createElement('span');
        cargo.className = 'nota-suave';
        const nombres = typeof NOMBRE_CARGO_REPORTE !== 'undefined' ? NOMBRE_CARGO_REPORTE : {};
        cargo.textContent = ` · ${nombres[p.cargo] || p.cargo || ''}`;
        h.appendChild(cargo);
        art.appendChild(h);
        if (!p.metas.length) {
            const nada = document.createElement('p');
            nada.className = 'dialogo-nota';
            nada.textContent = p.yo && !p.puedoFijar ? 'Todavía no tienes metas este mes.' : 'Sin metas este mes.';
            art.appendChild(nada);
        }
        p.metas.forEach(m => {
            const fila = document.createElement('div');
            fila.className = `meta-fila${m.porcentaje >= 100 ? ' meta-cumplida' : ''}`;
            const nombre = document.createElement('span');
            nombre.className = 'meta-nombre';
            nombre.textContent = m.nombre;
            const cifra = document.createElement('span');
            cifra.className = 'meta-cifra';
            cifra.textContent = `${m.porcentaje >= 100 ? '✅ ' : ''}${Number(m.avance).toLocaleString('es-DO')} de ${Number(m.objetivo).toLocaleString('es-DO')}${m.indicador === 'actividades' ? ' %' : ''}`;
            const barra = document.createElement('div');
            barra.className = 'meta-barra';
            barra.setAttribute('role', 'progressbar');
            barra.setAttribute('aria-valuemin', '0');
            barra.setAttribute('aria-valuemax', '100');
            barra.setAttribute('aria-valuenow', String(m.porcentaje));
            barra.setAttribute('aria-label', `${m.nombre}: ${m.porcentaje} %`);
            const relleno = document.createElement('span');
            relleno.style.width = `${m.porcentaje}%`;
            barra.appendChild(relleno);
            fila.append(nombre, cifra, barra);
            if (p.puedoFijar) {
                const quitar = document.createElement('button');
                quitar.type = 'button';
                quitar.className = 'btn-texto btn-peligro';
                quitar.textContent = 'Quitar';
                quitar.setAttribute('aria-label', `Quitar la meta ${m.nombre} de ${p.nombre}`);
                quitar.addEventListener('click', async () => {
                    const res = await this.google.enviar('metas', { operacion: 'quitar', email: p.email, mes: this.mesMetas, indicador: m.indicador }, true);
                    if (!res || !res.ok) return this.aviso((res && res.error) || 'No se pudo quitar.', 'error');
                    this.pintarMetas();
                });
                fila.appendChild(quitar);
            }
            art.appendChild(fila);
        });
        if (p.puedoFijar) {
            const form = document.createElement('form');
            form.className = 'meta-form';
            form.noValidate = true;
            const sufijo = p.email.replace(/[^a-z0-9]/gi, '');
            form.innerHTML = `
                <label class="solo-lector" for="meta-ind-${sufijo}">Qué se mide</label>
                <select id="meta-ind-${sufijo}"></select>
                <label class="solo-lector" for="meta-obj-${sufijo}">Meta</label>
                <input id="meta-obj-${sufijo}" type="number" min="1" step="any" placeholder="Meta">
                <button type="submit" class="btn-secondary">Fijar</button>`;
            const select = form.querySelector('select');
            Object.entries(r.indicadores || NOMBRE_INDICADOR).forEach(([id, nombre]) => {
                const o = document.createElement('option');
                o.value = id;
                o.textContent = nombre;
                select.appendChild(o);
            });
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const objetivo = Number(form.querySelector('input').value);
                if (!(objetivo > 0)) return this.errorEn(form, 'Escribe una meta mayor que 0.');
                const res = await this.google.enviar('metas', { operacion: 'guardar', email: p.email, mes: this.mesMetas, indicador: select.value, objetivo }, true);
                if (!res || !res.ok) return this.errorEn(form, (res && res.error) || 'No se pudo guardar.');
                this.aviso(`Meta fijada a ${p.nombre}; se le avisó.`);
                this.pintarMetas();
            });
            art.appendChild(form);
        }
        return art;
    }
}

window.reunionesMetas = new ReunionesMetas();
