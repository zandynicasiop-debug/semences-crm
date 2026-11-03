/**
 * Cotizaciones libres, con aprobación de administración (módulo "cotizaciones" del CRM).
 *
 * - Sin lista de precios: cada línea se escribe a mano (producto, cantidad, unidad y precio unitario).
 * - Quien la prepara la envía a aprobación ('Pendiente'). Un administrativo o un Master la aprueba o la
 *   rechaza con un motivo; si otra persona la cambia después, vuelve a 'Pendiente'. El servidor lo
 *   comprueba (permisos.js › ajustarCotizacion) y es quien calcula el total y firma la revisión.
 * - Solo una cotización aprobada se descarga en PDF (jsPDF) o se envía por correo desde el Gmail de quien
 *   la usa, con el PDF adjunto.
 * - La ficha de las oficinas del mapa enseña cuántas hay por aprobar y abre una nueva.
 */
const ESTADOS_COTIZACION = ['Pendiente', 'Aprobada', 'Rechazada'];
const MONEDAS_COTIZACION = ['US$', 'RD$', 'Bs'];
const UNIDADES_COTIZACION = ['sobre', 'mil semillas', 'lata', 'kg', 'unidad'];
const TONO_COTIZACION = { Pendiente: 'aviso', Aprobada: 'exito', Rechazada: 'peligro' };

const dinero = (n) => Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const redondear = (n) => Math.round(n * 100) / 100;

// Lo mismo que hace el servidor: líneas con producto y cantidad, y el total en la moneda de la cotización
function totalCotizacion(lineas) {
    return redondear((lineas || []).reduce((t, l) => t + (Number(l.cantidad) || 0) * (Number(l.precio) || 0), 0));
}

const importeCotizacion = (r) => `${r.moneda || MONEDAS_COTIZACION[0]}${dinero(r.total ?? totalCotizacion(r.lineas))}`;

class Cotizador {
    // Aprueba quien es de administración o Master. Sin backend (todo en este navegador) no hay a quién pedirlo
    get apruebo() {
        const a = window.responsable && window.responsable.ambito;
        if (!a || a.estado !== 'aprobado') return !(window.baseDatos && window.baseDatos.compartida);
        return Boolean(a.master || a.cargo === 'administrativo');
    }

    get datos() {
        return window.baseDatos.datos;
    }

    aviso(texto, tipo) {
        if (window.equipo) window.equipo.mostrarAviso(texto, tipo);
    }

    // ----- Ficha de las oficinas del mapa: resumen y acceso directo -----
    pintar(contenedor) {
        const lista = this.datos.cotizaciones || [];
        const pendientes = lista.filter(c => c.estado === 'Pendiente').length;
        contenedor.innerHTML = `
            <h4 class="mapa-extra-titulo">Cotizaciones</h4>
            <p class="mapa-extra-vacio"></p>
            <button type="button" class="btn-primary cotizador-nueva">Nueva cotización</button>
            <button type="button" class="btn-secondary cotizador-ver">Ver cotizaciones</button>`;
        contenedor.querySelector('.mapa-extra-vacio').textContent = lista.length
            ? `${lista.length} ${lista.length === 1 ? 'cotización' : 'cotizaciones'} · ${pendientes} ${pendientes === 1 ? 'pendiente' : 'pendientes'} de aprobación.`
            : 'Escribe los productos y precios a mano; administración la aprueba antes de enviarla al cliente.';
        contenedor.querySelector('.cotizador-nueva').addEventListener('click', () => this.abrir());
        const ver = contenedor.querySelector('.cotizador-ver');
        const pestana = document.getElementById('tab-cotizaciones');
        ver.hidden = !pestana || pestana.hidden;
        ver.addEventListener('click', () => {
            const mapa = window.appDashboard && window.appDashboard.mapa;
            if (mapa) mapa.cerrar();
            pestana.click();
        });
    }

