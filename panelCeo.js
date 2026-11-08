/**
 * Torre de control del Master (Lote B): menú del logo › Torre de control. Solo aparece para los Master y con el
 * backend (acción "panelCeo"; el servidor rechaza a cualquier otro). Cuatro tarjetas:
 * - Pendientes del equipo: quién tiene cotizaciones y pedidos sin cerrar (US$), clientes en Reunión, tareas vencidas
 *   o el reporte semanal bloqueado (423), con "Revisión por Meet" en 1 clic.
 * - Briefings: el resumen de las 7:00 de cada persona (si salió, por dónde y, en WhatsApp, si se entregó y se leyó),
 *   y volver a enviarlo ahora a RD, VE o todos.
 * - Borja: qué secciones lleva el resumen y el resumen global de RD y VE, en 1 clic.
 * - Mensajes: texto, asunto y hora de los mensajes automáticos, con sus variables, y la plantilla de WhatsApp
 *   (solo entre las aprobadas en Meta).
 * Todo con DOM (sin innerHTML con datos): los nombres y textos del equipo nunca se interpretan como HTML.
 */
const NOMBRE_CARGO_TORRE = { vendedor: 'Vendedor', tecnico: 'Técnico', plantulador: 'Plantulador', administrativo: 'Administrativo', master: 'Master' };
const PESTANAS_TORRE = [['radar', 'Pendientes del equipo'], ['briefings', 'Briefings'], ['borja', 'Borja'], ['mensajes', 'Mensajes']];
const NOMBRE_CANAL_TORRE = { whatsapp: 'WhatsApp', push: 'push', correo: 'correo' };
const canalesTorre = (texto) => String(texto || '').split('+').filter(Boolean).map(c => NOMBRE_CANAL_TORRE[c] || c).join(' + ');

class TorreDeControl {
    constructor() {
        window.addEventListener('sdc-ambito', () => this.crearOpcion());
        window.addEventListener('load', () => setTimeout(() => this.crearOpcion()));
    }

    get esMaster() {
        const a = window.responsable && window.responsable.ambito;
        return Boolean(a && a.master);
    }

    get google() {
        return window.crm && window.crm.google;
    }

    crearOpcion() {
        const lista = document.getElementById('lista-app');
        if (!lista || this.opcion || !this.esMaster || !(this.google && this.google.conBackend)) return;
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.id = 'menu-torre';
        boton.className = 'menu-extra';
        boton.textContent = 'Torre de control';
        boton.addEventListener('click', () => {
            lista.hidden = true;
            document.getElementById('btn-app').setAttribute('aria-expanded', 'false');
            this.abrir();
        });
        const primera = lista.querySelector('.menu-extra');
        if (primera) primera.before(boton);
        else lista.appendChild(boton);
        this.opcion = boton;
    }

    async pedir(datos) {
        const r = await this.google.enviar('panelCeo', datos, true).catch(() => null);
        if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo conectar con el servidor.');
        return r;
    }

    // ----- Estructura -----
    crearDialogo() {
        const d = document.createElement('dialog');
        d.className = 'dialogo dialogo-indicadores dialogo-torre';
        d.setAttribute('aria-labelledby', 'torre-titulo');
        const marco = document.createElement('div');
        marco.className = 'dialogo-form';
        const cabecera = document.createElement('div');
        cabecera.className = 'tablero-cabecera';
        const textos = document.createElement('div');
        const titulo = document.createElement('h3');
        titulo.id = 'torre-titulo';
        titulo.textContent = 'Torre de control';
        const sub = document.createElement('p');
        sub.className = 'dialogo-subtitulo';
        sub.textContent = 'Solo para el Master: todo el equipo, en RD y Venezuela';
        textos.append(titulo, sub);
        const cerrar = document.createElement('button');
        cerrar.type = 'button';
        cerrar.className = 'btn-texto';
        cerrar.textContent = 'Cerrar';
        cerrar.addEventListener('click', () => d.close());
        cabecera.append(textos, cerrar);
        const pestanas = document.createElement('div');
        pestanas.className = 'torre-pestanas';
        pestanas.setAttribute('role', 'group');
        pestanas.setAttribute('aria-label', 'Secciones de la Torre de control');
        this.botones = {};
        PESTANAS_TORRE.forEach(([id, texto]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-secondary';
            b.textContent = texto;
            b.addEventListener('click', () => this.mostrar(id));
            this.botones[id] = b;
            pestanas.appendChild(b);
        });
        this.contenido = document.createElement('div');
        this.contenido.className = 'torre-contenido';
        this.contenido.setAttribute('aria-live', 'polite');
        marco.append(cabecera, pestanas, this.contenido);
        d.appendChild(marco);
        document.body.appendChild(d);
        this.dialogo = d;
    }

