/**
 * Agenda: la semana de la persona en un solo sitio.
 *
 * De la app (lo que ya está en el dispositivo, filtrado por el servidor según cargo, país y casa):
 * seguimientos y reuniones de clientes, reuniones del equipo, tareas pendientes (las suyas), llegadas de
 * envíos y trasplantes del germinador. Con el backend, además, los eventos de su Google Calendar (sin
 * repetir los que ya son reuniones de la app). Cada cosa abre su sitio: el expediente del cliente, las
 * tareas, la reunión, la pestaña de envíos o germinador, o el evento en Google Calendar.
 */
const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

class AgendaApp {
    constructor() {
        this.google = new GoogleWorkspaceConnector(CONFIG_GOOGLE);
        this.lunes = this.lunesDe(new Date());
        window.addEventListener('load', () => setTimeout(() => {
            this.panel = crearPanelLateral('panel-agenda', 'Agenda');
            this.panel.panel.classList.add('panel-ancho');
            window.accesos.registrar({ id: 'agenda', titulo: 'Agenda', icono: 'agenda', controla: 'panel-agenda', alPulsar: () => this.alternar() });
            if (window.baseDatos) window.baseDatos.alCambiar(() => { if (this.panel.abierto) this.pintar(); });
        }));
    }

    lunesDe(fecha) {
        const d = new Date(fecha);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return d;
    }

    iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    alternar() {
        if (this.panel.abierto) return this.panel.cerrar();
        this.lunes = this.lunesDe(new Date());
        this.panel.abrir();
        this.pintar();
    }

    get yo() {
        return (window.responsable && window.responsable.nombre || '').trim().toLowerCase();
    }

