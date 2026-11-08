/**
 * Chat con Borja dentro de la app (para quien no usa WhatsApp o va desde el iPhone por la PWA): las mismas órdenes
 * que por WhatsApp, atendidas por el servidor (servidor/src/borja.js) con los permisos de la persona:
 *   RESUMEN · LISTO 2 · VISITA Finca X (regular): nota · NOTA Finca X: texto
 * La conversación no se guarda en el dispositivo: lo que importa queda en el CRM (y en la auditoría).
 */
Object.assign(ICONOS, {
    borja: ['M12 8V4H8', 'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2']
});

class ChatBorja {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        this.enviando = false;
        window.addEventListener('load', () => setTimeout(() => {
            if (!window.accesos) return;
            this.panel = crearPanelLateral('panel-borja', 'Borja');
            this.panel.nota.textContent = 'Lo mismo que por WhatsApp: pídele tu resumen, marca pendientes, registra visitas y notas.';
            this.montar();
            window.accesos.registrar({ id: 'borja', titulo: 'Borja', icono: 'borja', controla: 'panel-borja', backend: true, alPulsar: () => this.alternar() });
        }));
    }

    montar() {
        const cuerpo = this.panel.cuerpo;
        cuerpo.classList.add('borja-chat');
        const atajos = document.createElement('div');
        atajos.className = 'borja-atajos';
        [['RESUMEN', 'Mi resumen'], ['AYUDA', 'Qué puedo pedir']].forEach(([orden, texto]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-secondary';
            b.textContent = texto;
            b.addEventListener('click', () => this.enviar(orden));
            atajos.appendChild(b);
        });
        this.lista = document.createElement('ol');
        this.lista.className = 'chat-mensajes';
        this.lista.setAttribute('aria-label', 'Conversación con Borja');
        this.lista.setAttribute('aria-live', 'polite');
        this.lista.tabIndex = 0;
        const form = document.createElement('form');
        form.className = 'chat-form';
        form.noValidate = true;
        form.innerHTML = `
            <div class="chat-escribir">
                <label class="solo-lector" for="borja-texto">Mensaje para Borja</label>
                <input id="borja-texto" type="text" autocomplete="off" maxlength="1500" placeholder="Ej.: LISTO 2 · NOTA Finca X: pidió precio">
                <button type="submit" class="btn-primary">Enviar</button>
            </div>`;
        this.entrada = form.querySelector('input');
        this.boton = form.querySelector('button');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const texto = this.entrada.value.trim();
            if (texto) this.enviar(texto);
        });
        cuerpo.append(atajos, this.lista, form);
        this.anotar('Borja', 'Hola, soy Borja. Escribe RESUMEN para ver tus pendientes de hoy numerados, o AYUDA para ver lo que puedo hacer.', false);
    }

    alternar() {
        if (this.panel.abierto) return this.panel.cerrar();
        this.panel.abrir();
        this.entrada.focus();
    }

    // Un mensaje en la conversación: el de la persona (propio) o el de Borja (texto del servidor, sin traducir aquí)
    anotar(autor, texto, propio) {
        const li = document.createElement('li');
        li.className = `chat-mensaje${propio ? ' chat-propio' : ''}`;
        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        const quien = document.createElement('strong');
        quien.textContent = autor;
        const hora = document.createElement('time');
        hora.textContent = new Date().toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
        meta.append(quien, hora);
        const p = document.createElement('p');
        p.className = 'chat-texto';
        p.textContent = texto;
        if (!propio) p.translate = false; // Lo que dice Borja ya llega en el idioma de la persona
        li.append(meta, p);
        this.lista.appendChild(li);
        this.lista.scrollTop = this.lista.scrollHeight;
    }

    async enviar(texto) {
        if (this.enviando) return;
        this.enviando = true;
        this.boton.disabled = true;
        this.anotar('Tú', texto, true);
        this.entrada.value = '';
        const r = await this.google.enviar('borja', { texto }, true);
        this.enviando = false;
        this.boton.disabled = false;
        this.anotar('Borja', r && r.ok ? (r.respuesta || 'Listo.') : ((r && r.error) || 'No pude contestarte ahora. Revisa la conexión.'), false);
        // Lo que Borja cambió (visitas, tareas, bitácora) llega a las tablas con la próxima sincronización
        if (r && r.ok && window.baseDatos && window.baseDatos.sincronizar) window.baseDatos.sincronizar();
        this.entrada.focus();
    }
}

window.chatBorja = new ChatBorja();
