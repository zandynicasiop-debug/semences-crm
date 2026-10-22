/**
 * Cotizador de semillas en la ficha de las oficinas del mapa.
 *
 * Los precios salen de la propia ficha (la lista que el equipo edita y comparte), una línea por producto:
 *   - Semilla de tomate saladette F1: $45 / sobre
 * Las líneas sin precio (p. ej. "Asesoría técnica: incluida") no se cotizan.
 * La cotización se descarga en PDF con jsPDF.
 */
const PATRON_PRECIO = /^\s*[-•*]?\s*(.+?)\s*:\s*((?:RD|US)?\$)\s*([\d.,]+)\s*(?:\/\s*(.+?))?\s*$/i;

const dinero = (n) => n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class Cotizador {
    constructor() {
        this.lineas = []; // { producto, cantidad }: se conservan al cerrar y volver a abrir la ficha
    }

    // Lista de precios a partir del texto de la ficha
    leerPrecios(texto) {
        return String(texto || '').split('\n').map(linea => {
            const m = linea.match(PATRON_PRECIO);
            if (!m) return null;
            const precio = Number(m[3].replace(/,/g, ''));
            if (!precio) return null;
            return { nombre: m[1], moneda: m[2].toUpperCase(), precio, unidad: (m[4] || 'unidad').trim() };
        }).filter(Boolean);
    }

    pintar(contenedor, textoFicha) {
        this.contenedor = contenedor;
        this.precios = this.leerPrecios(textoFicha);
        // Si un producto desapareció de la lista, sale de la cotización
        this.lineas = this.lineas.filter(l => this.precios.some(p => p.nombre === l.producto));

        contenedor.innerHTML = `
            <h4 class="mapa-extra-titulo">Cotizar semillas</h4>
            <p class="mapa-extra-vacio" hidden>No hay precios en la ficha. Edita la información con líneas como «- Semilla de tomate: $45 / sobre».</p>
            <form class="cotizador-form" novalidate>
                <div class="form-group">
                    <label for="cot-cliente">Cliente</label>
                    <input id="cot-cliente" list="cot-clientes" autocomplete="off" aria-describedby="cot-cliente-error">
                    <datalist id="cot-clientes"></datalist>
                    <p class="form-error" id="cot-cliente-error" hidden></p>
                </div>
                <div class="cotizador-fila">
                    <div class="form-group">
                        <label for="cot-producto">Producto</label>
                        <select id="cot-producto"></select>
                    </div>
                    <div class="form-group cotizador-cantidad">
                        <label for="cot-cantidad">Cantidad</label>
                        <input id="cot-cantidad" type="number" min="1" step="1" value="10" inputmode="numeric" aria-describedby="cot-cantidad-error">
                    </div>
                </div>
                <p class="form-error" id="cot-cantidad-error" hidden></p>
                <button type="submit" class="btn-secondary">Añadir a la cotización</button>
            </form>
            <ul class="cotizador-lineas" aria-label="Productos de la cotización"></ul>
            <p class="cotizador-total" aria-live="polite"></p>
            <button type="button" class="btn-primary cotizador-pdf">Descargar cotización (PDF)</button>`;

        const form = contenedor.querySelector('form');
        const vacio = contenedor.querySelector('.mapa-extra-vacio');
        this.inputCliente = contenedor.querySelector('#cot-cliente');
        this.inputCantidad = contenedor.querySelector('#cot-cantidad');
        this.selectProducto = contenedor.querySelector('#cot-producto');
        this.listaLineas = contenedor.querySelector('.cotizador-lineas');
        this.total = contenedor.querySelector('.cotizador-total');
        this.botonPdf = contenedor.querySelector('.cotizador-pdf');

        if (!this.precios.length) {
            vacio.hidden = false;
            [form, this.listaLineas, this.total, this.botonPdf].forEach(el => { el.hidden = true; });
            return;
        }

        const clientes = (window.baseDatos.datos.clientes || []).map(c => c.nombre).filter(Boolean);
        const lista = contenedor.querySelector('#cot-clientes');
        [...new Set(clientes)].sort((a, b) => a.localeCompare(b, 'es')).forEach(nombre => {
            const o = document.createElement('option');
            o.value = nombre;
            lista.appendChild(o);
        });
        if (this.cliente) this.inputCliente.value = this.cliente;

        this.precios.forEach((p, i) => {
            const o = document.createElement('option');
            o.value = i;
            o.textContent = `${p.nombre} · ${p.moneda}${dinero(p.precio)} / ${p.unidad}`;
            this.selectProducto.appendChild(o);
        });

        this.inputCliente.addEventListener('input', () => {
            this.cliente = this.inputCliente.value;
            this.error(this.inputCliente, '');
        });
        this.inputCantidad.addEventListener('input', () => this.error(this.inputCantidad, ''));
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.agregar();
        });
        this.botonPdf.addEventListener('click', () => this.descargar());
        this.pintarLineas();
    }

    error(control, mensaje) {
        const p = document.getElementById(control.getAttribute('aria-describedby'));
        p.textContent = mensaje;
        p.hidden = !mensaje;
        if (mensaje) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
    }

    agregar() {
        const cantidad = Number(this.inputCantidad.value);
        if (!Number.isInteger(cantidad) || cantidad < 1) {
            this.error(this.inputCantidad, 'Escribe una cantidad entera, 1 o más.');
            this.inputCantidad.focus();
            return;
        }
        this.error(this.inputCantidad, '');
        const producto = this.precios[this.selectProducto.value].nombre;
        const existente = this.lineas.find(l => l.producto === producto);
        if (existente) existente.cantidad += cantidad;
        else this.lineas.push({ producto, cantidad });
        this.pintarLineas();
    }

    // Líneas con su precio actual; totales por moneda (por si la lista mezcla RD$ y US$)
    calcular() {
        const filas = this.lineas.map(l => {
            const p = this.precios.find(x => x.nombre === l.producto);
            return { ...l, ...p, subtotal: p.precio * l.cantidad };
        });
        const totales = new Map();
        filas.forEach(f => totales.set(f.moneda, (totales.get(f.moneda) || 0) + f.subtotal));
        return { filas, totales: [...totales].map(([moneda, total]) => `${moneda}${dinero(total)}`) };
    }

    pintarLineas() {
        const { filas, totales } = this.calcular();
        this.listaLineas.innerHTML = '';
        filas.forEach(f => {
            const li = document.createElement('li');
            const texto = document.createElement('span');
            texto.textContent = `${f.cantidad} × ${f.nombre}`;
            const importe = document.createElement('span');
            importe.className = 'cotizador-importe';
            importe.textContent = `${f.moneda}${dinero(f.subtotal)}`;
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'btn-texto';
            quitar.textContent = 'Quitar';
            quitar.setAttribute('aria-label', `Quitar ${f.nombre} de la cotización`);
            quitar.addEventListener('click', () => {
                this.lineas = this.lineas.filter(l => l.producto !== f.producto);
                this.pintarLineas();
                this.selectProducto.focus();
            });
            li.append(texto, importe, quitar);
            this.listaLineas.appendChild(li);
        });
        this.listaLineas.hidden = !filas.length;
        this.total.textContent = filas.length ? `Total: ${totales.join(' + ')}` : 'Añade productos para cotizar.';
        this.botonPdf.disabled = !filas.length;
    }

    descargar() {
        const cliente = this.inputCliente.value.trim();
        if (!cliente) {
            this.error(this.inputCliente, 'Escribe para quién es la cotización.');
            this.inputCliente.focus();
            return;
        }
        if (!window.jspdf) {
            window.alert('No se pudo cargar el generador de PDF. Revisa la conexión y recarga la página.');
            return;
        }
        const { filas, totales } = this.calcular();
        const hoy = new Date();
        const numero = `COT-${hoyISO().replace(/-/g, '')}-${String(hoy.getHours()).padStart(2, '0')}${String(hoy.getMinutes()).padStart(2, '0')}`;
        const fecha = hoy.toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });

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
        doc.text('Semillas de hortalizas · República Dominicana', margen, 22);

        doc.setTextColor(20, 40, 28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('Cotización', margen, 44);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Nº ${numero}`, derecha, 44, { align: 'right' });
        doc.text(`Fecha: ${fecha}`, margen, 52);
        doc.text(`Cliente: ${cliente}`, margen, 58);

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
        filas.forEach(f => {
            const nombre = doc.splitTextToSize(f.nombre, 72);
            if (y + nombre.length * 5 > alto - 40) {
                doc.addPage();
                y = margen + 5;
                cabeceraTabla();
            }
            doc.text(nombre, col.producto, y);
            doc.text(String(f.cantidad), col.cantidad, y, { align: 'right' });
            doc.text(`${f.moneda}${dinero(f.precio)} / ${f.unidad}`, col.precio, y, { align: 'right' });
            doc.text(`${f.moneda}${dinero(f.subtotal)}`, col.subtotal, y, { align: 'right' });
            y += nombre.length * 5 + 3;
            doc.setDrawColor(220, 230, 224);
            doc.line(margen, y - 4, derecha, y - 4);
        });

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`Total: ${totales.join(' + ')}`, derecha, y + 4, { align: 'right' });

        // Pie: de dónde salen los precios y quién la preparó
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(90, 110, 98);
        const preparo = window.responsable ? window.responsable.nombre : '';
        const pie = [`Precios de la lista vigente en la oficina el ${fecha}.`, preparo && `Preparada por ${preparo}.`].filter(Boolean);
        doc.text(pie, margen, alto - 18);

        const archivo = `Cotizacion_${cliente.replace(/[^\p{L}\p{N}]+/gu, '_')}_${hoyISO()}.pdf`;
        // En la app Android no hay descargas del navegador: el PDF se entrega a Android, que lo guarda en Descargas
        if (window.AndroidApp) window.AndroidApp.guardarArchivo(archivo, doc.output('datauristring').split(',')[1], 'application/pdf');
        else doc.save(archivo);
    }
}

window.cotizador = new Cotizador();