    // Todo lo de la app con fecha en la semana: { dia (AAAA-MM-DD), hora ('' = todo el día), tipo, titulo, detalle, abrir }
    itemsDeLaApp(desde, hasta) {
        const datos = (window.baseDatos && window.baseDatos.datos) || {};
        const enRango = (dia) => dia && dia >= desde && dia <= hasta;
        const items = [];
        const diaYHora = (valor) => {
            const f = new Date(valor);
            if (Number.isNaN(f.getTime())) return null;
            return { dia: this.iso(f), hora: f.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }), orden: f.getTime() };
        };
        const cliente = (id) => (datos.clientes || []).find(c => c.id === id);
        const abrirCliente = (id) => () => { this.panel.cerrar(); if (window.crm && cliente(id)) window.crm.abrirExpediente(id); };
        const pestana = (m) => () => {
            this.panel.cerrar();
            const p = document.getElementById(`tab-${m}`);
            if (p && window.crm) window.crm.activarPestana(p);
        };

        (datos.clientes || []).forEach(c => {
            if (enRango(c.seguimiento)) items.push({ dia: c.seguimiento, hora: '', tipo: 'seguimiento', titulo: `Seguimiento · ${c.nombre}`, detalle: c.ubicacion || '', abrir: abrirCliente(c.id) });
            const r = c.proximaReunion && diaYHora(c.proximaReunion);
            if (r && enRango(r.dia)) items.push({ ...r, tipo: 'reunion', titulo: `Reunión · ${c.nombre}`, detalle: 'Con el cliente', meet: c.reunionMeet || '', abrir: abrirCliente(c.id) });
        });
        (datos.reuniones || []).forEach(re => {
            const r = diaYHora(re.inicio);
            if (r && enRango(r.dia)) items.push({ ...r, tipo: 'reunion', titulo: re.titulo, detalle: `Con ${re.participantesTexto || 'el equipo'}`, meet: re.meet, eventoId: re.eventoId, abrir: () => { this.panel.cerrar(); window.reunionesMetas && window.reunionesMetas.abrirReuniones(re.id); } });
        });
        (datos.tareas || []).forEach(t => {
            if (t.hecha || !enRango(t.vence)) return;
            const para = String(t.para || '').trim().toLowerCase();
            if (para && para !== this.yo) return; // Las mías y las de todo el equipo (sin asignar)
            items.push({ dia: t.vence, hora: '', tipo: 'tarea', titulo: t.titulo, detalle: t.prioridad ? `Prioridad ${t.prioridad.toLowerCase()}` : '', abrir: () => { this.panel.cerrar(); window.tareas && window.tareas.alternarPanel(true); } });
        });
        (datos.envios || []).forEach(e => {
            if (e.estado === 'Entregado' || !enRango(e.eta)) return;
            items.push({ dia: e.eta, hora: '', tipo: 'envio', titulo: `Llega envío ${e.transportista || ''} ${e.guia || ''}`.replace(/\s+/g, ' ').trim(), detalle: [e.cliente || (cliente(e.clienteId) || {}).nombre, e.estado].filter(Boolean).join(' · '), abrir: pestana('envios') });
        });
        (datos.germinador || []).forEach(l => {
            if (['Despachado', 'Descartado'].includes(l.estado) || !enRango(l.trasplante)) return;
            items.push({ dia: l.trasplante, hora: '', tipo: 'germinador', titulo: `Trasplante · lote ${l.lote || ''}`, detalle: [l.variedad, l.cliente].filter(Boolean).join(' · '), abrir: pestana('germinador') });
        });
        return items;
    }

    async pintar() {
        const desde = this.iso(this.lunes);
        const domingo = new Date(this.lunes.getTime() + 6 * 86400000);
        const hasta = this.iso(domingo);
        const formato = (d) => d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
        this.panel.nota.textContent = `Semana del ${formato(this.lunes)} al ${formato(domingo)}`;
        const items = this.itemsDeLaApp(desde, hasta);
        this.dibujar(items, desde);

        // Google Calendar (solo con el backend): se añade cuando llega
        if (!this.google.conBackend || !(window.responsable && window.responsable.sesionBackend && window.responsable.sesionBackend())) return;
        const fin = new Date(domingo.getTime() + 86400000);
        const pedido = `${desde}`;
        this.pedido = pedido;
        const r = await this.google.enviar('agenda', { desde: this.lunes.toISOString(), hasta: fin.toISOString() }, true);
        if (this.pedido !== pedido || !this.panel.abierto) return;
        if (!r || !r.ok) {
            this.estadoGoogle = (r && r.error) || 'No se pudo leer tu Google Calendar.';
        } else if (!r.conectado) {
            this.estadoGoogle = 'Conecta tu cuenta de Google (menú › Cuenta) para ver aquí tu Google Calendar.';
        } else {
            this.estadoGoogle = '';
            const ids = new Set(items.map(i => i.eventoId).filter(Boolean));
            const meets = new Set(items.map(i => i.meet).filter(Boolean));
            r.eventos.filter(e => !ids.has(e.id) && !(e.meet && meets.has(e.meet))).forEach(e => {
                const todoElDia = e.todoElDia;
                const f = new Date(todoElDia ? `${e.inicio}T12:00:00` : e.inicio);
                const dia = todoElDia ? e.inicio.slice(0, 10) : this.iso(f);
                if (dia < desde || dia > hasta) return;
                items.push({
                    dia, hora: todoElDia ? '' : f.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }), orden: f.getTime(),
                    tipo: 'google', titulo: e.titulo, detalle: 'Google Calendar', meet: e.meet,
                    abrir: () => { if (e.enlace) window.open(e.enlace, '_blank', 'noopener'); }
                });
            });
        }
        this.dibujar(items, desde);
    }

    dibujar(items, desde) {
        const cuerpo = this.panel.cuerpo;
        cuerpo.innerHTML = '';
        // Navegación de semanas y nueva reunión
        const barra = document.createElement('div');
        barra.className = 'agenda-barra';
        const boton = (texto, clase, alPulsar, etiqueta) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = clase;
            b.textContent = texto;
            if (etiqueta) b.setAttribute('aria-label', etiqueta);
            b.addEventListener('click', alPulsar);
            barra.appendChild(b);
            return b;
        };
        boton('‹', 'btn-secondary', () => { this.lunes = new Date(this.lunes.getTime() - 7 * 86400000); this.pintar(); }, 'Semana anterior');
        boton('Hoy', 'btn-secondary', () => { this.lunes = this.lunesDe(new Date()); this.pintar(); });
        boton('›', 'btn-secondary', () => { this.lunes = new Date(this.lunes.getTime() + 7 * 86400000); this.pintar(); }, 'Semana siguiente');
        if (window.reunionesMetas && window.reunionesMetas.disponible) {
            boton('Nueva reunión', 'btn-primary', () => { this.panel.cerrar(); window.reunionesMetas.abrirReuniones(null, { nueva: true }); });
        }
        cuerpo.appendChild(barra);
        if (this.estadoGoogle) {
            const nota = document.createElement('p');
            nota.className = 'dialogo-nota';
            nota.textContent = this.estadoGoogle;
            cuerpo.appendChild(nota);
        }

        const hoy = this.iso(new Date());
        const semana = document.createElement('ol');
        semana.className = 'agenda-semana';
        for (let i = 0; i < 7; i++) {
            const d = new Date(this.lunes.getTime() + i * 86400000);
            const dia = this.iso(d);
            const delDia = items.filter(it => it.dia === dia).sort((a, b) => (a.hora ? 1 : 0) - (b.hora ? 1 : 0) || (a.orden || 0) - (b.orden || 0));
            const li = document.createElement('li');
            li.className = `agenda-dia${dia === hoy ? ' agenda-hoy' : ''}${delDia.length ? '' : ' agenda-vacio'}`;
            const h = document.createElement('h3');
            h.textContent = `${DIAS_SEMANA[i]} ${d.getDate()}${dia === hoy ? ' · hoy' : ''}`;
            li.appendChild(h);
            if (!delDia.length) {
                const p = document.createElement('p');
                p.className = 'nota-suave';
                p.textContent = 'Nada';
                li.appendChild(p);
            }
            const ul = document.createElement('ul');
            delDia.forEach(it => {
                const fila = document.createElement('li');
                fila.className = `agenda-item agenda-${it.tipo}`;
                const b = document.createElement('button');
                b.type = 'button';
                const hora = document.createElement('span');
                hora.className = 'agenda-hora';
                hora.textContent = it.hora || 'Todo el día';
                const titulo = document.createElement('strong');
                titulo.textContent = it.titulo;
                const detalle = document.createElement('span');
                detalle.className = 'agenda-detalle';
                detalle.textContent = it.detalle || '';
                b.append(hora, titulo, detalle);
                b.addEventListener('click', it.abrir);
                fila.appendChild(b);
                if (it.meet) {
                    const a = document.createElement('a');
                    a.href = it.meet;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.className = 'btn-texto agenda-meet';
                    a.textContent = 'Meet';
                    a.setAttribute('aria-label', `Entrar a Meet: ${it.titulo}`);
                    fila.appendChild(a);
                }
                ul.appendChild(fila);
            });
            li.appendChild(ul);
            semana.appendChild(li);
        }
        cuerpo.appendChild(semana);

        // Leyenda de colores (con texto: no solo color)
        const leyenda = document.createElement('p');
        leyenda.className = 'agenda-leyenda';
        [['seguimiento', 'Seguimiento'], ['reunion', 'Reunión'], ['tarea', 'Tarea'], ['envio', 'Envío'], ['germinador', 'Trasplante'], ['google', 'Google Calendar']].forEach(([t, nombre]) => {
            const s = document.createElement('span');
            s.className = `agenda-clave agenda-${t}`;
            s.textContent = nombre;
            leyenda.appendChild(s);
        });
        cuerpo.appendChild(leyenda);
    }
}

window.agendaApp = new AgendaApp();
