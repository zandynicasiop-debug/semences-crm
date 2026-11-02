/**
 * Bandeja de Instagram (solo con el backend, CONFIG_GOOGLE.api), para administrativos y Master.
 *
 * - Cada quien ve las conversaciones de las cuentas de Instagram de su país y casa comercial.
 * - Responder: solo dentro de las 24 horas siguientes al último mensaje del cliente (regla de Meta).
 * - Convertir en cliente: crea la ficha con el país y la casa de la cuenta y se la asigna a un vendedor
 *   de ese país y casa, que recibe el aviso. Archivar la saca de la bandeja hasta que vuelva a escribir.
 * - Cuentas conectadas (solo Master): id de la cuenta, país, casa y token de la página de Meta.
 * El servidor comprueba todo: esto solo lo enseña.
 */
class BandejaInstagram {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        if (!this.google.conBackend) return;
        this.nuevos = 0;
        this.archivadas = false;
        window.addEventListener('sdc-ambito', () => this.alCambiarAmbito());
        window.addEventListener('load', () => setTimeout(() => { this.crearOpcion(); this.alCambiarAmbito(); }));
        // Cada 2 minutos mira si hay mensajes nuevos (si la app está a la vista y la bandeja cerrada)
        setInterval(() => { if (!document.hidden && !(this.dialogo && this.dialogo.open)) this.contar(); }, 120000);
    }

    get ambito() {
        const a = window.responsable && window.responsable.ambito;
        return a && a.estado === 'aprobado' && (a.cargo === 'administrativo' || a.cargo === 'master') ? a : null;
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    crearOpcion() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || this.opcion) return;
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'menu-extra';
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
        this.pintarOpcion();
    }

    alCambiarAmbito() {
        if (this.opcion) this.opcion.hidden = !this.ambito;
        if (this.ambito) this.contar();
    }

    pintarOpcion() {
        if (!this.opcion) return;
        this.opcion.textContent = this.nuevos ? `Bandeja de Instagram · ${this.nuevos} nueva${this.nuevos === 1 ? '' : 's'}` : 'Bandeja de Instagram';
    }

    async contar() {
        if (!this.ambito) return;
        const r = await this.google.enviar('instagram', { operacion: 'conversaciones' }, true);
        if (!r || !r.ok) return;
        const nuevos = r.conversaciones.filter(c => c.sin_leer > 0).length;
        if (nuevos > this.nuevos) this.aviso(`Instagram: ${nuevos} conversación${nuevos === 1 ? '' : 'es'} sin leer (menú de módulos).`);
        this.nuevos = nuevos;
        this.pintarOpcion();
    }

    // ----- Diálogo -----
    crearDialogo() {
        const d = document.createElement('dialog');
        d.className = 'dialogo dialogo-tablero';
        d.setAttribute('aria-labelledby', 'ig-titulo');
        d.innerHTML = `
            <div class="dialogo-form">
                <div class="tablero-cabecera">
                    <h3 id="ig-titulo">Bandeja de Instagram</h3>
                    <button type="button" class="btn-texto ig-cerrar">Cerrar</button>
                </div>
                <div class="tablero-botones">
                    <button type="button" class="btn-secondary ig-ver-archivadas">Ver archivadas</button>
                    <button type="button" class="btn-secondary ig-ver-cuentas" hidden>Cuentas conectadas</button>
                </div>
                <section class="ig-vista ig-vista-lista">
                    <ul class="ig-conversaciones" aria-label="Conversaciones"></ul>
                </section>
                <section class="ig-vista ig-vista-hilo" hidden></section>
                <section class="ig-vista ig-vista-cuentas" hidden></section>
            </div>`;
        document.body.appendChild(d);
        this.dialogo = d;
        d.querySelector('.ig-cerrar').addEventListener('click', () => d.close());
        d.addEventListener('close', () => { clearInterval(this.refresco); this.contar(); });
        d.querySelector('.ig-ver-archivadas').addEventListener('click', () => {
            this.archivadas = !this.archivadas;
            this.verLista();
        });
        d.querySelector('.ig-ver-cuentas').addEventListener('click', () => this.verCuentas());
    }

    vista(nombre) {
        this.dialogo.querySelectorAll('.ig-vista').forEach(v => { v.hidden = !v.classList.contains(`ig-vista-${nombre}`); });
    }

    async abrir() {
        if (!this.dialogo) this.crearDialogo();
        this.dialogo.querySelector('.ig-ver-cuentas').hidden = !(this.ambito && this.ambito.master);
        if (!this.dialogo.open) this.dialogo.showModal();
        this.archivadas = false;
        await this.verLista();
        clearInterval(this.refresco);
        this.refresco = setInterval(() => { if (!this.dialogo.querySelector('.ig-vista-lista').hidden) this.verLista(); }, 20000);
    }

    error(contenedor, respuesta, porDefecto) {
        const p = document.createElement('p');
        p.className = 'form-error';
        p.setAttribute('role', 'alert');
        p.textContent = (respuesta && respuesta.error) || porDefecto || 'No se pudo cargar. Revisa la conexión.';
        contenedor.appendChild(p);
        return p;
    }

    fecha(valor) {
        const f = new Date(valor);
        if (Number.isNaN(f.getTime())) return '';
        const hoy = new Date();
        return f.toDateString() === hoy.toDateString()
            ? f.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })
            : f.toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
    }

    nombreDe(c) {
        return c.usuario ? `@${c.usuario}` : 'Cliente de Instagram';
    }

    async verLista() {
        this.vista('lista');
        this.dialogo.querySelector('.ig-ver-archivadas').textContent = this.archivadas ? 'Ver la bandeja' : 'Ver archivadas';
        const ul = this.dialogo.querySelector('.ig-conversaciones');
        const r = await this.google.enviar('instagram', { operacion: 'conversaciones', archivadas: this.archivadas }, true);
        ul.innerHTML = '';
        if (!r || !r.ok) { this.error(ul, r); return; }
        this.cuentas = new Map(r.cuentas.map(c => [c.ig_id, c]));
        if (!this.archivadas) { this.nuevos = r.conversaciones.filter(c => c.sin_leer > 0).length; this.pintarOpcion(); }
        if (!r.conversaciones.length) {
            const li = document.createElement('li');
            li.className = 'dialogo-nota';
            li.textContent = !r.cuentas.length
                ? 'Todavía no hay cuentas de Instagram de tu país y casa conectadas. Un Master las da de alta en «Cuentas conectadas».'
                : this.archivadas ? 'No hay conversaciones archivadas.' : 'No hay mensajes. Cuando alguien escriba a la cuenta por Instagram, aparecerá aquí.';
            ul.appendChild(li);
            return;
        }
        r.conversaciones.forEach(c => {
            const cuenta = this.cuentas.get(c.cuenta_id) || {};
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `ig-conversacion${c.sin_leer > 0 ? ' ig-nueva' : ''}`;
            const cab = document.createElement('span');
            cab.className = 'ig-conversacion-cabecera';
            const nombre = document.createElement('strong');
            nombre.textContent = this.nombreDe(c);
            const hora = document.createElement('span');
            hora.textContent = [c.sin_leer > 0 && `${c.sin_leer} nuevo${c.sin_leer === 1 ? '' : 's'}`, this.fecha(c.ultimo)].filter(Boolean).join(' · ');
            cab.append(nombre, hora);
            const detalle = document.createElement('span');
            detalle.className = 'ig-conversacion-detalle';
            detalle.textContent = [cuenta.nombre || cuenta.ig_id, c.estado === 'convertida' && 'ya es cliente'].filter(Boolean).join(' · ');
            const texto = document.createElement('span');
            texto.className = 'ig-conversacion-texto';
            texto.textContent = c.ultimo_texto;
            b.append(cab, detalle, texto);
            b.addEventListener('click', () => this.verHilo(c.cuenta_id, c.igsid));
            li.appendChild(b);
            ul.appendChild(li);
        });
    }

    async verHilo(cuentaId, igsid) {
        this.vista('hilo');
        const panel = this.dialogo.querySelector('.ig-vista-hilo');
        panel.innerHTML = '';
        const volver = document.createElement('button');
        volver.type = 'button';
        volver.className = 'btn-texto';
        volver.textContent = '← Volver a la bandeja';
        volver.addEventListener('click', () => this.verLista());
        panel.appendChild(volver);
        const r = await this.google.enviar('instagram', { operacion: 'mensajes', cuentaId, igsid }, true);
        if (!r || !r.ok) { this.error(panel, r); return; }
        const c = r.conversacion;
        const cuenta = this.cuentas.get(cuentaId) || {};
        const titulo = document.createElement('h4');
        titulo.textContent = `${this.nombreDe(c)} · ${cuenta.nombre || cuentaId}`;
        const mensajes = document.createElement('ul');
        mensajes.className = 'ig-mensajes';
        r.mensajes.forEach(m => {
            const li = document.createElement('li');
            li.className = `ig-mensaje ig-${m.direccion}`;
            const texto = document.createElement('p');
            texto.textContent = m.texto;
            const pie = document.createElement('span');
            pie.textContent = [m.direccion === 'saliente' ? (m.autor || 'La cuenta') : this.nombreDe(c), this.fecha(m.fecha)].filter(Boolean).join(' · ');
            li.append(texto, pie);
            mensajes.appendChild(li);
        });
        panel.append(titulo, mensajes);

        // Responder (24 h)
        const form = document.createElement('form');
        form.className = 'ig-responder';
        form.noValidate = true;
        const area = document.createElement('textarea');
        area.rows = 2;
        area.maxLength = 1000;
        area.setAttribute('aria-label', 'Respuesta');
        area.placeholder = r.puedeResponder ? 'Escribe la respuesta…' : '';
        area.disabled = !r.puedeResponder;
        const enviar = document.createElement('button');
        enviar.type = 'submit';
        enviar.className = 'btn-primary';
        enviar.textContent = 'Responder';
        enviar.disabled = !r.puedeResponder;
        if (r.puedeResponder) form.append(area, enviar);
        else {
            const nota = document.createElement('p');
            nota.className = 'dialogo-nota';
            nota.textContent = 'Pasaron más de 24 horas desde su último mensaje: Instagram no deja responder desde aquí hasta que vuelva a escribir. Si ya es cliente, contáctalo por WhatsApp o teléfono.';
            form.appendChild(nota);
        }
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const texto = area.value.trim();
            if (!texto) return;
            enviar.disabled = true;
            const respuesta = await this.google.enviar('instagram', { operacion: 'responder', cuentaId, igsid, texto }, true);
            enviar.disabled = false;
            if (!respuesta || !respuesta.ok) {
                form.querySelectorAll('.form-error').forEach(p => p.remove());
                this.error(form, respuesta, 'No se pudo enviar. Revisa la conexión.');
                return;
            }
            this.verHilo(cuentaId, igsid);
        });
        panel.appendChild(form);

        // Convertir en cliente y archivar
        const botones = document.createElement('div');
        botones.className = 'tablero-botones';
        if (!c.cliente_id) {
            const convertir = document.createElement('button');
            convertir.type = 'button';
            convertir.className = 'btn-secondary';
            convertir.textContent = 'Convertir en cliente';
            convertir.addEventListener('click', () => { convertir.disabled = true; panel.appendChild(this.formConvertir(cuenta, c)); });
            botones.appendChild(convertir);
        } else {
            const ya = document.createElement('p');
            ya.className = 'dialogo-nota';
            ya.textContent = 'Ya es cliente: está en el CRM, asignado a su vendedor.';
            botones.appendChild(ya);
        }
        const archivar = document.createElement('button');
        archivar.type = 'button';
        archivar.className = 'btn-texto';
        archivar.textContent = c.estado === 'archivada' ? 'Devolver a la bandeja' : 'Archivar';
        archivar.addEventListener('click', async () => {
            const respuesta = await this.google.enviar('instagram', { operacion: 'archivar', cuentaId, igsid, archivar: c.estado !== 'archivada' }, true);
            if (!respuesta || !respuesta.ok) { this.error(panel, respuesta, 'No se pudo archivar.'); return; }
            this.verLista();
        });
        botones.appendChild(archivar);
        panel.appendChild(botones);
        mensajes.lastElementChild && mensajes.lastElementChild.scrollIntoView({ block: 'nearest' });
    }

    campo(etiqueta, nombre, tipo = 'text', valor = '', ejemplo = '') {
        const grupo = document.createElement('div');
        grupo.className = 'form-group';
        const id = `ig-${nombre}-${Math.random().toString(36).slice(2, 8)}`;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = etiqueta;
        const input = tipo === 'textarea' ? document.createElement('textarea') : document.createElement('input');
        if (tipo !== 'textarea') input.type = tipo;
        else input.rows = 2;
        input.id = id;
        input.name = nombre;
        input.value = valor;
        if (ejemplo) input.placeholder = ejemplo;
        grupo.append(label, input);
        return grupo;
    }

    selector(etiqueta, nombre, opciones) {
        const grupo = document.createElement('div');
        grupo.className = 'form-group';
        const id = `ig-${nombre}-${Math.random().toString(36).slice(2, 8)}`;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = etiqueta;
        const select = document.createElement('select');
        select.id = id;
        select.name = nombre;
        opciones.forEach(([valor, texto]) => {
            const o = document.createElement('option');
            o.value = valor;
            o.textContent = texto;
            select.appendChild(o);
        });
        grupo.append(label, select);
        return grupo;
    }

    formConvertir(cuenta, c) {
        const form = document.createElement('form');
        form.className = 'tablero-accion';
        form.noValidate = true;
        const titulo = document.createElement('h4');
        titulo.textContent = `Nuevo cliente de ${cuenta.pais || ''} · ${cuenta.casa || ''}`;
        // Vendedores aprobados que trabajan el país y la casa de la cuenta (del tablero del equipo)
        const equipo = (window.tableroEquipo && window.tableroEquipo.equipo) || [];
        const vendedores = equipo.filter(p => p.cargo === 'vendedor' && (p.paises || []).includes(cuenta.pais) && (p.casas || []).includes(cuenta.casa));
        const vendedor = this.selector('Asignar al vendedor', 'vendedor', [['', vendedores.length ? 'Elige el vendedor' : 'No hay vendedores de ese país y casa'], ...vendedores.map(p => [p.email, p.nombre || p.email])]);
        form.append(titulo,
            this.campo('Nombre del cliente o finca', 'nombre', 'text', '', c.usuario ? `Lo que diga @${c.usuario}` : 'Finca López'),
            this.campo('WhatsApp', 'whatsapp', 'tel', '', '829 555 1234'),
            this.campo('Teléfono', 'telefono', 'tel', '', '809 555 1234'),
            this.campo('Correo', 'correo', 'email', '', 'cliente@ejemplo.com'),
            this.campo('Qué busca (lo verá el vendedor)', 'notas', 'textarea'),
            vendedor);
        const error = document.createElement('p');
        error.className = 'form-error';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        const acciones = document.createElement('div');
        acciones.className = 'modal-actions';
        const guardar = document.createElement('button');
        guardar.type = 'submit';
        guardar.className = 'btn-primary';
        guardar.textContent = 'Crear cliente y avisar al vendedor';
        acciones.appendChild(guardar);
        form.append(error, acciones);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const datos = Object.fromEntries(new FormData(form));
            if (!datos.nombre.trim() || !datos.vendedor) {
                error.textContent = 'Escribe el nombre del cliente y elige el vendedor.';
                error.hidden = false;
                return;
            }
            guardar.disabled = true;
            const r = await this.google.enviar('instagram', { operacion: 'convertir', cuentaId: c.cuenta_id, igsid: c.igsid, ...datos }, true);
            guardar.disabled = false;
            if (!r || !r.ok) {
                error.textContent = (r && r.error) || 'No se pudo crear. Revisa la conexión.';
                error.hidden = false;
                return;
            }
            const elegido = vendedores.find(p => p.email === datos.vendedor);
            this.aviso(`Cliente creado y asignado a ${(elegido && elegido.nombre) || datos.vendedor}; le avisamos.`);
            // Que la ficha nueva aparezca ya en el CRM
            if (window.baseDatos) window.baseDatos.sincronizar();
            this.verHilo(c.cuenta_id, c.igsid);
        });
        return form;
    }

    // ----- Cuentas conectadas (Master) -----
    async verCuentas() {
        this.vista('cuentas');
        const panel = this.dialogo.querySelector('.ig-vista-cuentas');
        panel.innerHTML = '';
        const volver = document.createElement('button');
        volver.type = 'button';
        volver.className = 'btn-texto';
        volver.textContent = '← Volver a la bandeja';
        volver.addEventListener('click', () => this.verLista());
        panel.appendChild(volver);
        const r = await this.google.enviar('instagram', { operacion: 'cuentas' }, true);
        if (!r || !r.ok) { this.error(panel, r); return; }
        if (!r.webhook) {
            const nota = document.createElement('p');
            nota.className = 'form-error';
            nota.textContent = 'El servidor aún no tiene META_APP_SECRET y META_VERIFY_TOKEN: no llegarán mensajes hasta configurarlos (ver LEEME del servidor).';
            panel.appendChild(nota);
        }
        const ul = document.createElement('ul');
        ul.className = 'accesos-lista';
        r.cuentas.forEach(cuenta => {
            const li = document.createElement('li');
            li.className = 'acceso';
            const textos = document.createElement('div');
            const nombre = document.createElement('strong');
            nombre.textContent = cuenta.nombre || cuenta.ig_id;
            const detalle = document.createElement('span');
            detalle.textContent = ` · ${cuenta.ig_id} · ${cuenta.pais} · ${cuenta.casa}`;
            textos.append(nombre, detalle);
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'btn-texto btn-peligro';
            quitar.textContent = 'Desconectar';
            quitar.addEventListener('click', async () => {
                if (!window.confirm(`¿Desconectar ${cuenta.nombre || cuenta.ig_id}? Sus conversaciones dejan de verse en la bandeja.`)) return;
                const respuesta = await this.google.enviar('instagram', { operacion: 'quitarCuenta', igId: cuenta.ig_id }, true);
                if (respuesta && respuesta.ok) this.verCuentas();
            });
            li.append(textos, quitar);
            ul.appendChild(li);
        });
        panel.appendChild(ul);

        const form = document.createElement('form');
        form.className = 'tablero-accion';
        form.noValidate = true;
        const titulo = document.createElement('h4');
        titulo.textContent = 'Conectar o actualizar una cuenta';
        const ayuda = document.createElement('p');
        ayuda.className = 'dialogo-nota';
        ayuda.textContent = 'El id de la cuenta profesional de Instagram y el token de acceso de su página salen de la app de Meta (ver LEEME del servidor). Para cambiar solo el país o la casa, deja el token vacío.';
        form.append(titulo, ayuda,
            this.campo('Nombre (para la bandeja)', 'nombre', 'text', '', 'Gautier RD'),
            this.campo('Id de la cuenta de Instagram', 'igId', 'text', '', '17841400000000000'),
            this.selector('País', 'pais', [['RD', 'República Dominicana'], ['VE', 'Venezuela']]),
            this.selector('Casa comercial', 'casa', ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó'].map(c => [c, c])),
            this.campo('Token de acceso de la página', 'token', 'password'));
        form.querySelector('input[name="token"]').autocomplete = 'off';
        const error = document.createElement('p');
        error.className = 'form-error';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        const acciones = document.createElement('div');
        acciones.className = 'modal-actions';
        const guardar = document.createElement('button');
        guardar.type = 'submit';
        guardar.className = 'btn-primary';
        guardar.textContent = 'Guardar cuenta';
        acciones.appendChild(guardar);
        form.append(error, acciones);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const respuesta = await this.google.enviar('instagram', { operacion: 'guardarCuenta', ...Object.fromEntries(new FormData(form)) }, true);
            if (!respuesta || !respuesta.ok) {
                error.textContent = (respuesta && respuesta.error) || 'No se pudo guardar. Revisa la conexión.';
                error.hidden = false;
                return;
            }
            this.aviso('Cuenta de Instagram guardada.');
            this.verCuentas();
        });
        panel.appendChild(form);
    }
}

window.bandejaInstagram = new BandejaInstagram();
