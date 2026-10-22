/**
 * Ventana flotante para laptop y ordenador: la finca 3D en una ventana pequeña que queda siempre
 * encima de los demás programas (Document Picture-in-Picture de Chrome y Edge en Mac y Windows).
 * Arriba lleva las cifras de la finca; se puede girar, acercar y tocar edificios como en la página.
 * Al cerrarla, la finca vuelve a su sitio. En teléfonos, tablets y el APK la opción no aparece.
 */
class VentanaFlotante {
    constructor() {
        this.soportada = 'documentPictureInPicture' in window && !window.AndroidApp &&
            window.matchMedia('(pointer: fine)').matches;
        this.ventana = null;
    }

    crearOpcion() {
        const lista = document.getElementById('lista-modulos');
        if (!lista || !this.soportada) return;
        const opcion = document.createElement('button');
        opcion.type = 'button';
        opcion.id = 'menu-flotante';
        opcion.className = 'menu-extra';
        opcion.textContent = 'Ver la finca en una ventana flotante';
        opcion.addEventListener('click', () => {
            lista.hidden = true;
            document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
            this.abrir();
        });
        const separador = lista.querySelector('.menu-separador');
        if (separador) {
            separador.after(opcion);
            separador.hidden = false;
        } else {
            lista.appendChild(opcion);
        }
        this.opcion = opcion;
    }

    async abrir() {
        if (this.ventana) {
            this.ventana.focus();
            return;
        }
        const tablero = window.appDashboard;
        const escena = document.getElementById('canvas-container');
        if (!tablero || !escena) return;
        // Volver al simulador si se estaba en otro módulo, para que el lienzo tenga tamaño al moverlo
        const pestana = document.getElementById('tab-simulador');
        if (window.crm && pestana.getAttribute('aria-current') !== 'true') window.crm.activarPestana(pestana);

        let ventana;
        try {
            ventana = await window.documentPictureInPicture.requestWindow({ width: 520, height: 400 });
        } catch (e) {
            console.warn('Ventana flotante:', e);
            if (window.equipo) window.equipo.mostrarAviso('El navegador no permitió abrir la ventana flotante.', 'alerta');
            return;
        }
        this.ventana = ventana;
        const doc = ventana.document;
        doc.title = 'Semences · Finca 3D';
        document.querySelectorAll('link[rel="stylesheet"]').forEach(hoja => {
            const copia = doc.createElement('link');
            copia.rel = 'stylesheet';
            copia.href = hoja.href;
            doc.head.appendChild(copia);
        });
        doc.body.className = 'ventana-flotante';

        // Barra con las cifras de la finca (se copian de las tarjetas de la página cada segundo)
        const barra = doc.createElement('div');
        barra.className = 'flotante-barra';
        barra.setAttribute('aria-live', 'off');

        // En la página queda un aviso con un botón para traer la finca de vuelta
        const aviso = document.createElement('div');
        aviso.className = 'flotante-aviso';
        const texto = document.createElement('p');
        texto.textContent = 'La finca está en la ventana flotante.';
        const volver = document.createElement('button');
        volver.type = 'button';
        volver.className = 'btn-secondary';
        volver.textContent = 'Traer la finca aquí';
        volver.addEventListener('click', () => ventana.close());
        aviso.append(texto, volver);

        escena.replaceWith(aviso);
        doc.body.append(barra, escena);
        tablero.enVentanaFlotante = true;
        tablero.rafVentana = ventana;
        tablero.cambiarFuenteCuadros();

        const pintarBarra = () => {
            const valor = (id) => (document.getElementById(id) || {}).textContent || '–';
            barra.textContent = `Semillas ${valor('val-semillas')} · Parcelas ${valor('val-parcelas')} · Eficiencia ${valor('val-eficiencia')}`;
        };
        pintarBarra();
        const intervalo = setInterval(pintarBarra, 1000);

        const ajustar = () => window.dispatchEvent(new Event('resize'));
        ventana.addEventListener('resize', ajustar);
        // Los estilos tardan un instante en llegar a la ventana nueva
        setTimeout(ajustar, 50);
        setTimeout(ajustar, 400);

        ventana.addEventListener('pagehide', () => {
            clearInterval(intervalo);
            tablero.enVentanaFlotante = false;
            tablero.rafVentana = null;
            aviso.replaceWith(escena);
            this.ventana = null;
            // De vuelta en la página: el bucle vuelve al ritmo de la página y el lienzo a su tamaño
            tablero.cambiarFuenteCuadros();
            setTimeout(ajustar, 50);
        });
    }
}

window.ventanaFlotante = new VentanaFlotante();
window.addEventListener('load', () => setTimeout(() => window.ventanaFlotante.crearOpcion()));