    abrir() {
        if (!this.dialogo) this.crearDialogo();
        if (!this.dialogo.open) this.dialogo.showModal();
        this.mostrar(this.actual || 'radar');
    }

    async mostrar(id) {
        this.actual = id;
        Object.entries(this.botones).forEach(([clave, b]) => b.setAttribute('aria-pressed', String(clave === id)));
        this.contenido.replaceChildren(this.nota('Cargando…'));
        try {
            const pintar = { radar: () => this.pintarRadar(), briefings: () => this.pintarBriefings(), borja: () => this.pintarBorja(), mensajes: () => this.pintarMensajes() }[id];
            await pintar();
        } catch (error) {
            this.contenido.replaceChildren(this.nota(error.message, 'form-error'));
        }
    }

    // ----- Piezas -----
    nota(texto, clase = 'dialogo-nota') {
        const p = document.createElement('p');
        p.className = clase;
        p.textContent = texto;
        return p;
    }

    tabla(cabeceras, filas) {
        const envoltura = document.createElement('div');
        envoltura.className = 'torre-tabla';
        const t = document.createElement('table');
        const tr = document.createElement('tr');
        cabeceras.forEach(c => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = c; tr.appendChild(th); });
        t.appendChild(tr);
        filas.forEach(celdas => {
            const fila = document.createElement('tr');
            celdas.forEach(c => {
                const td = document.createElement('td');
                if (c instanceof Node) td.appendChild(c);
                else td.textContent = c === undefined || c === null || c === '' ? '—' : String(c);
                fila.appendChild(td);
            });
            t.appendChild(fila);
        });
        envoltura.appendChild(t);
        return envoltura;
    }

    boton(texto, clase, alPulsar) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = clase;
        b.textContent = texto;
        b.addEventListener('click', alPulsar);
        return b;
    }

    static usd(n) {
        return `US$ ${Math.round(Number(n) || 0).toLocaleString(LOCALE)}`;
    }

    static hora(iso) {
        return iso ? new Date(iso).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }) : '';
    }

    // ----- 1. Pendientes del equipo -----
    async pintarRadar() {
        const r = await this.pedir({ operacion: 'radar' });
        const filas = r.personas.map(p => {
            const estado = document.createElement('span');
            const meet = this.boton('Revisión por Meet', 'btn-texto', async () => {
                meet.disabled = true;
                estado.textContent = 'Buscando hueco en tu agenda…';
                try {
                    const x = await this.pedir({ operacion: 'revision', email: p.email });
                    const cuando = new Date(x.inicio).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
                    estado.replaceChildren(document.createTextNode(`Agendada: ${cuando}`));
                    if (x.meet) {
                        const a = document.createElement('a');
                        a.href = x.meet;
                        a.target = '_blank';
                        a.rel = 'noopener';
                        a.textContent = ' · Meet';
                        estado.appendChild(a);
                    }
                } catch (error) {
                    estado.textContent = error.message;
                    meet.disabled = false;
                }
            });
            meet.setAttribute('aria-label', `Agendar una revisión por Meet con ${p.nombre}`);
            const accion = document.createElement('div');
            accion.className = 'torre-accion';
            accion.append(meet, estado);
            return [
                p.nombre,
                `${NOMBRE_CARGO_TORRE[p.cargo] || p.cargo || ''} · ${(p.paises || []).join(', ')}`,
                p.cotizaciones.n ? `${p.cotizaciones.n} · ${TorreDeControl.usd(p.cotizaciones.usd)}` : '0',
                p.pedidos.n ? `${p.pedidos.n} · ${TorreDeControl.usd(p.pedidos.usd)}` : '0',
                p.reuniones,
                p.tareasVencidas,
                p.reporteBloqueado ? `Bloqueado (${p.reporteBloqueado})` : 'Al día',
                accion
            ];
        });
        this.contenido.replaceChildren(
            this.nota('De más a menos pendientes. "Revisión por Meet" busca el primer hueco libre de tu agenda y le manda la invitación con su lista de pendientes.'),
            r.personas.length
                ? this.tabla(['Persona', 'Cargo · país', 'Cotizaciones abiertas', 'Pedidos por cerrar', 'Clientes en Reunión', 'Tareas vencidas', 'Reporte semanal', ''], filas)
                : this.nota('Todavía no hay nadie aprobado en el equipo.')
        );
    }

    // ----- 2. Briefings -----
    async pintarBriefings() {
        const r = await this.pedir({ operacion: 'briefings' });
        const estadoWhatsapp = (p) => {
            const w = p.entregas.filter(e => e.canal === 'whatsapp').at(-1);
            if (!w) return '';
            if (w.estado === 'fallido') return `Falló: ${w.error || 'sin motivo'}`;
            if (w.leido) return `Leído ${TorreDeControl.hora(w.leido)}`;
            if (w.entregado) return `Entregado ${TorreDeControl.hora(w.entregado)}`;
            if (w.estado === 'enviado') return `Enviado ${TorreDeControl.hora(w.enviado)}`;
            return 'En cola';
        };
        const filas = r.personas.map(p => [
            p.nombre,
            (p.paises || []).join(', '),
            !p.activo ? 'Lo desactivó' : p.hoyEnviado ? `Enviado ${TorreDeControl.hora(p.enviado)} · ${canalesTorre(p.canal)}` : 'Aún no',
            estadoWhatsapp(p),
            p.entregas.filter(e => e.canal === 'push').length ? 'Sí' : ''
        ]);
        const acciones = document.createElement('div');
        acciones.className = 'torre-botones';
        const resultado = this.nota('');
        [['RD', 'Volver a enviar ahora: RD'], ['VE', 'Volver a enviar ahora: VE'], ['todos', 'Volver a enviar ahora: todos']].forEach(([pais, texto]) => {
            acciones.appendChild(this.boton(texto, 'btn-secondary', async (e) => {
                e.target.disabled = true;
                resultado.textContent = 'Enviando…';
                try {
                    const x = await this.pedir({ operacion: 'reenviar', pais });
                    resultado.textContent = `Enviado a ${x.enviados} de ${x.personas.length}.`;
                    setTimeout(() => this.mostrar('briefings'), 1500);
                } catch (error) {
                    resultado.textContent = error.message;
                } finally {
                    e.target.disabled = false;
                }
            }));
        });
        this.contenido.replaceChildren(
            this.nota(r.hora === null || r.hora === undefined ? 'El briefing de la mañana está apagado.' : `Briefing de hoy (${r.hoy}), a las ${r.hora}:00. En WhatsApp, Meta avisa cuándo se entrega y cuándo se lee; el push y el correo no lo dicen.`),
            this.tabla(['Persona', 'País', 'Hoy', 'WhatsApp', 'Push'], filas),
            acciones,
            resultado
        );
    }

    // ----- 3. Borja -----
    async pintarBorja() {
        const r = await this.pedir({ operacion: 'borja' });
        const form = document.createElement('form');
        form.className = 'torre-secciones';
        const leyenda = document.createElement('p');
        leyenda.className = 'dialogo-nota';
        leyenda.textContent = 'Qué lleva el resumen de la mañana de cada persona (cada quien solo ve lo de su ámbito):';
        form.appendChild(leyenda);
        Object.entries(r.secciones).forEach(([clave, texto]) => {
            const label = document.createElement('label');
            label.className = 'torre-casilla';
            const casilla = document.createElement('input');
            casilla.type = 'checkbox';
            casilla.name = clave;
            casilla.checked = r.activas[clave] !== false;
            label.append(casilla, document.createTextNode(texto));
            form.appendChild(label);
        });
        const aviso = this.nota('');
        const guardar = document.createElement('button');
        guardar.type = 'submit';
        guardar.className = 'btn-primary';
        guardar.textContent = 'Guardar secciones';
        form.append(guardar, aviso);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const activas = Object.fromEntries(Object.keys(r.secciones).map(c => [c, form.elements[c].checked]));
            try {
                await this.pedir({ operacion: 'borja', activas });
                aviso.textContent = 'Guardado: el próximo resumen ya sale así.';
            } catch (error) {
                aviso.textContent = error.message;
            }
        });

        const global = document.createElement('section');
        global.className = 'torre-global';
        const titulo = document.createElement('h4');
        titulo.textContent = 'Resumen global de Borja';
        const resultado = document.createElement('div');
        const generar = this.boton('Generar resumen global ahora', 'btn-primary', async () => {
            generar.disabled = true;
            resultado.replaceChildren(this.nota('Calculando…'));
            try {
                const g = await this.pedir({ operacion: 'resumenGlobal', enviar: true });
                const fila = (nombre, clave, formato = (v) => v) => [nombre, formato(g.paises.RD[clave]), formato(g.paises.VE[clave]), formato(g.total[clave])];
                resultado.replaceChildren(
                    this.tabla(['', 'RD', 'Venezuela', 'Total'], [
                        fila(`Ventas del mes (${g.mes})`, 'ventasUsd', TorreDeControl.usd),
                        fila('Miles de semillas vendidas', 'ventasMiles', (v) => Number(v).toLocaleString(LOCALE)),
                        fila('Cotizaciones abiertas', 'cotizacionesAbiertas'),
                        fila('… en US$', 'cotizacionesUsd', TorreDeControl.usd),
                        fila('Pedidos por cerrar', 'pedidosPorCerrar'),
                        fila('… en US$', 'pedidosPorCerrarUsd', TorreDeControl.usd),
                        fila('Recompras vencidas', 'recomprasVencidas'),
                        fila('Clientes en Reunión', 'clientesEnReunion'),
                        fila('Clientes dormidos', 'dormidos'),
                        fila('Reportes semanales bloqueados', 'reportesBloqueados')
                    ]),
                    this.nota(`Enviado también a tu ${g.enviadoPor.join(', ')}.`)
                );
            } catch (error) {
                resultado.replaceChildren(this.nota(error.message, 'form-error'));
            } finally {
                generar.disabled = false;
            }
        });
        global.append(titulo, this.nota('Ventas en US$ y miles, cotizaciones abiertas, pedidos por cerrar, recompras, clientes en Reunión, dormidos y reportes bloqueados, en RD y Venezuela.'), generar, resultado);
        this.contenido.replaceChildren(form, global);
    }

    // ----- 4. Mensajes -----
    async pintarMensajes() {
        const r = await this.pedir({ operacion: 'mensajes' });
        this.mensajes = r.mensajes;
        const elegir = document.createElement('select');
        elegir.id = 'torre-mensaje';
        Object.entries(r.catalogo).forEach(([clave, def]) => { const o = document.createElement('option'); o.value = clave; o.textContent = def.nombre; elegir.appendChild(o); });
        const etiqueta = document.createElement('label');
        etiqueta.htmlFor = elegir.id;
        etiqueta.textContent = 'Mensaje automático';
        const zona = document.createElement('div');
        const pintar = () => zona.replaceChildren(this.formMensaje(elegir.value, r));
        elegir.addEventListener('change', pintar);
        const cabecera = document.createElement('div');
        cabecera.className = 'form-group';
        cabecera.append(etiqueta, elegir);
        this.contenido.replaceChildren(cabecera, zona);
        if (r.aviso) this.contenido.appendChild(this.nota(r.aviso));
        pintar();
    }

    formMensaje(clave, r) {
        const def = r.catalogo[clave];
        const actual = this.mensajes[clave] || def.porDefecto;
        const form = document.createElement('form');
        form.className = 'torre-mensaje';
        form.noValidate = true;
        form.appendChild(this.nota(def.descripcion));
        const grupo = (texto, control) => {
            const g = document.createElement('div');
            g.className = 'form-group';
            const l = document.createElement('label');
            l.htmlFor = control.id;
            l.textContent = texto;
            g.append(l, control);
            form.appendChild(g);
            return control;
        };
        let asunto = null;
        if (def.asunto) {
            asunto = document.createElement('input');
            asunto.id = `torre-asunto-${clave}`;
            asunto.maxLength = 150;
            asunto.value = actual.asunto || '';
            grupo('Asunto del correo', asunto);
        }
        const texto = document.createElement('textarea');
        texto.id = `torre-texto-${clave}`;
        texto.rows = 4;
        texto.maxLength = 1000;
        texto.value = actual.texto;
        grupo('Texto (campana, push y correo)', texto);
        // Variables: un toque las pone donde estaba el cursor (en el asunto o en el texto, el último que se tocó)
        let ultimo = texto;
        [asunto, texto].filter(Boolean).forEach(c => c.addEventListener('focus', () => { ultimo = c; }));
        const chips = document.createElement('div');
        chips.className = 'torre-variables';
        def.variables.forEach(v => {
            const b = this.boton(`{{${v}}}`, 'btn-texto', () => {
                const destino = ultimo;
                const i = destino.selectionStart ?? destino.value.length;
                destino.setRangeText(`{{${v}}}`, i, destino.selectionEnd ?? i, 'end');
                destino.focus();
                previa();
            });
            b.title = r.variables[v] || '';
            chips.appendChild(b);
        });
        form.appendChild(chips);
        let hora = null;
        if (def.hora) {
            hora = document.createElement('select');
            hora.id = `torre-hora-${clave}`;
            const delServidor = r.horasServidor[clave];
            [['', `La del servidor (${delServidor === null || delServidor === undefined ? 'apagado' : `${delServidor}:00`})`], ...Array.from({ length: 24 }, (_, h) => [String(h), `${h}:00`])]
                .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; hora.appendChild(o); });
            hora.value = actual.hora === null || actual.hora === undefined ? '' : String(actual.hora);
            grupo('Hora de envío', hora);
        }
        let plantilla = null;
        if (def.whatsapp) {
            plantilla = document.createElement('select');
            plantilla.id = `torre-plantilla-${clave}`;
            const valen = def.whatsapp === 7 ? [1, 7] : [1];
            [['', 'La configurada en el servidor'], ...r.plantillas.filter(p => valen.includes(p.variables))
                .map(p => [p.nombre, `${p.nombre} (${p.variables} variable${p.variables === 1 ? '' : 's'}${p.verificada ? ', aprobada en Meta' : ''})`])]
                .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; plantilla.appendChild(o); });
            plantilla.value = actual.plantillaWhatsapp || '';
            grupo('Plantilla de WhatsApp (Meta no deja enviar texto libre: solo plantillas aprobadas)', plantilla);
        }
        const vista = document.createElement('p');
        vista.className = 'torre-previa';
        const ejemplo = { vendedor: 'Marta', cliente: 'Finca Los Robles', casa: 'Gautier Semences', variedad: 'Tomate', fecha: '7/11', dias: 90, guia: '1234567890', lista_pendientes: '📋 Tus tareas: Llevar muestras…', agenda_dia: '10:00 · Comité' };
        const previa = () => { vista.textContent = `Vista previa: ${texto.value.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, v) => String(ejemplo[v] ?? ''))}`; };
        texto.addEventListener('input', previa);
        previa();
        form.appendChild(vista);
        const aviso = this.nota('');
        const acciones = document.createElement('div');
        acciones.className = 'modal-actions';
        const restaurar = this.boton('Restaurar el de siempre', 'btn-secondary', () => {
            texto.value = def.porDefecto.texto;
            if (asunto) asunto.value = def.porDefecto.asunto || '';
            if (hora) hora.value = '';
            if (plantilla) plantilla.value = '';
            previa();
        });
        const guardar = document.createElement('button');
        guardar.type = 'submit';
        guardar.className = 'btn-primary';
        guardar.textContent = 'Guardar';
        acciones.append(restaurar, guardar);
        form.append(acciones, aviso);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const cambio = { ...actual, texto: texto.value };
            if (asunto) cambio.asunto = asunto.value;
            if (hora) cambio.hora = hora.value === '' ? null : Number(hora.value);
            if (plantilla) cambio.plantillaWhatsapp = plantilla.value;
            guardar.disabled = true;
            try {
                const x = await this.pedir({ operacion: 'mensajes', mensajes: { ...this.mensajes, [clave]: cambio } });
                this.mensajes = x.mensajes;
                aviso.className = 'dialogo-nota';
                aviso.textContent = 'Guardado.';
            } catch (error) {
                aviso.className = 'form-error';
                aviso.textContent = error.message;
            } finally {
                guardar.disabled = false;
            }
        });
        return form;
    }
}

window.torreDeControl = new TorreDeControl();
