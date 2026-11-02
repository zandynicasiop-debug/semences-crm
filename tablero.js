/**
 * Tablero del equipo y accesos (solo con el backend, CONFIG_GOOGLE.api).
 *
 * - Tablero: quién está conectado (foto de Google, cargo y estado: disponible, en parcela, en reunión o
 *   desconectado). Al tocar a alguien: mensaje directo, videollamada inmediata con Meet, pasarle un
 *   cliente o asignarle una tarea. A esa persona le llega a su bandeja de la app, por push y por WhatsApp.
 * - Equipo y accesos (solo Master): la sala de espera, con quién pidió acceso, y para cada persona su
 *   cargo, sus países y sus casas comerciales. El servidor comprueba todo: esto solo lo enseña.
 *
 * La app avisa al servidor cada minuto de que sigue abierta ("presencia"); quien deja de hacerlo
 * en más de 2 minutos y medio aparece como desconectado.
 */
const ESTADOS_PRESENCIA = { disponible: 'Disponible', en_parcela: 'En parcela', en_reunion: 'En reunión', desconectado: 'Desconectado' };
const NOMBRE_CARGO = { vendedor: 'Vendedor', tecnico: 'Técnico', administrativo: 'Administrativo', master: 'Master' };

class TableroEquipo {
    constructor() {
        this.equipo = [];
        this.sinLeer = 0;
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        if (!this.google.conBackend) return;
        this.crearDialogo();
        window.addEventListener('sdc-ambito', () => this.alCambiarAmbito());
        window.addEventListener('load', () => setTimeout(() => { this.crearOpciones(); this.alCambiarAmbito(); }));
        // Latido cada minuto (si la app está a la vista); con el tablero abierto, cada 15 segundos
        setInterval(() => { if (!document.hidden && !(this.dialogo && this.dialogo.open)) this.latido(); }, 60000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.latido(); });
    }

    get ambito() {
        const a = window.responsable && window.responsable.ambito;
        return a && a.estado === 'aprobado' ? a : null;
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    // ----- Menú de módulos -----
    crearOpciones() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || this.opcionTablero) return;
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
        this.opcionTablero = opcion('Tablero del equipo', () => this.abrir());
        this.opcionAccesos = opcion('Equipo y accesos', () => this.abrirAccesos());
    }

    alCambiarAmbito() {
        const ambito = this.ambito;
        if (this.opcionTablero) this.opcionTablero.hidden = !ambito;
        if (this.opcionAccesos) this.opcionAccesos.hidden = !(ambito && ambito.master);
        this.pintarOpcion();
        if (ambito) this.latido();
    }

    pintarOpcion() {
        if (!this.opcionTablero) return;
        this.opcionTablero.textContent = this.sinLeer ? `Tablero del equipo · ${this.sinLeer} mensaje${this.sinLeer === 1 ? '' : 's'} nuevo${this.sinLeer === 1 ? '' : 's'}` : 'Tablero del equipo';
    }

    async latido(estado) {
        if (!this.ambito) return null;
        const respuesta = await this.google.enviar('presencia', estado ? { estado } : {}, true);
        if (!respuesta || !respuesta.ok) return null;
        this.equipo = respuesta.equipo || [];
        if (respuesta.sinLeer > this.sinLeer && !(this.dialogo && this.dialogo.open)) {
            this.aviso(`Tienes ${respuesta.sinLeer} mensaje${respuesta.sinLeer === 1 ? '' : 's'} nuevo${respuesta.sinLeer === 1 ? '' : 's'} en el tablero del equipo (menú de módulos).`);
        }
        this.sinLeer = respuesta.sinLeer || 0;
        this.pintarOpcion();
        return respuesta;
    }

    // ----- Tablero -----
    crearDialogo() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo dialogo-tablero';
        dialogo.setAttribute('aria-labelledby', 'tablero-titulo');
        dialogo.innerHTML = `
            <div class="dialogo-form">
                <div class="tablero-cabecera">
                    <h3 id="tablero-titulo">Equipo</h3>
                    <button type="button" class="btn-texto tablero-cerrar">Cerrar</button>
                </div>
                <div class="form-group">
                    <label for="tablero-estado">Tu estado</label>
                    <select id="tablero-estado">
                        <option value="disponible">Disponible</option>
                        <option value="en_parcela">En parcela</option>
                        <option value="en_reunion">En reunión</option>
                    </select>
                </div>
                <ul class="tablero-avatares" aria-label="Personas del equipo"></ul>
                <section class="tablero-accion" hidden></section>
                <section class="tablero-bandeja">
                    <h4>Mensajes para ti</h4>
                    <ul class="tablero-mensajes"></ul>
                </section>
            </div>`;
        document.body.appendChild(dialogo);
        this.dialogo = dialogo;
        this.lista = dialogo.querySelector('.tablero-avatares');
        this.panelAccion = dialogo.querySelector('.tablero-accion');
        this.selectEstado = dialogo.querySelector('#tablero-estado');
        dialogo.querySelector('.tablero-cerrar').addEventListener('click', () => dialogo.close());
        dialogo.addEventListener('close', () => clearInterval(this.refresco));
        this.selectEstado.addEventListener('change', async () => {
            await this.latido(this.selectEstado.value);
            this.pintar();
        });
    }

    async abrir() {
        this.panelAccion.hidden = true;
        if (!this.dialogo.open) this.dialogo.showModal();
        await this.latido();
        this.pintar();
        this.cargarBandeja();
        clearInterval(this.refresco);
        this.refresco = setInterval(async () => { await this.latido(); this.pintar(); }, 15000);
    }

    avatar(persona) {
        const caja = document.createElement('span');
        caja.className = 'avatar';
        const inicial = () => {
            caja.textContent = (persona.nombre || persona.email || '?').trim().charAt(0).toLocaleUpperCase('es');
        };
        // Foto de la cuenta de Google (solo de Google, por https)
        if (/^https:\/\/lh\d\.googleusercontent\.com\//.test(persona.foto || '')) {
            const img = document.createElement('img');
            img.src = persona.foto;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            img.addEventListener('error', () => { img.remove(); inicial(); });
            caja.appendChild(img);
        } else {
            inicial();
        }
        return caja;
    }

    pintar() {
        const yo = this.equipo.find(p => p.yo);
        if (yo && yo.estado !== 'desconectado') this.selectEstado.value = yo.estado;
        this.lista.innerHTML = '';
        const orden = { disponible: 0, en_parcela: 1, en_reunion: 2, desconectado: 3 };
        [...this.equipo].filter(p => !p.yo)
            .sort((a, b) => orden[a.estado] - orden[b.estado] || String(a.nombre).localeCompare(String(b.nombre), 'es'))
            .forEach(persona => {
                const li = document.createElement('li');
                const boton = document.createElement('button');
                boton.type = 'button';
                boton.className = 'tablero-persona';
                boton.dataset.estado = persona.estado;
                const textos = document.createElement('span');
                textos.className = 'tablero-persona-textos';
                const nombre = document.createElement('strong');
                nombre.textContent = persona.nombre || persona.email;
                const detalle = document.createElement('span');
                detalle.textContent = [NOMBRE_CARGO[persona.cargo], ESTADOS_PRESENCIA[persona.estado]].filter(Boolean).join(' · ');
                textos.append(nombre, detalle);
                boton.append(this.avatar(persona), textos);
                boton.setAttribute('aria-label', `${nombre.textContent}, ${detalle.textContent}. Acciones`);
                boton.addEventListener('click', () => this.acciones(persona));
                li.appendChild(boton);
                this.lista.appendChild(li);
            });
        if (!this.lista.children.length) {
            const li = document.createElement('li');
            li.className = 'dialogo-nota';
            li.textContent = 'Todavía no hay más personas aprobadas en el equipo.';
            this.lista.appendChild(li);
        }
    }

    async cargarBandeja() {
        const ul = this.dialogo.querySelector('.tablero-mensajes');
        const respuesta = await this.google.enviar('bandeja', {}, true);
        ul.innerHTML = '';
        const mensajes = (respuesta && respuesta.mensajes) || [];
        if (!mensajes.length) {
            const li = document.createElement('li');
            li.className = 'dialogo-nota';
            li.textContent = 'No tienes mensajes.';
            ul.appendChild(li);
        }
        mensajes.forEach(m => {
            const li = document.createElement('li');
            li.className = `tablero-mensaje${m.leido ? '' : ' tablero-mensaje-nuevo'}`;
            const de = document.createElement('strong');
            de.textContent = `${m.de || m.deEmail} · ${new Date(m.creado).toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
            const texto = document.createElement('p');
            texto.textContent = m.texto;
            li.append(de, texto);
            if (/^https:\/\/meet\.google\.com\//.test(m.enlace || '')) {
                const a = document.createElement('a');
                a.href = m.enlace;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = 'Unirse a la videollamada';
                li.appendChild(a);
            }
            ul.appendChild(li);
        });
        this.sinLeer = 0;
        this.pintarOpcion();
    }

    // Lo que se puede hacer con una persona del tablero
    acciones(persona) {
        const panel = this.panelAccion;
        panel.innerHTML = '';
        panel.hidden = false;
        const titulo = document.createElement('h4');
        titulo.textContent = persona.nombre || persona.email;
        const botones = document.createElement('div');
        botones.className = 'tablero-botones';
        const zona = document.createElement('div');
        zona.className = 'tablero-zona';
        [['Mensaje', () => this.formMensaje(persona, zona)], ['Videollamada ahora', () => this.formVideollamada(persona, zona)],
            ['Pasarle un cliente', () => this.formCliente(persona, zona)], ['Asignarle una tarea', () => this.formTarea(persona, zona)]]
            .forEach(([texto, alPulsar]) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn-secondary';
                b.textContent = texto;
                b.addEventListener('click', alPulsar);
                botones.appendChild(b);
            });
        panel.append(titulo, botones, zona);
        this.formMensaje(persona, zona);
        panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Formulario pequeño dentro del panel: campos + botón de enviar; enviar() devuelve el texto del aviso o lanza el error
    formulario(zona, html, textoBoton, enviar) {
        zona.innerHTML = '';
        const form = document.createElement('form');
        form.noValidate = true;
        form.innerHTML = `${html}<p class="form-error" role="alert" hidden></p><div class="modal-actions"><button type="submit" class="btn-primary"></button></div>`;
        const boton = form.querySelector('button[type="submit"]');
        boton.textContent = textoBoton;
        const error = form.querySelector('.form-error');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            error.hidden = true;
            boton.disabled = true;
            try {
                this.aviso(await enviar(form));
                this.panelAccion.hidden = true;
            } catch (fallo) {
                error.textContent = fallo.message;
                error.hidden = false;
            } finally {
                boton.disabled = false;
            }
        });
        zona.appendChild(form);
        const primero = form.querySelector('input, textarea, select');
        if (primero) primero.focus();
        return form;
    }

    async pedir(accion, datos) {
        const respuesta = await this.google.enviar(accion, datos, true);
        if (!respuesta) throw new Error('Sin conexión con el servidor. Inténtalo de nuevo.');
        if (!respuesta.ok) throw new Error(respuesta.error || 'No se pudo hacer.');
        return respuesta;
    }

    formMensaje(persona, zona) {
        this.formulario(zona, `
            <div class="form-group"><label for="tablero-texto">Mensaje</label><textarea id="tablero-texto" rows="3" maxlength="2000" required></textarea></div>`,
        'Enviar', async (form) => {
            const texto = form.querySelector('#tablero-texto').value.trim();
            if (!texto) throw new Error('Escribe el mensaje.');
            await this.pedir('directo', { para: persona.email, texto });
            return `Mensaje enviado a ${persona.nombre}: le llega a la app, por push y por WhatsApp.`;
        });
    }

    formVideollamada(persona, zona) {
        this.formulario(zona, `
            <p class="dialogo-nota">Se crea una videollamada de Google Meet que empieza en 2 minutos y dura 30. ${''}Le llega la invitación de Google y un aviso con el enlace.</p>
            <div class="form-group"><label for="tablero-motivo">Motivo (opcional)</label><input id="tablero-motivo" type="text" maxlength="200"></div>`,
        'Llamar ahora', async (form) => {
            const motivo = form.querySelector('#tablero-motivo').value.trim();
            const inicio = new Date(Date.now() + 2 * 60000);
            const yo = window.responsable ? window.responsable.nombre : '';
            const reunion = await this.pedir('calendar', {
                titulo: `Videollamada · ${yo} y ${persona.nombre}${motivo ? ` · ${motivo}` : ''}`,
                inicio: inicio.toISOString(),
                fin: new Date(inicio.getTime() + 30 * 60000).toISOString(),
                invitados: [persona.email],
                conMeet: true
            });
            if (!reunion.meetUrl) throw new Error('Google no devolvió el enlace de Meet.');
            await this.pedir('directo', { para: persona.email, tipo: 'reunion', texto: `Te invita a una videollamada ahora${motivo ? `: ${motivo}` : ''}`, enlace: reunion.meetUrl });
            // El enlace para entrar quien llama
            const zonaEnlace = this.dialogo.querySelector('.tablero-bandeja');
            const a = document.createElement('a');
            a.className = 'btn-primary enlace-reporte';
            a.href = reunion.meetUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = `Entrar a la videollamada con ${persona.nombre}`;
            zonaEnlace.before(a);
            a.focus();
            return `Videollamada creada: ${persona.nombre} tiene la invitación y el aviso.`;
        });
    }

    formCliente(persona, zona) {
        const clientes = [...((window.baseDatos && window.baseDatos.datos.clientes) || [])]
            .filter(c => c.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        if (!clientes.length) {
            zona.innerHTML = '<p class="dialogo-nota">No tienes clientes que pasar.</p>';
            return;
        }
        const form = this.formulario(zona, `
            <div class="form-group"><label for="tablero-cliente">Cliente</label><select id="tablero-cliente"></select></div>
            <div class="form-group"><label for="tablero-nota">Nota (opcional)</label><input id="tablero-nota" type="text" maxlength="500"></div>`,
        'Pasar el cliente', async (f) => {
            const select = f.querySelector('#tablero-cliente');
            await this.pedir('pasarCliente', { clienteId: select.value, para: persona.email, nota: f.querySelector('#tablero-nota').value });
            if (window.baseDatos) window.baseDatos.sincronizar();
            return `${select.selectedOptions[0].textContent} ahora está asignado a ${persona.nombre}; ya le avisamos.`;
        });
        const select = form.querySelector('#tablero-cliente');
        clientes.forEach(c => {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.nombre;
            select.appendChild(o);
        });
    }

    formTarea(persona, zona) {
        const form = this.formulario(zona, `
            <div class="form-group"><label for="tablero-tarea">Tarea</label><input id="tablero-tarea" type="text" maxlength="200" required></div>
            <div class="reunion-fila">
                <div class="form-group"><label for="tablero-prioridad">Prioridad</label><select id="tablero-prioridad"></select></div>
                <div class="form-group"><label for="tablero-vence">Para cuándo (opcional)</label><input id="tablero-vence" type="date"></div>
            </div>`,
        'Asignar la tarea', async (f) => {
            const titulo = f.querySelector('#tablero-tarea').value.trim().replace(/\s+/g, ' ');
            if (!titulo) throw new Error('Escribe la tarea.');
            const tarea = {
                id: nuevoId(), titulo,
                prioridad: f.querySelector('#tablero-prioridad').value,
                vence: f.querySelector('#tablero-vence').value,
                para: persona.nombre || persona.email,
                creadaPor: window.responsable ? window.responsable.nombre : '',
                creada: new Date().toISOString(), hecha: '', hechaPor: ''
            };
            window.baseDatos.guardar('tareas', tarea);
            const cuando = tarea.vence ? `, para el ${tarea.vence.split('-').reverse().join('/')}` : '';
            await this.pedir('directo', { para: persona.email, tipo: 'tarea', texto: `Te asignó una tarea (prioridad ${tarea.prioridad.toLowerCase()}${cuando}): ${titulo}` });
            return `Tarea asignada a ${persona.nombre}; ya le avisamos.`;
        });
        const select = form.querySelector('#tablero-prioridad');
        PRIORIDADES.forEach(p => {
            const o = document.createElement('option');
            o.value = o.textContent = p;
            if (p === 'Media') o.selected = true;
            select.appendChild(o);
        });
    }

    // ----- Equipo y accesos (Master) -----
    async abrirAccesos() {
        if (!this.dialogoAccesos) {
            const d = document.createElement('dialog');
            d.className = 'dialogo dialogo-tablero';
            d.setAttribute('aria-labelledby', 'accesos-titulo');
            d.innerHTML = `
                <div class="dialogo-form">
                    <div class="tablero-cabecera">
                        <h3 id="accesos-titulo">Equipo y accesos</h3>
                        <button type="button" class="btn-texto">Cerrar</button>
                    </div>
                    <p class="dialogo-nota">Quien entra por primera vez espera aquí. Asígnale su cargo, sus países y sus casas comerciales: solo verá esos datos.</p>
                    <ul class="accesos-lista"></ul>
                </div>`;
            d.querySelector('.tablero-cabecera button').addEventListener('click', () => d.close());
            document.body.appendChild(d);
            this.dialogoAccesos = d;
        }
        if (!this.dialogoAccesos.open) this.dialogoAccesos.showModal();
        this.pintarAccesos(await this.google.enviar('accesos', { operacion: 'listar' }, true));
    }

    pintarAccesos(respuesta) {
        const ul = this.dialogoAccesos.querySelector('.accesos-lista');
        ul.innerHTML = '';
        if (!respuesta || !respuesta.ok) {
            ul.innerHTML = '<li class="form-error"></li>';
            ul.firstChild.textContent = (respuesta && respuesta.error) || 'No se pudo cargar. Revisa la conexión.';
            return;
        }
        const { opciones } = respuesta;
        respuesta.personas.forEach(persona => {
            const li = document.createElement('li');
            li.className = `acceso acceso-${persona.master ? 'master' : persona.estado}`;
            const cab = document.createElement('div');
            cab.className = 'acceso-cabecera';
            const textos = document.createElement('div');
            const nombre = document.createElement('strong');
            nombre.textContent = persona.nombre || persona.email;
            const detalle = document.createElement('span');
            const estado = persona.master ? 'Master' : { pendiente: persona.solicitado ? 'En la sala de espera' : 'Entró, sin pedir acceso todavía', aprobado: 'Aprobado', rechazado: 'Rechazado' }[persona.estado];
            detalle.textContent = [persona.email, persona.telefono && `WhatsApp ${persona.telefono}`, estado].filter(Boolean).join(' · ');
            textos.append(nombre, detalle);
            cab.append(this.avatar(persona), textos);
            li.appendChild(cab);
            if (!persona.master) li.appendChild(this.formAcceso(persona, opciones));
            ul.appendChild(li);
        });
    }

    formAcceso(persona, opciones) {
        const form = document.createElement('form');
        form.className = 'acceso-form';
        form.noValidate = true;
        const casilla = (nombre, valor, texto, marcada) => {
            const label = document.createElement('label');
            label.className = 'casilla';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = nombre;
            input.value = valor;
            input.checked = marcada;
            const span = document.createElement('span');
            span.textContent = texto;
            label.append(input, span);
            return label;
        };
        const grupo = (titulo, hijos) => {
            const fs = document.createElement('fieldset');
            fs.className = 'acceso-grupo';
            const legend = document.createElement('legend');
            legend.textContent = titulo;
            fs.append(legend, ...hijos);
            return fs;
        };
        const cargo = document.createElement('select');
        cargo.name = 'cargo';
        cargo.setAttribute('aria-label', `Cargo de ${persona.nombre || persona.email}`);
        [['', 'Elige el cargo'], ...opciones.cargos.map(c => [c, NOMBRE_CARGO[c] || c])].forEach(([valor, texto]) => {
            const o = document.createElement('option');
            o.value = valor;
            o.textContent = texto;
            if (valor === (persona.cargo || '')) o.selected = true;
            cargo.appendChild(o);
        });
        form.append(
            grupo('Cargo', [cargo]),
            grupo('Países', opciones.paises.map(p => casilla('pais', p.id, p.nombre, persona.paises.includes(p.id)))),
            grupo('Casas comerciales', opciones.casas.map(c => casilla('casa', c, c, persona.casas.includes(c))))
        );
        const error = document.createElement('p');
        error.className = 'form-error';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        const acciones = document.createElement('div');
        acciones.className = 'modal-actions';
        const boton = (texto, clase, operacion) => {
            const b = document.createElement('button');
            b.type = operacion === 'aprobar' ? 'submit' : 'button';
            b.className = clase;
            b.textContent = texto;
            if (operacion !== 'aprobar') b.addEventListener('click', () => enviar(operacion));
            acciones.appendChild(b);
        };
        if (persona.estado === 'rechazado') {
            boton('Devolver a la sala de espera', 'btn-secondary', 'reabrir');
        } else {
            if (persona.estado === 'aprobado') boton('Quitar el acceso', 'btn-texto btn-peligro', 'reabrir');
            else boton('Rechazar', 'btn-texto btn-peligro', 'rechazar');
            boton(persona.estado === 'aprobado' ? 'Guardar cambios' : 'Aprobar', 'btn-primary', 'aprobar');
        }
        const enviar = async (operacion) => {
            error.hidden = true;
            if (operacion === 'rechazar' && !window.confirm(`¿Rechazar el acceso de ${persona.nombre || persona.email}?`)) return;
            if (operacion === 'reabrir' && persona.estado === 'aprobado' && !window.confirm(`¿Quitar el acceso a ${persona.nombre || persona.email}? Vuelve a la sala de espera.`)) return;
            const datos = { operacion, email: persona.email };
            if (operacion === 'aprobar') {
                datos.cargo = cargo.value;
                datos.paises = [...form.querySelectorAll('input[name="pais"]:checked')].map(i => i.value);
                datos.casas = [...form.querySelectorAll('input[name="casa"]:checked')].map(i => i.value);
                if (!datos.cargo || !datos.paises.length || !datos.casas.length) {
                    error.textContent = 'Elige el cargo, al menos un país y al menos una casa comercial.';
                    error.hidden = false;
                    return;
                }
            }
            const respuesta = await this.google.enviar('accesos', datos, true);
            if (!respuesta || !respuesta.ok) {
                error.textContent = (respuesta && respuesta.error) || 'No se pudo guardar. Revisa la conexión.';
                error.hidden = false;
                return;
            }
            this.aviso({ aprobar: `${persona.nombre || persona.email} tiene acceso${persona.estado !== 'aprobado' ? '; le avisamos por WhatsApp' : ''}.`, rechazar: 'Solicitud rechazada.', reabrir: 'Vuelve a la sala de espera.' }[operacion]);
            this.pintarAccesos(respuesta);
        };
        form.addEventListener('submit', (e) => { e.preventDefault(); enviar('aprobar'); });
        form.append(error, acciones);
        return form;
    }
}

window.tableroEquipo = new TableroEquipo();