    // ----- Editor: nueva (valores con clienteId, desde el expediente) o una ya guardada -----
    abrir(valores = {}) {
        const crm = window.crm;
        if (!crm) return;
        const guardada = valores.id ? this.datos.cotizaciones.find(c => c.id === valores.id) : null;
        const actual = guardada || { clienteId: valores.clienteId || '', moneda: MONEDAS_COTIZACION[0], fecha: hoyISO(), validez: 15, lineas: [] };
        const lineas = (actual.lineas || []).map(l => ({ ...l }));
        if (!lineas.length) lineas.push({ producto: '', cantidad: '', unidad: UNIDADES_COTIZACION[0], precio: '' });

        // Sin clientes, el CRM invita a registrar el primero y vuelve aquí
        if (!this.datos.clientes.length) {
            crm.abrirFormulario('cotizaciones', valores);
            return;
        }

        const form = document.createElement('form');
        form.className = 'dialogo-form cotizacion';
        form.noValidate = true;
        const ambito = ambitoCRM();
        const opcionesPais = ambito ? ambito.paises.map(p => `<option value="${p}">${NOMBRE_PAIS[p] || p}</option>`).join('') : '';
        const opcionesCasa = ambito ? ambito.casas.map(c => `<option>${c}</option>`).join('') : '';
        form.innerHTML = `
            <h3 id="dialogo-titulo">${guardada ? `Cotización ${guardada.numero || ''}` : 'Nueva cotización'}</h3>
            <p class="cotizacion-estado" hidden></p>
            <div class="cotizacion-datos">
                <div class="form-group">
                    <label for="cot-cliente">Cliente</label>
                    <select id="cot-cliente" name="clienteId" required aria-describedby="cot-cliente-error"><option value="">Elige un cliente</option></select>
                    <p class="form-error" id="cot-cliente-error" hidden></p>
                </div>
                <div class="form-group">
                    <label for="cot-fecha">Fecha</label>
                    <input id="cot-fecha" name="fecha" type="date" required>
                </div>
                ${ambito ? `
                <div class="form-group">
                    <label for="cot-pais">País</label>
                    <select id="cot-pais" name="pais" required>${opcionesPais}</select>
                </div>
                <div class="form-group">
                    <label for="cot-casa">Casa comercial</label>
                    <select id="cot-casa" name="casa" required>${opcionesCasa}</select>
                </div>` : ''}
                <div class="form-group">
                    <label for="cot-moneda">Moneda</label>
                    <select id="cot-moneda" name="moneda">${MONEDAS_COTIZACION.map(m => `<option>${m}</option>`).join('')}</select>
                </div>
                <div class="form-group">
                    <label for="cot-validez">Válida por (días, opcional)</label>
                    <input id="cot-validez" name="validez" type="number" min="1" step="1" inputmode="numeric">
                </div>
            </div>
            <fieldset class="cotizacion-lineas">
                <legend>Productos</legend>
                <div class="cotizacion-cabecera" aria-hidden="true">
                    <span>Producto</span><span>Cantidad</span><span>Unidad</span><span>Precio unitario</span><span>Subtotal</span><span></span>
                </div>
                <ul class="cotizacion-filas"></ul>
                <p class="form-error" id="cot-lineas-error" hidden></p>
                <button type="button" class="btn-secondary cotizacion-anadir">Añadir producto</button>
            </fieldset>
            <datalist id="cot-unidades">${UNIDADES_COTIZACION.map(u => `<option value="${u}"></option>`).join('')}</datalist>
            <div class="form-group">
                <label for="cot-condiciones">Condiciones y notas (opcional)</label>
                <textarea id="cot-condiciones" name="condiciones" rows="3" placeholder="Precios sin impuestos. Entrega en 15 días. Pago contra entrega."></textarea>
            </div>
            <p class="cotizacion-total" aria-live="polite"></p>
            <p class="cotizacion-nota"></p>
            <div class="modal-actions cotizacion-acciones"></div>`;

        const el = (selector) => form.querySelector(selector);
        const cliente = el('#cot-cliente');
        [...this.datos.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).forEach(c => {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = c.nombre;
            cliente.appendChild(o);
        });
        cliente.value = actual.clienteId || '';
        el('#cot-fecha').value = actual.fecha || (actual.creado || '').slice(0, 10) || hoyISO();
        el('#cot-moneda').value = MONEDAS_COTIZACION.includes(actual.moneda) ? actual.moneda : MONEDAS_COTIZACION[0];
        el('#cot-validez').value = actual.validez || '';
        el('#cot-condiciones').value = actual.condiciones || '';
        // País y casa: los guardados o, si no, los de la ficha del cliente
        const heredar = () => {
            const c = crm.cliente(cliente.value);
            [['#cot-pais', c && c.pais], ['#cot-casa', c && c.casa]].forEach(([s, valor]) => {
                const control = el(s);
                if (control && valor && [...control.options].some(o => o.value === valor)) control.value = valor;
            });
        };
        if (ambito) {
            heredar();
            if (actual.pais && el('#cot-pais')) el('#cot-pais').value = actual.pais;
            if (actual.casa && el('#cot-casa')) el('#cot-casa').value = actual.casa;
        }
        cliente.addEventListener('change', () => { heredar(); crm.limpiarError(cliente); });

        // Estado de la que ya existe
        if (guardada) {
            const estado = el('.cotizacion-estado');
            estado.hidden = false;
            estado.dataset.tono = TONO_COTIZACION[guardada.estado] || 'aviso';
            const cuando = guardada.revisadoEn ? formatearFecha(guardada.revisadoEn.slice(0, 10)) : '';
            estado.textContent = {
                Aprobada: `Aprobada por ${guardada.revisadoPor || 'administración'}${cuando ? ` el ${cuando}` : ''}.`,
                Rechazada: `Rechazada por ${guardada.revisadoPor || 'administración'}${guardada.motivo ? `: ${guardada.motivo}` : '.'}`
            }[guardada.estado] || `Pendiente de aprobación${guardada.responsable ? ` · la preparó ${guardada.responsable}` : ''}.`;
        }

        // Líneas: se pintan de nuevo al añadir o quitar; al escribir solo cambian subtotal y total
        const filas = el('.cotizacion-filas');
        const total = el('.cotizacion-total');
        const errorLineas = el('#cot-lineas-error');
        let sucio = false;
        const recalcular = () => {
            filas.querySelectorAll('li').forEach((li, i) => {
                const l = lineas[i];
                li.querySelector('.cotizacion-subtotal').textContent = `${el('#cot-moneda').value}${dinero((Number(l.cantidad) || 0) * (Number(l.precio) || 0))}`;
            });
            total.textContent = `Total: ${el('#cot-moneda').value}${dinero(totalCotizacion(lineas))}`;
        };
        const campo = (clase, etiqueta, tipo, valor, alCambiar, extra = {}) => {
            const input = document.createElement('input');
            input.type = tipo;
            input.className = clase;
            input.value = valor ?? '';
            input.setAttribute('aria-label', etiqueta);
            Object.entries(extra).forEach(([k, v]) => input.setAttribute(k, v));
            input.addEventListener('input', () => {
                alCambiar(input.value);
                errorLineas.hidden = true;
                input.closest('li').querySelectorAll('[aria-invalid]').forEach(c => c.removeAttribute('aria-invalid'));
                recalcular();
            });
            return input;
        };
        const pintarFilas = () => {
            filas.innerHTML = '';
            lineas.forEach((l, i) => {
                const li = document.createElement('li');
                const n = i + 1;
                const subtotal = document.createElement('span');
                subtotal.className = 'cotizacion-subtotal';
                subtotal.dataset.titulo = 'Subtotal';
                const quitar = document.createElement('button');
                quitar.type = 'button';
                quitar.className = 'btn-texto btn-peligro';
                quitar.textContent = 'Quitar';
                quitar.setAttribute('aria-label', `Quitar el producto ${n}`);
                quitar.disabled = lineas.length === 1;
                quitar.addEventListener('click', () => {
                    lineas.splice(i, 1);
                    sucio = true;
                    pintarFilas();
                    filas.querySelector('li:last-child .cotizacion-producto').focus();
                });
                li.append(
                    campo('cotizacion-producto', `Producto ${n}`, 'text', l.producto, v => { l.producto = v; }, { list: 'lista-variedades', placeholder: 'Tomate saladette F1' }),
                    campo('cotizacion-cantidad', `Cantidad del producto ${n}`, 'number', l.cantidad, v => { l.cantidad = v; }, { min: '0', step: 'any', inputmode: 'decimal', placeholder: '10' }),
                    campo('cotizacion-unidad', `Unidad del producto ${n}`, 'text', l.unidad, v => { l.unidad = v; }, { list: 'cot-unidades', placeholder: 'sobre' }),
                    campo('cotizacion-precio', `Precio unitario del producto ${n}`, 'number', l.precio, v => { l.precio = v; }, { min: '0', step: 'any', inputmode: 'decimal', placeholder: '45.00' }),
                    subtotal, quitar);
                filas.appendChild(li);
            });
            recalcular();
        };
        el('.cotizacion-anadir').addEventListener('click', () => {
            lineas.push({ producto: '', cantidad: '', unidad: lineas[lineas.length - 1].unidad || UNIDADES_COTIZACION[0], precio: '' });
            sucio = true;
            pintarFilas();
            filas.querySelector('li:last-child .cotizacion-producto').focus();
        });
        form.addEventListener('input', () => { sucio = true; pintarAcciones(); });
        el('#cot-moneda').addEventListener('change', recalcular);

        // Botones según quién la mira y en qué estado está
        const nota = el('.cotizacion-nota');
        const acciones = el('.cotizacion-acciones');
        const boton = (texto, clase, alPulsar) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = clase;
            b.textContent = texto;
            b.addEventListener('click', alPulsar);
            acciones.appendChild(b);
            return b;
        };
        const pintarAcciones = () => {
            acciones.innerHTML = '';
            boton('Cancelar', 'btn-secondary', () => crm.dialogo.close());
            const lista = guardada && guardada.estado === 'Aprobada' && !sucio;
            if (lista) {
                boton('Descargar PDF', 'btn-secondary', () => this.descargar(guardada));
                if (this.conector && this.conector.conBackend) boton('Enviar por correo', 'btn-secondary', (e) => this.enviarPorCorreo(guardada, e.currentTarget));
            }
            if (this.apruebo) {
                if (guardada && guardada.estado !== 'Rechazada') boton('Rechazar', 'btn-secondary btn-peligro', () => this.guardar(form, lineas, guardada, 'Rechazada'));
                if (!guardada || sucio || guardada.estado !== 'Aprobada') {
                    boton(guardada ? 'Guardar pendiente' : 'Guardar sin aprobar', 'btn-secondary', () => this.guardar(form, lineas, guardada, 'Pendiente'));
                    boton('Aprobar', 'btn-primary', () => this.guardar(form, lineas, guardada, 'Aprobada'));
                }
                nota.textContent = lista ? '' : 'Al aprobarla se podrá descargar en PDF y enviar al cliente.';
            } else {
                if (!guardada || sucio || guardada.estado !== 'Aprobada') boton('Enviar a aprobación', 'btn-primary', () => this.guardar(form, lineas, guardada, 'Pendiente'));
                nota.textContent = guardada && guardada.estado === 'Aprobada'
                    ? (sucio ? 'Si guardas los cambios, vuelve a aprobación de administración.' : '')
                    : 'Administración la revisa; cuando la apruebe te llega un aviso y ya se puede enviar al cliente.';
            }
            nota.hidden = !nota.textContent;
        };

