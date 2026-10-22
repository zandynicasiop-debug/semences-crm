/**
 * Comunicación del equipo: chat operativo y botón "Notificar al equipo".
 *
 * Los mensajes y las alertas se guardan en la base compartida (módulo "mensajes" de la hoja), así
 * que todo el equipo los lee dentro de la app. Además cada uno se replica en el espacio de Google
 * Chat (el webhook solo envía: lo que se escriba directamente en Google Chat no vuelve a la app).
 */

Object.assign(ICONOS, {
    video: ['m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5', 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z'],
    chat: ['M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719'],
    enviar: ['M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'm21.854 2.147-10.94 10.939'],
    alerta: ['M7 18v-6a5 5 0 1 1 10 0v6', 'M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z', 'M21 12h1', 'M18.5 4.5 18 5', 'M2 12h1', 'M12 2v1', 'm4.929 4.929.707.707', 'M12 12v6']
});

const MOTIVOS_ALERTA = [
    'Plagas o enfermedades',
    'Falla de riego',
    'Clima adverso',
    'Cosecha urgente',
    'Problema con un tractor',
    'Seguridad',
    'Otro'
];

const MAX_MENSAJES_VISIBLES = 60;

class CanalEquipo {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.db = window.baseDatos;
        this.google = dashboard.google;
        this.vistos = new Set(this.leer('sdc_mensajes_vistos', []));
        this.primeraCarga = true;

        this.crearBotonChat();
        this.crearPanelChat();
        // El nombre es el del responsable (usuario.js): si cambia allí, cambia la firma
        window.responsable.alCambiar(() => this.pintarFirma());
        this.crearBotonAlerta();
        this.crearDialogoAlerta();
        this.crearAviso();
        this.pintar();

        this.db.alCambiar((motivo) => {
            if (motivo === 'sincronizado' || motivo === 'local') this.pintar();
        });
    }

    leer(clave, defecto) {
        try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch (e) { return defecto; }
    }

    escribir(clave, valor) {
        try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* sin almacenamiento */ }
    }

    get nombre() {
        return this.leer('sdc_nombre', '');
    }

    mensajes() {
        return [...this.db.datos.mensajes].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    }

    // ----- Botón del chat en la barra superior, con contador de mensajes sin leer -----
    crearBotonChat() {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'btn-chat';
        boton.className = 'btn-chat';
        boton.setAttribute('aria-expanded', 'false');
        boton.setAttribute('aria-controls', 'panel-chat');
        boton.innerHTML = `${iconoSVG('chat')}<span>Chat del equipo</span><b class="chat-contador" hidden></b>`;
        boton.addEventListener('click', () => this.alternarPanel());
        document.getElementById('app-nav').appendChild(boton);
        this.botonChat = boton;
        this.contador = boton.querySelector('.chat-contador');
    }

    // ----- Panel lateral del chat -----
    crearPanelChat() {
        const panel = document.createElement('aside');
        panel.id = 'panel-chat';
        panel.className = 'panel-chat';
        panel.setAttribute('aria-labelledby', 'panel-chat-titulo');
        panel.hidden = true;
        panel.innerHTML = `
            <div class="panel-chat-cabecera">
                <div>
                    <h2 id="panel-chat-titulo">Chat del equipo</h2>
                    <p class="panel-chat-nota"></p>
                </div>
                <div class="panel-chat-acciones">
                    <button type="button" class="btn-secondary chat-meet">${iconoSVG('video')}<span>Videollamada</span></button>
                    <button type="button" class="btn-texto panel-chat-cerrar">Cerrar</button>
                </div>
            </div>
            <ol class="chat-mensajes" aria-label="Mensajes" tabindex="0"></ol>
            <form class="chat-form" novalidate>
                <div class="chat-nombre">
                    <label for="chat-nombre-input">Tu nombre</label>
                    <input id="chat-nombre-input" type="text" autocomplete="name" placeholder="Así te verá el equipo">
                </div>
                <p class="chat-firma" hidden></p>
                <div class="chat-escribir">
                    <label class="solo-lector" for="chat-texto">Mensaje para el equipo</label>
                    <input id="chat-texto" type="text" placeholder="Escribe un mensaje para el equipo" autocomplete="off" aria-describedby="chat-error">
                    <button type="submit" class="btn-primary" aria-label="Enviar mensaje">${iconoSVG('enviar')}</button>
                </div>
                <p class="form-error" id="chat-error" hidden></p>
            </form>`;
        document.body.appendChild(panel);
        this.panel = panel;
        this.lista = panel.querySelector('.chat-mensajes');
        this.form = panel.querySelector('.chat-form');
        this.inputNombre = panel.querySelector('#chat-nombre-input');
        this.inputTexto = panel.querySelector('#chat-texto');
        this.error = panel.querySelector('#chat-error');
        this.firma = panel.querySelector('.chat-firma');

        panel.querySelector('.panel-chat-cerrar').addEventListener('click', () => this.alternarPanel(false));
        this.botonMeet = panel.querySelector('.chat-meet');
        this.botonMeet.addEventListener('click', () => this.crearVideollamada());
        panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.alternarPanel(false); });
        this.inputTexto.addEventListener('input', () => { this.error.hidden = true; });
        this.inputNombre.addEventListener('input', () => { this.error.hidden = true; });
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.enviarMensaje();
        });
        this.pintarFirma();
    }

    // El nombre se pide una vez y se recuerda en este navegador
    pintarFirma() {
        const nombre = this.nombre;
        this.form.querySelector('.chat-nombre').hidden = Boolean(nombre);
        this.firma.hidden = !nombre;
        if (nombre) {
            this.firma.innerHTML = '';
            this.firma.append(`Escribes como ${nombre} · `);
            const cambiar = document.createElement('button');
            cambiar.type = 'button';
            cambiar.className = 'enlace-cliente';
            cambiar.textContent = 'cambiar';
            cambiar.addEventListener('click', () => window.responsable.pedir());
            this.firma.appendChild(cambiar);
        }
    }

    alternarPanel(abrir = this.panel.hidden) {
        // Un panel lateral a la vez: si las tareas están abiertas, se cierran
        if (abrir && window.tareas && !window.tareas.panel.hidden) window.tareas.panel.hidden = true;
        this.panel.hidden = !abrir;
        this.botonChat.setAttribute('aria-expanded', String(abrir));
        if (abrir) {
            this.marcarVistos();
            this.lista.scrollTop = this.lista.scrollHeight;
            (this.nombre ? this.inputTexto : this.inputNombre).focus();
        } else {
            this.botonChat.focus();
        }
    }

    marcarVistos() {
        this.db.datos.mensajes.forEach(m => this.vistos.add(m.id));
        this.escribir('sdc_mensajes_vistos', [...this.vistos].slice(-500));
        this.pintarContador();
    }

    pintarContador() {
        const sinLeer = this.db.datos.mensajes.filter(m => !this.vistos.has(m.id) && m.autorId !== this.idDispositivo()).length;
        this.contador.hidden = sinLeer === 0;
        this.contador.textContent = sinLeer > 9 ? '9+' : String(sinLeer);
        this.botonChat.setAttribute('aria-label', sinLeer ? `Chat del equipo, ${sinLeer} sin leer` : 'Chat del equipo');
    }

    // Identifica los mensajes de este navegador (para no avisar de los propios)
    idDispositivo() {
        let id = this.leer('sdc_dispositivo', '');
        if (!id) {
            id = nuevoId();
            this.escribir('sdc_dispositivo', id);
        }
        return id;
    }

    pintar() {
        const nota = this.panel.querySelector('.panel-chat-nota');
        nota.textContent = this.db.compartida
            ? 'Lo ve todo el equipo y se copia en el espacio de Google Chat.'
            : 'Solo en este navegador: configura la URL de Google en googleSync.js para compartirlo.';

        const todos = this.mensajes();
        const visibles = todos.slice(-MAX_MENSAJES_VISIBLES);
        const abajo = this.lista.scrollHeight - this.lista.scrollTop - this.lista.clientHeight < 40;
        this.lista.innerHTML = '';
        if (!visibles.length) {
            const li = document.createElement('li');
            li.className = 'chat-vacio';
            li.textContent = 'Todavía no hay mensajes. Escribe el primero.';
            this.lista.appendChild(li);
        }
        const mio = this.idDispositivo();
        visibles.forEach(m => {
            const li = document.createElement('li');
            li.className = 'chat-mensaje';
            if (m.tipo === 'alerta') li.classList.add('chat-alerta');
            if (m.autorId === mio) li.classList.add('chat-propio');
            const cab = document.createElement('div');
            cab.className = 'chat-meta';
            const autor = document.createElement('strong');
            autor.textContent = m.autor || 'Sin nombre';
            const hora = document.createElement('time');
            hora.dateTime = m.fecha;
            hora.textContent = this.formatearHora(m.fecha);
            cab.append(autor, hora);
            li.appendChild(cab);
            if (m.tipo === 'alerta') {
                const etiqueta = document.createElement('p');
                etiqueta.className = 'chat-alerta-motivo';
                etiqueta.innerHTML = iconoSVG('alerta');
                etiqueta.append(`Alerta · ${m.motivo}${m.parcela ? ` · ${m.parcela}` : ''}`);
                li.appendChild(etiqueta);
            }
            if (m.tipo === 'meet' && /^https:\/\/meet\.google\.com\//.test(m.enlace || '')) {
                // Videollamada: enlace para unirse (solo direcciones de Meet)
                const p = document.createElement('p');
                p.className = 'chat-texto chat-meet-enlace';
                p.innerHTML = iconoSVG('video');
                const a = document.createElement('a');
                a.href = m.enlace;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = 'Unirse a la videollamada';
                p.append(a);
                li.appendChild(p);
            } else if (m.texto) {
                const p = document.createElement('p');
                p.className = 'chat-texto';
                p.textContent = m.texto;
                li.appendChild(p);
            }
            this.lista.appendChild(li);
        });
        if (abajo || !this.panel.hidden) this.lista.scrollTop = this.lista.scrollHeight;

        // Avisar de alertas nuevas de otras personas (no en la primera carga: serían todas "nuevas")
        if (!this.primeraCarga) {
            todos.filter(m => m.tipo === 'alerta' && m.autorId !== mio && !this.vistos.has(m.id) && !this.avisadas?.has(m.id))
                .forEach(m => {
                    this.avisadas = this.avisadas || new Set();
                    this.avisadas.add(m.id);
                    this.mostrarAviso(`Alerta de ${m.autor}: ${m.motivo}${m.parcela ? ` en ${m.parcela}` : ''}`, 'alerta');
                    if (this.google) this.google.enviarNotificacionMovil(`Alerta · ${m.motivo}`, `${m.autor}${m.parcela ? ` · ${m.parcela}` : ''}${m.texto ? `: ${m.texto}` : ''}`);
                });
        }
        if (this.db.ultimaSincronizacion || !this.db.compartida) this.primeraCarga = false;

        if (!this.panel.hidden) this.marcarVistos();
        else this.pintarContador();
    }

    formatearHora(iso) {
        const f = new Date(iso);
        if (Number.isNaN(f.getTime())) return '';
        const hoy = new Date();
        const mismoDia = f.toDateString() === hoy.toDateString();
        return mismoDia
            ? f.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })
            : f.toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    }

    // Guarda el nombre si hacía falta; devuelve false si falta
    asegurarNombre() {
        if (this.nombre) return true;
        const nombre = this.inputNombre.value.trim();
        if (!nombre) return false;
        this.escribir('sdc_nombre', nombre);
        this.pintarFirma();
        return true;
    }

    mostrarError(texto, campo) {
        this.error.textContent = texto;
        this.error.hidden = false;
        campo.focus();
    }

    enviarMensaje() {
        if (!this.asegurarNombre()) return this.mostrarError('Escribe tu nombre para que el equipo sepa quién escribe.', this.inputNombre);
        const texto = this.inputTexto.value.trim();
        if (!texto) return this.mostrarError('Escribe un mensaje.', this.inputTexto);
        const mensaje = {
            id: nuevoId(),
            tipo: 'mensaje',
            autor: this.nombre,
            autorId: this.idDispositivo(),
            texto: texto.slice(0, 1000),
            fecha: new Date().toISOString()
        };
        this.db.guardar('mensajes', mensaje);
        this.vistos.add(mensaje.id);
        if (this.google) this.google.enviarGoogleChat(`💬 ${mensaje.autor}: ${mensaje.texto}`);
        this.inputTexto.value = '';
        this.inputTexto.focus();
    }

    // Crea una reunión de Meet real (Calendar del Apps Script) y deja el enlace en el chat y en Google Chat
    async crearVideollamada() {
        if (!this.asegurarNombre()) return this.mostrarError('Escribe tu nombre para que el equipo sepa quién llama.', this.inputNombre);
        if (!this.google || !this.google.activo) {
            this.mostrarAviso('Para crear videollamadas hace falta conectar el Apps Script de Google (ver DESPLIEGUE.md).', 'alerta');
            return;
        }
        const etiqueta = this.botonMeet.querySelector('span');
        this.botonMeet.disabled = true;
        etiqueta.textContent = 'Creando…';
        const enlace = await this.google.crearReunionMeet(`Reunión del equipo · ${this.nombre}`);
        this.botonMeet.disabled = false;
        etiqueta.textContent = 'Videollamada';
        if (!enlace) {
            this.mostrarAviso('No se pudo crear la reunión. Revisa que el Apps Script tenga Calendar activado.', 'alerta');
            return;
        }
        const mensaje = {
            id: nuevoId(),
            tipo: 'meet',
            autor: this.nombre,
            autorId: this.idDispositivo(),
            texto: `Videollamada de Meet: ${enlace}`,
            enlace,
            fecha: new Date().toISOString()
        };
        this.db.guardar('mensajes', mensaje);
        this.vistos.add(mensaje.id);
        this.google.enviarGoogleChat(`📹 ${mensaje.autor} abrió una videollamada de Meet: ${enlace}`);
        window.open(enlace, '_blank', 'noopener');
    }

    // ----- Botón "Notificar al equipo" junto al de clima -----
    crearBotonAlerta() {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'btn-alerta-equipo';
        boton.className = 'btn-alerta';
        boton.innerHTML = `${iconoSVG('alerta')}<span>Notificar al equipo</span>`;
        boton.addEventListener('click', () => this.abrirAlerta());
        const clima = document.getElementById('btn-toggle-clima');
        const acciones = document.createElement('div');
        acciones.className = 'acciones-cabecera';
        clima.replaceWith(acciones);
        acciones.append(clima, boton);
    }

    crearDialogoAlerta() {
        const dialogo = document.createElement('dialog');
        dialogo.className = 'dialogo';
        dialogo.setAttribute('aria-labelledby', 'alerta-titulo');
        const parcelas = [
            'Toda la finca',
            ...this.dashboard.cultivos.map(c => `${c.nombre} (${c.tipo === 'invernadero' ? 'invernadero' : 'campo abierto'})`),
            'Parcela libre', 'Germinador', 'Cuarto de riego', 'Almacén y empaque', 'Almacén de agroquímicos', 'Oficinas'
        ];
        dialogo.innerHTML = `
            <form class="dialogo-form" novalidate>
                <h3 id="alerta-titulo">Notificar al equipo</h3>
                <p class="module-nota">Se avisa en la app, en el espacio de Google Chat y en los dispositivos con avisos activados.</p>
                <div class="form-group alerta-nombre">
                    <label for="alerta-nombre">Tu nombre</label>
                    <input id="alerta-nombre" type="text" autocomplete="name" aria-describedby="alerta-nombre-error">
                    <p class="form-error" id="alerta-nombre-error" hidden></p>
                </div>
                <div class="form-group">
                    <label for="alerta-motivo">Motivo</label>
                    <select id="alerta-motivo">${MOTIVOS_ALERTA.map(m => `<option>${m}</option>`).join('')}</select>
                </div>
                <div class="form-group">
                    <label for="alerta-parcela">Dónde</label>
                    <select id="alerta-parcela">${parcelas.map(p => `<option>${p}</option>`).join('')}</select>
                </div>
                <div class="form-group">
                    <label for="alerta-detalle">Qué pasa y qué hace falta</label>
                    <textarea id="alerta-detalle" rows="3" aria-describedby="alerta-detalle-error" placeholder="Mosca blanca en la hilera 2, hace falta revisar hoy"></textarea>
                    <p class="form-error" id="alerta-detalle-error" hidden></p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary alerta-cancelar">Cancelar</button>
                    <button type="submit" class="btn-alerta">${iconoSVG('alerta')}<span>Enviar alerta</span></button>
                </div>
            </form>`;
        document.body.appendChild(dialogo);
        this.dialogoAlerta = dialogo;
        const form = dialogo.querySelector('form');
        dialogo.querySelector('.alerta-cancelar').addEventListener('click', () => dialogo.close());
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.enviarAlerta(form);
        });
        form.querySelectorAll('input, textarea').forEach(c => c.addEventListener('input', () => {
            const err = document.getElementById(`${c.id}-error`);
            if (err) err.hidden = true;
            c.removeAttribute('aria-invalid');
        }));
    }

    abrirAlerta() {
        const form = this.dialogoAlerta.querySelector('form');
        form.reset();
        form.querySelector('.alerta-nombre').hidden = Boolean(this.nombre);
        this.dialogoAlerta.showModal();
        (this.nombre ? form.querySelector('#alerta-motivo') : form.querySelector('#alerta-nombre')).focus();
    }

    enviarAlerta(form) {
        const error = (id, texto) => {
            const campo = form.querySelector(`#${id}`);
            const p = form.querySelector(`#${id}-error`);
            p.textContent = texto;
            p.hidden = false;
            campo.setAttribute('aria-invalid', 'true');
            campo.focus();
        };
        if (!this.nombre) {
            const nombre = form.querySelector('#alerta-nombre').value.trim();
            if (!nombre) return error('alerta-nombre', 'Escribe tu nombre para que el equipo sepa quién avisa.');
            this.escribir('sdc_nombre', nombre);
            this.pintarFirma();
        }
        const detalle = form.querySelector('#alerta-detalle').value.trim();
        if (!detalle) return error('alerta-detalle', 'Cuenta en una frase qué pasa, para que el equipo sepa cómo actuar.');

        const alerta = {
            id: nuevoId(),
            tipo: 'alerta',
            autor: this.nombre,
            autorId: this.idDispositivo(),
            motivo: form.querySelector('#alerta-motivo').value,
            parcela: form.querySelector('#alerta-parcela').value,
            texto: detalle.slice(0, 1000),
            fecha: new Date().toISOString()
        };
        this.db.guardar('mensajes', alerta);
        this.vistos.add(alerta.id);
        if (this.google) {
            this.google.enviarGoogleChat(`🚨 ALERTA · ${alerta.motivo} · ${alerta.parcela}\n${alerta.texto}\n— ${alerta.autor}`);
            this.google.enviarNotificacionMovil(`Alerta · ${alerta.motivo}`, `${alerta.parcela}: ${alerta.texto}`);
        }
        this.dialogoAlerta.close();
        this.mostrarAviso(this.db.compartida
            ? 'Alerta enviada al equipo y a Google Chat.'
            : 'Alerta guardada solo en este navegador: falta la URL de Google para avisar al equipo.',
        this.db.compartida ? 'ok' : 'error');
    }

    // ----- Aviso breve en pantalla (sustituye a alert()) -----
    crearAviso() {
        this.aviso = document.createElement('div');
        this.aviso.className = 'aviso-flotante';
        this.aviso.setAttribute('role', 'status');
        this.aviso.hidden = true;
        document.body.appendChild(this.aviso);
    }

    mostrarAviso(texto, tipo = 'ok') {
        this.aviso.textContent = texto;
        this.aviso.dataset.tipo = tipo;
        this.aviso.hidden = false;
        clearTimeout(this.temporizadorAviso);
        this.temporizadorAviso = setTimeout(() => { this.aviso.hidden = true; }, 5000);
    }
}

window.addEventListener('load', () => {
    if (window.appDashboard) window.equipo = new CanalEquipo(window.appDashboard);
});
