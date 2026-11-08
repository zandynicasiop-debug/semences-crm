/**
 * Barra de accesos: Agenda, Mensajes, Avisos, Equipo, Reuniones, Metas, Tareas y Chat del equipo.
 *
 * - En el ordenador van en la cabecera (con nombre en pantallas anchas; solo el icono si no caben).
 *   En el teléfono, en una barra fija abajo: Agenda, Mensajes, Avisos, Tareas y "Más" (Chat, Equipo,
 *   Reuniones y Metas).
 * - Cada función abre un panel lateral; solo uno a la vez (cerrarPanelesLaterales).
 * - Avisos (campana): todo lo que le llegó a la persona (mensajes, clientes que le pasan, tareas,
 *   reuniones, germinación baja, envíos, Instagram, reportes, metas), con contador; al tocar uno se va
 *   a su sitio. Mensajes: el chat general y conversaciones 1 a 1 con cada persona.
 * Mensajes, Avisos, Equipo, Reuniones y Metas necesitan el backend (CONFIG_GOOGLE.api) y una cuenta
 * aprobada; sin él quedan la Agenda (con los datos del dispositivo), Tareas y Chat.
 */
Object.assign(ICONOS, {
    agenda: ['M8 2v4', 'M16 2v4', 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 10h18'],
    mensajes: ['M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z', 'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1'],
    equipo: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    metas: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0', 'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0'],
    mas: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    paquete: ['M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z', 'M12 22V12', 'M3.29 7 12 12l8.71-5'],
    camara: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z', 'M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
    volver: ['m15 18-6-6 6-6']
});

// Solo un panel lateral abierto: al abrir uno se cierran los demás (y su botón deja de estar "abierto")
function cerrarPanelesLaterales(excepto) {
    document.querySelectorAll('aside.panel-chat').forEach(p => {
        if (p === excepto || p.hidden) return;
        p.hidden = true;
        document.querySelectorAll(`[aria-controls="${p.id}"]`).forEach(b => b.setAttribute('aria-expanded', 'false'));
    });
}
window.cerrarPanelesLaterales = cerrarPanelesLaterales;

// Hora o fecha corta de un aviso o mensaje ("10:42 a. m.", "ayer", "3 nov")
function cuandoCorto(fecha) {
    const f = new Date(fecha);
    if (Number.isNaN(f.getTime())) return '';
    const hoy = new Date();
    if (f.toDateString() === hoy.toDateString()) return f.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
    const ayer = new Date(hoy.getTime() - 86400000);
    if (f.toDateString() === ayer.toDateString()) return 'ayer';
    return f.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}

/**
 * Panel lateral (como el del chat): cabecera con título, nota y "Cerrar"; cuerpo libre.
 * Devuelve { panel, cuerpo, nota, abrir, cerrar, alternar, abierto }.
 */
function crearPanelLateral(id, titulo) {
    const panel = document.createElement('aside');
    panel.id = id;
    panel.className = 'panel-chat panel-acceso';
    panel.setAttribute('aria-labelledby', `${id}-titulo`);
    panel.hidden = true;
    panel.innerHTML = `
        <div class="panel-chat-cabecera">
            <div>
                <h2 id="${id}-titulo"></h2>
                <p class="panel-chat-nota"></p>
            </div>
            <button type="button" class="btn-texto panel-cerrar-acceso">Cerrar</button>
        </div>
        <div class="panel-acceso-cuerpo"></div>`;
    panel.querySelector('h2').textContent = titulo;
    document.body.appendChild(panel);
    const p = {
        panel,
        titulo: panel.querySelector('h2'),
        nota: panel.querySelector('.panel-chat-nota'),
        cuerpo: panel.querySelector('.panel-acceso-cuerpo'),
        get abierto() { return !panel.hidden; },
        abrir() {
            cerrarPanelesLaterales(panel);
            panel.hidden = false;
            document.querySelectorAll(`[aria-controls="${id}"]`).forEach(b => b.setAttribute('aria-expanded', 'true'));
            panel.querySelector('.panel-cerrar-acceso').focus({ preventScroll: true });
        },
        cerrar() {
            panel.hidden = true;
            document.querySelectorAll(`[aria-controls="${id}"]`).forEach(b => b.setAttribute('aria-expanded', 'false'));
        }
    };
    p.alternar = () => (p.abierto ? p.cerrar() : p.abrir());
    panel.querySelector('.panel-cerrar-acceso').addEventListener('click', () => p.cerrar());
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') p.cerrar(); });
    return p;
}

class Accesos {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        this.conBackend = this.google.conBackend;
        this.items = new Map(); // id → { titulo, icono, alPulsar, controla, contador, backend }
        this.contadores = { mensajes: 0, avisos: 0 };
        window.addEventListener('load', () => setTimeout(() => this.montar()));
        window.addEventListener('sdc-ambito', () => this.pintar());
        window.addEventListener('sdc-presencia', (e) => this.alLatido(e.detail));
    }

    get aprobado() {
        const a = window.responsable && window.responsable.ambito;
        return Boolean(this.conBackend && a && a.estado === 'aprobado');
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    /**
     * Otras partes de la app añaden su acceso (agenda.js, reunionesMetas.js).
     * { id, titulo, icono, alPulsar, controla (id del panel), backend: necesita el backend aprobado }
     */
    registrar(item) {
        this.items.set(item.id, item);
        if (this.montado) this.pintar();
    }

    montar() {
        if (this.montado || this.cabecera) return;
        this.campana = crearPanelLateral('panel-avisos-persona', 'Avisos');
        this.mensajes = crearPanelLateral('panel-mensajes', 'Mensajes');
        this.registrar({ id: 'mensajes', titulo: 'Mensajes', icono: 'mensajes', controla: 'panel-mensajes', backend: true, alPulsar: () => this.alternarMensajes() });
        this.registrar({ id: 'avisos', titulo: 'Avisos', icono: 'avisos', controla: 'panel-avisos-persona', backend: true, alPulsar: () => this.alternarCampana() });
        this.registrar({ id: 'equipo', titulo: 'Equipo', icono: 'equipo', backend: true, alPulsar: () => window.tableroEquipo && window.tableroEquipo.abrir() });
        // Tareas y Chat ya tienen su botón (tareas.js, equipo.js): se ordenan con los demás
        this.registrar({ id: 'tareas', titulo: 'Tareas', icono: 'tareas', controla: 'panel-tareas', alPulsar: () => window.tareas && window.tareas.alternarPanel() });
        this.registrar({ id: 'chat', titulo: 'Chat', icono: 'chat', controla: 'panel-chat', alPulsar: () => window.equipo && window.equipo.alternarPanel() });

        // Cabecera (ordenador) y barra inferior (teléfono)
        this.cabecera = document.createElement('div');
        this.cabecera.className = 'accesos-cabecera';
        this.cabecera.setAttribute('role', 'toolbar');
        this.cabecera.setAttribute('aria-label', 'Accesos rápidos');
        const nav = document.getElementById('app-nav');
        nav.insertBefore(this.cabecera, document.getElementById('btn-tareas') || document.getElementById('btn-chat'));
        this.barra = document.createElement('nav');
        this.barra.className = 'barra-inferior';
        this.barra.setAttribute('aria-label', 'Accesos rápidos');
        document.body.appendChild(this.barra);
        document.body.classList.add('con-barra-inferior');
        this.hojaMas = this.crearHojaMas();
        this.montado = true; // Desde aquí, cada acceso que se registre se pinta al momento
        this.pintar();
    }

    // Orden en la cabecera y qué va en la barra inferior del teléfono (el resto, en "Más")
    static ORDEN = ['agenda', 'mensajes', 'avisos', 'equipo', 'reuniones', 'metas', 'tareas', 'chat'];
    static EN_BARRA = ['agenda', 'mensajes', 'avisos', 'tareas'];

    visibles() {
        return Accesos.ORDEN.map(id => this.items.get(id)).filter(it => it && (!it.backend || this.aprobado));
    }

    boton(it, clase) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = clase;
        b.dataset.acceso = it.id;
        if (it.controla) {
            b.setAttribute('aria-controls', it.controla);
            b.setAttribute('aria-expanded', 'false');
        }
        b.title = it.titulo;
        b.innerHTML = `${iconoSVG(it.icono)}<span>${it.titulo}</span><b class="chat-contador" hidden></b>`;
        b.addEventListener('click', () => { if (this.hojaMas.open) this.hojaMas.close(); it.alPulsar(); });
        return b;
    }

    pintar() {
        if (!this.montado) return;
        const visibles = this.visibles();
        // Los botones originales de Tareas y Chat quedan ocultos: los sustituyen los de la barra
        ['btn-tareas', 'btn-chat'].forEach(id => { const b = document.getElementById(id); if (b) b.hidden = true; });
        this.cabecera.innerHTML = '';
        visibles.forEach(it => this.cabecera.appendChild(this.boton(it, 'btn-chat btn-acceso')));
        this.barra.innerHTML = '';
        const enBarra = visibles.filter(it => Accesos.EN_BARRA.includes(it.id));
        const resto = visibles.filter(it => !Accesos.EN_BARRA.includes(it.id));
        enBarra.forEach(it => this.barra.appendChild(this.boton(it, 'barra-boton')));
        if (resto.length) {
            const mas = this.boton({ id: 'mas', titulo: 'Más', icono: 'mas', alPulsar: () => this.abrirMas(resto) }, 'barra-boton');
            this.barra.appendChild(mas);
        }
        this.pintarContadores();
    }

    // Contadores: mensajes 1 a 1 sin leer, avisos sin leer, tareas pendientes y chat sin leer
    pintarContadores() {
        const valores = {
            mensajes: this.contadores.mensajes,
            avisos: this.contadores.avisos,
            tareas: window.tareas && window.tareas.contador && !window.tareas.contador.hidden ? Number(window.tareas.contador.textContent) || 0 : 0,
            chat: window.equipo && window.equipo.contador && !window.equipo.contador.hidden ? Number(window.equipo.contador.textContent) || 0 : 0
        };
        document.querySelectorAll('[data-acceso]').forEach(b => {
            const n = valores[b.dataset.acceso] || 0;
            const c = b.querySelector('.chat-contador');
            if (!c) return;
            c.hidden = !n;
            c.textContent = n > 99 ? '99+' : String(n);
            const it = this.items.get(b.dataset.acceso);
            if (it) b.setAttribute('aria-label', n ? `${it.titulo} (${n} sin leer)` : it.titulo);
        });
        // "Abierto" en los botones que abren un panel (también si lo abrió otro botón)
        document.querySelectorAll('[data-acceso][aria-controls]').forEach(b => {
            const panel = document.getElementById(b.getAttribute('aria-controls'));
            if (panel) b.setAttribute('aria-expanded', String(!panel.hidden));
        });
        const mas = this.barra && this.barra.querySelector('[data-acceso="mas"] .chat-contador');
        if (mas) {
            const n = valores.chat;
            mas.hidden = !n;
            mas.textContent = String(n);
        }
    }

    alLatido(respuesta) {
        const avisosAntes = this.contadores.avisos;
        this.contadores.mensajes = Number(respuesta.sinLeer) || 0;
        this.contadores.avisos = Number(respuesta.avisosSinLeer) || 0;
        if (this.contadores.avisos > avisosAntes && !(this.campana && this.campana.abierto)) {
            this.aviso(`Tienes ${this.contadores.avisos} aviso${this.contadores.avisos === 1 ? '' : 's'} nuevo${this.contadores.avisos === 1 ? '' : 's'} (campana).`);
        }
        this.pintarContadores();
        if (this.mensajes && this.mensajes.abierto && !this.conversacionAbierta) this.pintarConversaciones();
    }

    // Tareas y chat cambian sus contadores por su cuenta: se copian cada pocos segundos
    vigilarContadores() {
        setInterval(() => this.pintarContadores(), 3000);
    }

    // ----- Hoja "Más" del teléfono -----
    crearHojaMas() {
        const d = document.createElement('dialog');
        d.className = 'dialogo hoja-mas';
        d.setAttribute('aria-label', 'Más accesos');
        d.innerHTML = '<div class="hoja-mas-lista"></div><button type="button" class="btn-secondary hoja-mas-cerrar">Cerrar</button>';
        d.querySelector('.hoja-mas-cerrar').addEventListener('click', () => d.close());
        d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
        document.body.appendChild(d);
        this.vigilarContadores();
        return d;
    }

    abrirMas(resto) {
        const lista = this.hojaMas.querySelector('.hoja-mas-lista');
        lista.innerHTML = '';
        resto.forEach(it => lista.appendChild(this.boton(it, 'hoja-mas-boton')));
        this.pintarContadores();
        this.hojaMas.showModal();
    }

    // ----- Campana -----
    static ICONO_AVISO = { mensaje: 'mensajes', cliente: 'equipo', tarea: 'tareas', reunion: 'video', germinador: 'invernadero', envio: 'paquete', instagram: 'camara', reporte: 'tareas', meta: 'metas', cotizacion: 'tareas', sistema: 'avisos' };

    async alternarCampana() {
        if (this.campana.abierto) return this.campana.cerrar();
        this.campana.abrir();
        this.campana.nota.textContent = 'Cargando…';
        const r = await this.google.enviar('avisos', {}, true);
        this.pintarCampana(r);
        // Al abrirla, lo nuevo pasa a leído (sigue resaltado hasta cerrar)
        if (r && r.ok && r.sinLeer) {
            this.google.enviar('avisos', { operacion: 'leer' }, true).then(() => {
                this.contadores.avisos = 0;
                this.pintarContadores();
            });
        }
    }

    pintarCampana(r) {
        const cuerpo = this.campana.cuerpo;
        cuerpo.innerHTML = '';
        if (!r || !r.ok) {
            this.campana.nota.textContent = (r && r.error) || 'No se pudieron cargar los avisos. Revisa la conexión.';
            return;
        }
        this.campana.nota.textContent = r.sinLeer ? `${r.sinLeer} nuevo${r.sinLeer === 1 ? '' : 's'}` : 'Todo al día';
        if (!r.avisos.length) {
            const p = document.createElement('p');
            p.className = 'dialogo-nota';
            p.textContent = 'Aquí llegará todo lo que te toque: mensajes, clientes que te pasen, tareas, reuniones, alertas del germinador, envíos y metas.';
            cuerpo.appendChild(p);
            return;
        }
        const ul = document.createElement('ul');
        ul.className = 'lista-acceso';
        r.avisos.forEach(a => {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `fila-acceso${a.leido ? '' : ' fila-nueva'}`;
            const icono = document.createElement('span');
            icono.className = 'fila-icono';
            icono.setAttribute('aria-hidden', 'true');
            icono.innerHTML = iconoSVG(Accesos.ICONO_AVISO[a.tipo] || 'avisos');
            const textos = document.createElement('span');
            textos.className = 'fila-textos';
            const t = document.createElement('span');
            t.className = 'fila-texto';
            t.textContent = a.texto;
            const cuando = document.createElement('span');
            cuando.className = 'fila-cuando';
            cuando.textContent = cuandoCorto(a.creado);
            textos.append(t, cuando);
            b.append(icono, textos);
            b.addEventListener('click', () => this.irAAviso(a));
            li.appendChild(b);
            if (a.enlace && /^https:\/\/meet\.google\.com\//.test(a.enlace)) {
                const meet = document.createElement('a');
                meet.className = 'btn-texto fila-enlace';
                meet.href = a.enlace;
                meet.target = '_blank';
                meet.rel = 'noopener';
                meet.textContent = 'Entrar a Meet';
                li.appendChild(meet);
            }
            ul.appendChild(li);
        });
        cuerpo.appendChild(ul);
    }

    // Cada aviso lleva a su sitio
    irAAviso(a) {
        this.campana.cerrar();
        const pestana = (m) => {
            const p = document.getElementById(`tab-${m}`);
            if (p && !p.hidden && window.crm && window.crm.activarPestana) window.crm.activarPestana(p);
        };
        const a2 = window.reporteSemanal;
        const destinos = {
            mensaje: async () => {
                const de = /^conversacion:(.+@.+)$/.exec(a.enlace || '');
                if (!this.mensajes.abierto) await this.alternarMensajes();
                if (de) this.abrirConversacion(de[1]);
            },
            cliente: () => pestana('clientes'),
            tarea: () => window.tareas && window.tareas.alternarPanel(true),
            reunion: () => window.reunionesMetas && window.reunionesMetas.abrirReuniones(),
            germinador: () => pestana('germinador'),
            envio: () => pestana('envios'),
            instagram: () => window.bandejaInstagram && window.bandejaInstagram.abrir(),
            reporte: () => {
                const amb = window.responsable && window.responsable.ambito;
                if (a2) (amb && (amb.master || amb.cargo === 'administrativo') ? a2.abrirEquipo() : a2.abrir());
            },
            meta: () => window.reunionesMetas && window.reunionesMetas.abrirMetas(),
            // Un flujo automático que falló (solo le llega al Master): se revisa en la Torre de control
            sistema: () => window.torreDeControl && window.torreDeControl.abrir()
        };
        (destinos[a.tipo] || (() => {}))();
    }

    // ----- Mensajes: chat general y conversaciones 1 a 1 -----
    async alternarMensajes() {
        if (this.mensajes.abierto) return this.mensajes.cerrar();
        this.mensajes.abrir();
        this.conversacionAbierta = null;
        await this.pintarConversaciones();
    }

    async pintarConversaciones() {
        this.conversacionAbierta = null;
        clearInterval(this.refrescoHilo);
        this.mensajes.titulo.textContent = 'Mensajes';
        this.mensajes.nota.textContent = 'Chat del equipo y conversaciones privadas';
        const r = await this.google.enviar('conversaciones', {}, true);
        if (this.conversacionAbierta) return; // Se abrió una conversación mientras cargaba
        const cuerpo = this.mensajes.cuerpo;
        cuerpo.innerHTML = '';
        const ul = document.createElement('ul');
        ul.className = 'lista-acceso';
        // El chat general, primero
        const general = document.createElement('li');
        const bg = document.createElement('button');
        bg.type = 'button';
        bg.className = 'fila-acceso';
        bg.innerHTML = `<span class="fila-icono" aria-hidden="true">${iconoSVG('chat', 'icono')}</span><span class="fila-textos"><span class="fila-texto"><strong>Chat del equipo</strong></span><span class="fila-cuando">Todo el equipo</span></span>`;
        bg.addEventListener('click', () => { this.mensajes.cerrar(); window.equipo && window.equipo.alternarPanel(true); });
        general.appendChild(bg);
        ul.appendChild(general);
        if (!r || !r.ok) {
            cuerpo.appendChild(ul);
            const p = document.createElement('p');
            p.className = 'form-error';
            p.textContent = (r && r.error) || 'No se pudieron cargar las conversaciones.';
            cuerpo.appendChild(p);
            return;
        }
        r.conversaciones.forEach(c => {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `fila-acceso${c.sinLeer ? ' fila-nueva' : ''}`;
            const avatar = document.createElement('span');
            avatar.className = 'fila-icono avatar-mini';
            avatar.textContent = (c.nombre || '?').trim().charAt(0).toUpperCase();
            const textos = document.createElement('span');
            textos.className = 'fila-textos';
            const nombre = document.createElement('strong');
            nombre.textContent = c.nombre;
            const ultimo = document.createElement('span');
            ultimo.className = 'fila-texto';
            // Un mensaje escrito por alguien no se traduce; los de la app ("Te pasó el cliente…") sí
            if (c.ultimo.tipo === 'mensaje') ultimo.translate = false;
            ultimo.textContent = `${c.ultimo.mio ? `${traducir('Tú')}: ` : ''}${c.ultimo.texto}`;
            const cuando = document.createElement('span');
            cuando.className = 'fila-cuando';
            cuando.textContent = `${cuandoCorto(c.ultimo.creado)}${c.sinLeer ? ` · ${c.sinLeer} sin leer` : ''}`;
            textos.append(nombre, ultimo, cuando);
            b.append(avatar, textos);
            b.addEventListener('click', () => this.abrirConversacion(c.email));
            li.appendChild(b);
            ul.appendChild(li);
        });
        cuerpo.appendChild(ul);

        // Conversación nueva con alguien del equipo (lista del tablero)
        const nueva = document.createElement('div');
        nueva.className = 'form-group';
        const id = 'mensajes-nueva';
        nueva.innerHTML = `<label for="${id}">Escribir a alguien del equipo</label><select id="${id}"><option value="">Elige a una persona</option></select>`;
        const select = nueva.querySelector('select');
        const equipo = ((window.tableroEquipo && window.tableroEquipo.equipo) || []).filter(p => !p.yo);
        equipo.forEach(p => {
            const o = document.createElement('option');
            o.value = p.email;
            o.textContent = p.nombre || p.email;
            select.appendChild(o);
        });
        select.addEventListener('change', () => { if (select.value) this.abrirConversacion(select.value); });
        cuerpo.appendChild(nueva);
    }

    async abrirConversacion(email) {
        this.conversacionAbierta = email;
        const r = await this.google.enviar('conversacion', { con: email }, true);
        if (this.conversacionAbierta !== email) return;
        const cuerpo = this.mensajes.cuerpo;
        if (!r || !r.ok) {
            this.aviso((r && r.error) || 'No se pudo abrir la conversación.', 'error');
            return this.pintarConversaciones();
        }
        const primeraVez = !cuerpo.querySelector('.hilo-acceso');
        this.mensajes.titulo.textContent = r.con.nombre;
        this.mensajes.nota.textContent = 'Conversación privada';
        let hilo = cuerpo.querySelector('.hilo-acceso');
        if (primeraVez) {
            cuerpo.innerHTML = '';
            const volver = document.createElement('button');
            volver.type = 'button';
            volver.className = 'btn-texto';
            volver.innerHTML = `${iconoSVG('volver', 'icono')} Todas las conversaciones`;
            volver.addEventListener('click', () => this.pintarConversaciones());
            hilo = document.createElement('ul');
            hilo.className = 'hilo-acceso';
            hilo.setAttribute('aria-live', 'polite');
            const form = document.createElement('form');
            form.className = 'hilo-form';
            form.innerHTML = `<label class="solo-lector" for="hilo-texto">Mensaje</label>
                <textarea id="hilo-texto" rows="2" maxlength="2000" placeholder="Escribe un mensaje"></textarea>
                <button type="submit" class="btn-primary">${iconoSVG('enviar', 'icono')}<span class="solo-lector">Enviar</span></button>`;
            const area = form.querySelector('textarea');
            area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const texto = area.value.trim();
                if (!texto) return;
                const boton = form.querySelector('button');
                boton.disabled = true;
                const enviado = await this.google.enviar('directo', { para: email, texto }, true);
                boton.disabled = false;
                if (!enviado || !enviado.ok) return this.aviso((enviado && enviado.error) || 'No se pudo enviar.', 'error');
                area.value = '';
                this.abrirConversacion(email);
            });
            cuerpo.append(volver, hilo, form);
            area.focus();
            clearInterval(this.refrescoHilo);
            this.refrescoHilo = setInterval(() => {
                if (this.mensajes.abierto && this.conversacionAbierta === email && !document.hidden) this.abrirConversacion(email);
            }, 8000);
        }
        hilo.innerHTML = '';
        if (!r.mensajes.length) {
            const li = document.createElement('li');
            li.className = 'dialogo-nota';
            li.textContent = `Todavía no hay mensajes con ${r.con.nombre}. Escribe el primero: le llega al momento.`;
            hilo.appendChild(li);
        }
        r.mensajes.forEach(m => {
            const li = document.createElement('li');
            li.className = `burbuja${m.mio ? ' burbuja-mia' : ''}`;
            const t = document.createElement('p');
            if (!m.tipo || m.tipo === 'mensaje') t.translate = false; // Lo escrito por la persona no se traduce
            t.textContent = m.texto;
            li.appendChild(t);
            if (m.enlace) {
                const a = document.createElement('a');
                a.href = m.enlace;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = 'Entrar a Meet';
                li.appendChild(a);
            }
            const pie = document.createElement('span');
            pie.textContent = `${cuandoCorto(m.creado)}${m.mio && m.leido ? ' · leído' : ''}`;
            li.appendChild(pie);
            hilo.appendChild(li);
        });
        hilo.scrollTop = hilo.scrollHeight;
        // Al abrir la conversación, lo suyo quedó leído: se actualiza el contador
        if (window.tableroEquipo) window.tableroEquipo.latido();
    }
}

window.accesos = new Accesos();