        this.conector = window.baseDatos && window.baseDatos.conector;
        pintarFilas();
        pintarAcciones();
        crm.mostrarEnDialogo(form);
        crm.dialogo.classList.add('dialogo-ancho');
        (cliente.value ? filas.querySelector('.cotizacion-producto') : cliente).focus();
    }

    // Comprueba, guarda y avisa. estado: 'Pendiente', 'Aprobada' o 'Rechazada'
    guardar(form, lineas, guardada, estado) {
        const crm = window.crm;
        const cliente = form.elements.clienteId;
        const errorLineas = form.querySelector('#cot-lineas-error');
        crm.limpiarError(cliente);
        errorLineas.hidden = true;
        if (!cliente.value) {
            crm.mostrarError(cliente, 'Elige el cliente.');
            cliente.focus();
            return;
        }
        // Las filas vacías se ignoran; las empezadas necesitan producto, cantidad y precio (0 si va sin cargo)
        const vacia = (l) => ![l.producto, l.cantidad, l.precio].some(v => String(v ?? '').trim() !== '');
        const mal = lineas.findIndex(l => !vacia(l) && !(String(l.producto || '').trim() && Number(l.cantidad) > 0
            && String(l.precio ?? '').trim() !== '' && Number(l.precio) >= 0));
        const llenas = lineas.filter(l => !vacia(l)).map(l => ({ producto: String(l.producto).trim(), cantidad: Number(l.cantidad), unidad: String(l.unidad || '').trim(), precio: Number(l.precio) }));
        if (mal >= 0 || !llenas.length) {
            errorLineas.textContent = !llenas.length
                ? 'Añade al menos un producto con su cantidad y su precio.'
                : `Revisa el producto ${mal + 1}: necesita nombre, una cantidad mayor que 0 y el precio (0 si va sin cargo).`;
            errorLineas.hidden = false;
            // La línea que falla, en rojo y unida al mensaje (el lector de pantalla lo lee al llegar)
            const fila = form.querySelectorAll('.cotizacion-filas li')[Math.max(mal, 0)];
            fila.querySelectorAll('input').forEach(c => {
                c.setAttribute('aria-invalid', 'true');
                c.setAttribute('aria-describedby', 'cot-lineas-error');
            });
            fila.querySelector('.cotizacion-producto').focus();
            return;
        }
        let motivo = '';
        if (estado === 'Rechazada') {
            motivo = window.prompt('¿Por qué la rechazas? Se lo decimos a quien la preparó.', '');
            if (motivo === null) return;
        }
        const c = crm.cliente(cliente.value);
        const fecha = form.elements.fecha.value || hoyISO();
        const ahora = new Date();
        const registro = {
            ...(guardada ? crm.db.limpio(guardada) : {}),
            id: guardada ? guardada.id : nuevoId(),
            numero: guardada && guardada.numero ? guardada.numero : `COT-${hoyISO().replace(/-/g, '')}-${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}${String(ahora.getSeconds()).padStart(2, '0')}`,
            creado: guardada ? guardada.creado : ahora.toISOString(),
            responsable: guardada ? guardada.responsable : (window.responsable ? window.responsable.nombre : ''),
            fecha,
            clienteId: cliente.value,
            cliente: c ? c.nombre : '',
            moneda: form.elements.moneda.value,
            validez: form.elements.validez.value ? Number(form.elements.validez.value) : '',
            condiciones: form.elements.condiciones.value.trim(),
            lineas: llenas,
            total: totalCotizacion(llenas),
            estado
        };
        if (form.elements.pais) registro.pais = form.elements.pais.value;
        if (form.elements.casa) registro.casa = form.elements.casa.value;
        // La firma de la revisión la pone el servidor; aquí se adelanta para verla al momento
        if (estado === 'Pendiente') ['revisadoPor', 'revisadoEn', 'motivo'].forEach(k => delete registro[k]);
        else {
            registro.revisadoPor = window.responsable ? window.responsable.nombre : '';
            registro.revisadoEn = ahora.toISOString();
            if (estado === 'Rechazada') registro.motivo = motivo.trim();
            else delete registro.motivo;
        }
        crm.db.guardar('cotizaciones', registro);
        crm.renderTodo();
        crm.dialogo.close();
        this.aviso({
            Pendiente: `Cotización ${registro.numero} enviada a aprobación.`,
            Aprobada: `Cotización ${registro.numero} aprobada: ya se puede descargar y enviar.`,
            Rechazada: `Cotización ${registro.numero} rechazada.`
        }[estado]);
    }

    descargar(registro) {
        const pdf = this.crearPdf(registro);
        if (!pdf) return;
        // En las apps (Android, iPhone, escritorio) no hay descargas del navegador: el PDF se entrega a la app,
        // que lo guarda en Descargas (Android), lo ofrece para compartir o guardar (iPhone) o pregunta dónde (escritorio)
        if (window.AppNativa) window.AppNativa.guardarArchivo(pdf.archivo, pdf.doc.output('datauristring').split(',')[1], 'application/pdf');
        else pdf.doc.save(pdf.archivo);
    }

    // Envía el PDF desde el Gmail de quien usa la app (backend); el destinatario se escribe en el momento
    async enviarPorCorreo(registro, boton) {
        const pdf = this.crearPdf(registro);
        if (!pdf) return;
        // Si el cliente tiene correo se propone; y si tiene WhatsApp, se le avisa por allí
        const ficha = window.crm.cliente(registro.clienteId);
        const para = window.prompt(`¿A qué correo envías la cotización de ${pdf.cliente}? (varios, separados por comas)`, (ficha && ficha.correo) || this.ultimoCorreo || '');
        if (!para || !para.trim()) return;
        this.ultimoCorreo = para.trim();
        botonOcupado(boton, true, 'Enviando…');
        const preparo = window.responsable ? window.responsable.nombre : '';
        const respuesta = await this.conector.enviarCorreo({
            para: this.ultimoCorreo,
            asunto: `Cotización de Semences del Caribe · ${pdf.cliente}`,
            texto: `Hola:\n\nAdjunto la cotización solicitada (${pdf.total}).\n\nQuedamos a su disposición.\n${preparo ? `${preparo}\n` : ''}Semences del Caribe`,
            adjunto: { nombre: pdf.archivo, tipo: 'application/pdf', base64: pdf.doc.output('datauristring').split(',')[1] },
            whatsapp: (ficha && ficha.whatsapp) || ''
        });
        botonOcupado(boton, false);
        if (respuesta && respuesta.ok) this.aviso(`Cotización enviada a ${this.ultimoCorreo}${respuesta.avisoWhatsapp ? '; se le avisa por WhatsApp' : ''}.`);
        else this.aviso((respuesta && respuesta.error) || 'No se pudo enviar el correo. Revisa la conexión.', 'error');
    }

    // El PDF de una cotización aprobada ({ doc, archivo, cliente, total }), o null si no se puede
    crearPdf(registro) {
        if (registro.estado !== 'Aprobada') {
            this.aviso('Solo se descargan y envían las cotizaciones aprobadas por administración.', 'alerta');
            return null;
        }
        if (!window.jspdf) {
            window.alert('No se pudo cargar el generador de PDF. Revisa la conexión y recarga la página.');
            return null;
        }
        const moneda = registro.moneda || MONEDAS_COTIZACION[0];
        const cliente = registro.cliente || 'Cliente';
        const total = importeCotizacion(registro);
        const fecha = new Date(`${registro.fecha || hoyISO()}T12:00:00`).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });

        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'letter' });
        const ancho = doc.internal.pageSize.getWidth();
        const alto = doc.internal.pageSize.getHeight();
        const margen = 20;
        const derecha = ancho - margen;

        // Cabecera con el verde de la marca
        doc.setFillColor(21, 128, 61);
        doc.rect(0, 0, ancho, 30, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text('Semences del Caribe', margen, 15);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Semillas de hortalizas · ${NOMBRE_PAIS[registro.pais] || 'República Dominicana'}`, margen, 22);

        doc.setTextColor(20, 40, 28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('Cotización', margen, 44);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Nº ${registro.numero || registro.id}`, derecha, 44, { align: 'right' });
        doc.text(`Fecha: ${fecha}`, margen, 52);
        doc.text(`Cliente: ${cliente}`, margen, 58);
        if (registro.casa) doc.text(`Casa comercial: ${registro.casa}`, derecha, 52, { align: 'right' });

        // Tabla de productos
        const col = { producto: margen + 2, cantidad: 112, precio: 157, subtotal: derecha - 2 };
        let y = 70;
        const cabeceraTabla = () => {
            doc.setFillColor(240, 253, 244);
            doc.rect(margen, y - 5, derecha - margen, 8, 'F');
            doc.setFont('helvetica', 'bold');
            doc.text('Producto', col.producto, y);
            doc.text('Cantidad', col.cantidad, y, { align: 'right' });
            doc.text('Precio unitario', col.precio, y, { align: 'right' });
            doc.text('Subtotal', col.subtotal, y, { align: 'right' });
            doc.setFont('helvetica', 'normal');
            y += 9;
        };
        cabeceraTabla();
        (registro.lineas || []).forEach(l => {
            const nombre = doc.splitTextToSize(l.producto, 62);
            if (y + nombre.length * 5 > alto - 50) {
                doc.addPage();
                y = margen + 5;
                cabeceraTabla();
            }
            doc.text(nombre, col.producto, y);
            doc.text(`${dinero(l.cantidad).replace(/\.00$/, '')}${l.unidad ? ` ${l.unidad}` : ''}`, col.cantidad, y, { align: 'right' });
            doc.text(`${moneda}${dinero(l.precio)}`, col.precio, y, { align: 'right' });
            doc.text(`${moneda}${dinero(l.cantidad * l.precio)}`, col.subtotal, y, { align: 'right' });
            y += nombre.length * 5 + 3;
            doc.setDrawColor(220, 230, 224);
            doc.line(margen, y - 4, derecha, y - 4);
        });

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`Total: ${total}`, derecha, y + 4, { align: 'right' });

        // Condiciones, validez y quién la preparó y la aprobó
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(90, 110, 98);
        const condiciones = registro.condiciones ? doc.splitTextToSize(registro.condiciones, derecha - margen) : [];
        if (condiciones.length) {
            if (y + 14 + condiciones.length * 4 > alto - 24) { doc.addPage(); y = margen; }
            doc.text(condiciones, margen, y + 14);
        }
        const pie = [
            registro.validez && `Válida por ${registro.validez} días desde la fecha.`,
            registro.responsable && `Preparada por ${registro.responsable}.`,
            registro.revisadoPor && `Aprobada por ${registro.revisadoPor}.`
        ].filter(Boolean);
        doc.text(pie, margen, alto - 18);

        const archivo = `Cotizacion_${(registro.numero || '')}_${cliente.replace(/[^\p{L}\p{N}]+/gu, '_')}.pdf`.replace(/_+/g, '_');
        return { doc, archivo, cliente, total };
    }
}

window.cotizador = new Cotizador();
