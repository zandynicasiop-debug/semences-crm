/**
 * Panel de indicadores: los números de cada persona, solo para mirar (no envía nada a nadie).
 *
 * Usa los mismos datos del CRM que ya tiene la app. Con el backend, el servidor ya los filtra por el
 * cargo, el país y la casa comercial de cada quien; aquí además:
 * - un vendedor ve sus clientes (los asignados a él), sus seguimientos y los envíos de sus clientes;
 * - cada sección sale solo si el cargo puede ver ese módulo (el técnico no ve envíos, etc.).
 * Sin backend, el panel resume lo guardado en este dispositivo.
 *
 * Secciones: clientes y seguimientos, semillas enviadas por casa comercial, germinación de los lotes
 * en cámara (con la línea del mínimo) y envíos en camino.
 */
const DIAS_PROXIMOS = 7; // Seguimientos que tocan de hoy a 7 días

class PanelIndicadores {
    constructor() {
        window.addEventListener('load', () => setTimeout(() => this.crearOpcion()));
    }

    crearOpcion() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || this.opcion) return;
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'menu-extra';
        boton.textContent = 'Panel de indicadores';
        boton.addEventListener('click', () => {
            lista.hidden = true;
            document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
            this.abrir();
        });
        // Primera opción del menú después de los módulos
        const primera = lista.querySelector('.menu-extra');
        if (primera) primera.before(boton);
        else lista.appendChild(boton);
        this.opcion = boton;
    }

    // ----- Datos -----
    get ambito() {
        const a = window.responsable && window.responsable.ambito;
        return a && a.estado === 'aprobado' ? a : null;
    }

    get miCorreo() {
        const s = window.responsable && window.responsable.sesion;
        return String((s && s.email) || '').toLowerCase();
    }

    puedeVer(modulo) {
        const a = this.ambito;
        if (!a) return true;
        return a.master || a.modulos.includes(modulo) || (a.lectura || []).includes(modulo);
    }

    // Todo lo que el panel muestra sale de aquí (y se puede probar sin pintar nada)
    calcular(datos, hoy = new Date()) {
        const a = this.ambito;
        const vendedor = Boolean(a && a.cargo === 'vendedor');
        const correo = this.miCorreo;
        const clientesVisibles = datos.clientes || [];
        const clientes = vendedor ? clientesVisibles.filter(c => String(c.asignado || '').toLowerCase() === correo) : clientesVisibles;
        const idsMios = new Set(clientes.map(c => c.id));
        const dia = (fecha) => { const f = new Date(fecha); f.setHours(0, 0, 0, 0); return f; };
        const hoyCero = dia(hoy);
        const diasHasta = (iso) => Math.round((new Date(`${iso}T00:00:00`) - hoyCero) / 86400000);

        // Clientes y seguimientos
        const seguimientos = clientes.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.seguimiento || ''))
            .map(c => ({ cliente: c, dias: diasHasta(c.seguimiento) }))
            .filter(s => s.dias <= DIAS_PROXIMOS)
            .sort((x, y) => x.dias - y.dias);

        // Envíos (el vendedor: los de sus clientes)
        const todosEnvios = datos.envios || [];
        const envios = vendedor ? todosEnvios.filter(e => idsMios.has(e.clienteId)) : todosEnvios;
        const casaDe = (e) => e.casa || ((clientesVisibles.find(c => c.id === e.clienteId) || {}).casa) || 'Sin casa comercial';
        const porCasa = new Map();
        envios.forEach(e => {
            const miles = Number(e.semillasMiles) || 0;
            if (!miles) return;
            porCasa.set(casaDe(e), (porCasa.get(casaDe(e)) || 0) + miles);
        });
        const enCamino = envios.filter(e => e.estado !== 'Entregado')
            .sort((x, y) => String(x.eta || '9999').localeCompare(String(y.eta || '9999')));

        // Germinador: lotes en cámara o listos, con germinación anotada
        const lotes = (datos.germinador || []).filter(l => ['En cámara', 'Listo para trasplante'].includes(l.estado));
        const medidos = lotes.filter(l => l.germinacion !== '' && l.germinacion !== undefined && l.germinacion !== null && !Number.isNaN(Number(l.germinacion)))
            .map(l => ({ lote: l, valor: Number(l.germinacion) }))
            .sort((x, y) => x.valor - y.valor);
        const promedio = medidos.length ? medidos.reduce((s, m) => s + m.valor, 0) / medidos.length : null;

        return {
            vendedor,
            clientes: { mios: clientes.length, visibles: clientesVisibles.length, vencidos: seguimientos.filter(s => s.dias < 0).length, proximos: seguimientos.filter(s => s.dias >= 0).length, seguimientos },
            envios: {
                total: envios.length,
                miles: envios.reduce((s, e) => s + (Number(e.semillasMiles) || 0), 0),
                porCasa: [...porCasa.entries()].map(([casa, miles]) => ({ casa, miles })).sort((x, y) => y.miles - x.miles),
                enCamino,
                problemas: enCamino.filter(e => ['Retenido en aduana', 'Incidencia'].includes(e.estado)).length
            },
            germinador: { lotes: lotes.length, medidos, promedio, bajos: medidos.filter(m => m.valor < UMBRAL_GERMINACION).length }
        };
    }

    // ----- Pantalla -----
    crearDialogo() {
        const d = document.createElement('dialog');
        d.className = 'dialogo dialogo-panel';
        d.setAttribute('aria-labelledby', 'panel-titulo');
        d.innerHTML = `
            <div class="dialogo-form">
                <div class="tablero-cabecera">
                    <div>
                        <h3 id="panel-titulo">Panel de indicadores</h3>
                        <p class="panel-alcance"></p>
                    </div>
                    <button type="button" class="btn-texto panel-cerrar">Cerrar</button>
                </div>
                <div class="panel-contenido"></div>
            </div>`;
        document.body.appendChild(d);
        d.querySelector('.panel-cerrar').addEventListener('click', () => d.close());
        this.dialogo = d;
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'panel-tooltip';
        this.tooltip.hidden = true;
        d.appendChild(this.tooltip);
    }

    abrir() {
        if (!this.dialogo) this.crearDialogo();
        this.pintar();
        if (!this.dialogo.open) this.dialogo.showModal();
    }

    // El CRM avisa cuando cambian los datos (sincronización, registro nuevo…)
    refrescar() {
        if (this.dialogo && this.dialogo.open) this.pintar();
    }

    textoAlcance() {
        const a = this.ambito;
        if (!a) return 'Datos guardados en este dispositivo';
        if (a.master) return 'Toda la empresa';
        const paises = a.paises.map(p => NOMBRE_PAIS[p] || p).join(', ');
        const quien = a.cargo === 'vendedor' ? 'Tus clientes' : 'Tu alcance';
        return `${quien} · ${paises} · ${a.casas.join(', ')}`;
    }

    pintar() {
        const datos = (window.crm && window.crm.datos) || {};
        const r = this.calcular(datos);
        this.dialogo.querySelector('.panel-alcance').textContent = this.textoAlcance();
        const cont = this.dialogo.querySelector('.panel-contenido');
        cont.innerHTML = '';

        // Fichas con los números principales
        const fichas = document.createElement('div');
        fichas.className = 'panel-fichas';
        if (this.puedeVer('clientes')) {
            fichas.appendChild(this.ficha(r.vendedor ? 'Mis clientes' : 'Clientes', numero(r.clientes.mios),
                [r.vendedor && `de ${numero(r.clientes.visibles)} en tu país y casa`, r.clientes.vencidos && `${r.clientes.vencidos} seguimiento${r.clientes.vencidos === 1 ? '' : 's'} vencido${r.clientes.vencidos === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'Sin seguimientos vencidos',
                r.clientes.vencidos > 0));
        }
        if (this.puedeVer('envios')) {
            fichas.appendChild(this.ficha('Semillas enviadas', `${numero(Math.round(r.envios.miles * 10) / 10)} mil`, `en ${r.envios.total} envío${r.envios.total === 1 ? '' : 's'}`));
            fichas.appendChild(this.ficha('Envíos en camino', numero(r.envios.enCamino.length),
                r.envios.problemas ? `${r.envios.problemas} retenido${r.envios.problemas === 1 ? '' : 's'} o con incidencia` : 'Ninguno con problemas', r.envios.problemas > 0));
        }
        if (this.puedeVer('germinador')) {
            fichas.appendChild(this.ficha('Germinación media', r.germinador.promedio === null ? '—' : `${Math.round(r.germinador.promedio * 10) / 10} %`,
                r.germinador.medidos.length ? (r.germinador.bajos ? `${r.germinador.bajos} lote${r.germinador.bajos === 1 ? '' : 's'} bajo el ${UMBRAL_GERMINACION} %` : `${r.germinador.medidos.length} lotes medidos, todos sobre el ${UMBRAL_GERMINACION} %`) : 'Sin lotes medidos en cámara',
                r.germinador.bajos > 0));
        }
        if (fichas.children.length) cont.appendChild(fichas);

        // Seguimientos que tocan
        if (this.puedeVer('clientes')) {
            const s = this.seccion(cont, r.vendedor ? 'Tus seguimientos' : 'Seguimientos de clientes', `Vencidos y los de los próximos ${DIAS_PROXIMOS} días`);
            if (!r.clientes.seguimientos.length) this.vacio(s, 'Nada pendiente esta semana.');
            else s.appendChild(this.tabla(['Cliente', 'Cuándo'], r.clientes.seguimientos.slice(0, 8).map(x => [
                x.cliente.nombre || '—',
                { texto: x.dias < 0 ? `⚠️ Vencido hace ${-x.dias} día${x.dias === -1 ? '' : 's'}` : x.dias === 0 ? 'Hoy' : x.dias === 1 ? 'Mañana' : formatearFecha(x.cliente.seguimiento), aviso: x.dias < 0 }
            ]), r.clientes.seguimientos.length > 8 ? `y ${r.clientes.seguimientos.length - 8} más en la pestaña Clientes` : ''));
        }

        // Semillas enviadas por casa comercial
        if (this.puedeVer('envios')) {
            const s = this.seccion(cont, 'Semillas enviadas por casa comercial', r.vendedor ? 'Miles de semillas, envíos de tus clientes' : 'Miles de semillas, todos los envíos registrados');
            if (!r.envios.porCasa.length) this.vacio(s, 'Todavía no hay envíos con cantidad de semillas.');
            else s.appendChild(this.barras(r.envios.porCasa.map(x => ({
                etiqueta: x.casa, valor: x.miles, texto: `${numero(Math.round(x.miles * 10) / 10)} mil`,
                ayuda: `${x.casa}: ${numero(x.miles)} mil semillas enviadas`
            })), Math.max(...r.envios.porCasa.map(x => x.miles))));
        }

        // Germinación por lote
        if (this.puedeVer('germinador')) {
            const s = this.seccion(cont, 'Germinación de los lotes en cámara', `De menor a mayor. La línea marca el mínimo del ${UMBRAL_GERMINACION} %`);
            if (!r.germinador.medidos.length) this.vacio(s, 'No hay lotes en cámara con la germinación anotada.');
            else {
                const vistos = r.germinador.medidos.slice(0, 10);
                s.appendChild(this.barras(vistos.map(m => {
                    const bajo = m.valor < UMBRAL_GERMINACION;
                    return {
                        etiqueta: `${m.lote.lote || 'Lote'} · ${m.lote.variedad || ''}`.replace(/ · $/, ''),
                        valor: m.valor, texto: `${m.valor} %${bajo ? ' ⚠️' : ''}`, aviso: bajo,
                        ayuda: `Lote ${m.lote.lote || ''}: ${m.valor} % de germinación${bajo ? ' (bajo el mínimo)' : ''}${m.lote.cliente ? ` · ${m.lote.cliente}` : ''}`
                    };
                }), 100, UMBRAL_GERMINACION));
                if (r.germinador.medidos.length > vistos.length) this.vacio(s, `y ${r.germinador.medidos.length - vistos.length} lotes más, todos con mejor germinación.`);
            }
        }

        // Envíos en camino
        if (this.puedeVer('envios')) {
            const s = this.seccion(cont, 'Envíos en camino', 'Los que no se han entregado, por fecha de llegada');
            if (!r.envios.enCamino.length) this.vacio(s, 'No hay envíos en camino.');
            else s.appendChild(this.tabla(['Guía', 'Cliente', 'Estado', 'Llegada'], r.envios.enCamino.slice(0, 10).map(e => [
                `${e.transportista || ''} ${e.guia || ''}`.trim() || '—',
                nombreCliente(e) || e.cliente || '—',
                { texto: ['Retenido en aduana', 'Incidencia'].includes(e.estado) ? `⚠️ ${e.estado}` : (e.estado || '—'), aviso: ['Retenido en aduana', 'Incidencia'].includes(e.estado) },
                e.eta ? formatearFecha(e.eta) : '—'
            ]), r.envios.enCamino.length > 10 ? `y ${r.envios.enCamino.length - 10} más en la pestaña Envíos` : ''));
        }

        if (!cont.children.length) this.vacio(cont, 'Tu cargo todavía no tiene indicadores en este panel.');
    }

    ficha(titulo, valor, detalle, aviso = false) {
        const f = document.createElement('div');
        f.className = `panel-ficha${aviso ? ' panel-ficha-aviso' : ''}`;
        const t = document.createElement('span');
        t.className = 'panel-ficha-titulo';
        t.textContent = titulo;
        const v = document.createElement('strong');
        v.textContent = valor;
        const d = document.createElement('span');
        d.className = 'panel-ficha-detalle';
        d.textContent = `${aviso ? '⚠️ ' : ''}${detalle}`;
        f.append(t, v, d);
        return f;
    }

    seccion(cont, titulo, subtitulo) {
        const s = document.createElement('section');
        s.className = 'panel-seccion';
        const h = document.createElement('h4');
        h.textContent = titulo;
        const p = document.createElement('p');
        p.className = 'panel-subtitulo';
        p.textContent = subtitulo;
        s.append(h, p);
        cont.appendChild(s);
        return s;
    }

    vacio(cont, texto) {
        const p = document.createElement('p');
        p.className = 'dialogo-nota';
        p.textContent = texto;
        cont.appendChild(p);
    }

    // Barras horizontales: etiqueta, barra desde la izquierda y su valor escrito al lado
    barras(filas, maximo, linea = null) {
        const ul = document.createElement('ul');
        ul.className = 'panel-barras';
        filas.forEach(f => {
            const li = document.createElement('li');
            li.className = `panel-barra${f.aviso ? ' panel-barra-aviso' : ''}`;
            li.tabIndex = 0;
            li.setAttribute('aria-label', f.ayuda);
            const etiqueta = document.createElement('span');
            etiqueta.className = 'panel-barra-etiqueta';
            etiqueta.textContent = f.etiqueta;
            const pista = document.createElement('span');
            pista.className = 'panel-barra-pista';
            const relleno = document.createElement('span');
            relleno.className = 'panel-barra-relleno';
            relleno.style.width = `${maximo > 0 ? Math.max(1, (f.valor / maximo) * 100) : 0}%`;
            pista.appendChild(relleno);
            if (linea !== null) {
                const marca = document.createElement('span');
                marca.className = 'panel-barra-linea';
                marca.style.left = `${(linea / maximo) * 100}%`;
                pista.appendChild(marca);
            }
            const valor = document.createElement('span');
            valor.className = 'panel-barra-valor';
            valor.textContent = f.texto;
            li.append(etiqueta, pista, valor);
            const mostrar = (x, y) => {
                this.tooltip.textContent = f.ayuda;
                this.tooltip.hidden = false;
                const caja = this.dialogo.getBoundingClientRect();
                // El diálogo se desplaza: la posición va relativa a su contenido, no a la pantalla
                this.tooltip.style.left = `${Math.min(x - caja.left + 12, caja.width - this.tooltip.offsetWidth - 8) + this.dialogo.scrollLeft}px`;
                this.tooltip.style.top = `${y - caja.top + 14 + this.dialogo.scrollTop}px`;
            };
            li.addEventListener('mousemove', (e) => mostrar(e.clientX, e.clientY));
            li.addEventListener('focus', () => { const c = li.getBoundingClientRect(); mostrar(c.left + c.width / 2, c.bottom - 8); });
            li.addEventListener('mouseleave', () => { this.tooltip.hidden = true; });
            li.addEventListener('blur', () => { this.tooltip.hidden = true; });
            ul.appendChild(li);
        });
        return ul;
    }

    tabla(cabeceras, filas, pie = '') {
        const envoltura = document.createElement('div');
        envoltura.className = 'panel-tabla';
        const t = document.createElement('table');
        const thead = document.createElement('thead');
        const tr = document.createElement('tr');
        cabeceras.forEach(c => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = c; tr.appendChild(th); });
        thead.appendChild(tr);
        const tbody = document.createElement('tbody');
        filas.forEach(fila => {
            const tr2 = document.createElement('tr');
            fila.forEach(celda => {
                const td = document.createElement('td');
                const c = typeof celda === 'object' ? celda : { texto: celda };
                td.textContent = c.texto;
                if (c.aviso) td.className = 'panel-aviso';
                tr2.appendChild(td);
            });
            tbody.appendChild(tr2);
        });
        t.append(thead, tbody);
        envoltura.appendChild(t);
        if (pie) {
            const p = document.createElement('p');
            p.className = 'dialogo-nota';
            p.textContent = pie;
            envoltura.appendChild(p);
        }
        return envoltura;
    }
}

window.panelIndicadores = new PanelIndicadores();
