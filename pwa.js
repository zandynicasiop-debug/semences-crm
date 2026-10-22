/**
 * App instalable (PWA): registra el service worker (sw.js) para abrir sin conexión y añade al menú de
 * módulos "Instalar la app". En Chrome (Android, Mac, Windows) abre el instalador del navegador;
 * en iPhone y iPad explica cómo añadirla a la pantalla de inicio desde Safari.
 * Dentro de la app Android (APK) no hace nada: allí la app ya está instalada.
 *
 * También añade "Compartir la app con el equipo": el menú de compartir del teléfono (WhatsApp, correo…)
 * o, en el ordenador, WhatsApp con el mensaje y el enlace ya escritos.
 */
const EN_APK = Boolean(window.AndroidApp);
const INSTALADA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const ES_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let avisoInstalacion = null; // El evento del navegador que permite abrir su instalador

if (!EN_APK && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // Sin esperar a "load": ese evento llega después de construir toda la escena 3D
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker no registrado:', e));
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    avisoInstalacion = e;
    mostrarOpcionInstalar();
});

window.addEventListener('appinstalled', () => {
    avisoInstalacion = null;
    const opcion = document.getElementById('menu-instalar');
    if (opcion) opcion.hidden = true;
    if (window.equipo) window.equipo.mostrarAviso('App instalada: ya la tienes con su icono.');
});

function mostrarOpcionInstalar() {
    const opcion = document.getElementById('menu-instalar');
    if (opcion) opcion.hidden = EN_APK || INSTALADA || !(avisoInstalacion || ES_IOS);
}

function crearOpcionInstalar() {
    const lista = document.getElementById('lista-modulos');
    if (!lista) return;
    const separador = document.createElement('hr');
    separador.className = 'menu-separador';
    const opcion = document.createElement('button');
    opcion.type = 'button';
    opcion.id = 'menu-instalar';
    opcion.className = 'menu-extra';
    opcion.textContent = 'Instalar la app en este dispositivo';
    opcion.hidden = true;
    opcion.addEventListener('click', async () => {
        lista.hidden = true;
        document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
        if (avisoInstalacion) {
            avisoInstalacion.prompt();
            await avisoInstalacion.userChoice;
            avisoInstalacion = null;
            mostrarOpcionInstalar();
        } else {
            explicarIOS();
        }
    });
    const compartir = document.createElement('button');
    compartir.type = 'button';
    compartir.id = 'menu-compartir';
    compartir.className = 'menu-extra';
    compartir.textContent = 'Compartir la app con el equipo';
    compartir.hidden = EN_APK;
    compartir.addEventListener('click', () => {
        lista.hidden = true;
        document.getElementById('btn-modulos').setAttribute('aria-expanded', 'false');
        compartirApp();
    });
    lista.append(separador, compartir, opcion);
    // El separador solo se ve si hay alguna opción debajo
    const pintarSeparador = () => { separador.hidden = opcion.hidden && compartir.hidden; };
    new MutationObserver(pintarSeparador).observe(opcion, { attributes: true, attributeFilter: ['hidden'] });
    mostrarOpcionInstalar();
    pintarSeparador();
}

// Enlace de la app publicada (sin parámetros); vacío si se abre desde el ordenador sin publicar
function enlacePublico() {
    const local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    return local ? '' : location.origin + location.pathname.replace(/index\.html$/, '');
}

async function compartirApp() {
    const enlace = enlacePublico();
    if (!enlace) {
        if (window.equipo) window.equipo.mostrarAviso('Primero publica la app (ver apps-script/DESPLIEGUE.md): desde este ordenador el enlace no le sirve a nadie más.', 'alerta');
        return;
    }
    const texto = 'Semences del Caribe · CRM del equipo. Ábrela aquí y, en el móvil, instálala desde el menú de módulos › Instalar la app:';
    // En el móvil: el menú de compartir del sistema (WhatsApp, correo, Telegram…)
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Semences del Caribe · CRM', text: texto, url: enlace });
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // La persona cerró el menú
        }
    }
    // En el ordenador: WhatsApp (web o app) con el mensaje ya escrito
    window.open(`https://wa.me/?text=${encodeURIComponent(`🌱 ${texto}\n${enlace}`)}`, '_blank', 'noopener');
}

// iPhone y iPad no tienen instalador: se añade desde el menú Compartir de Safari
function explicarIOS() {
    const dialogo = document.createElement('dialog');
    dialogo.className = 'dialogo';
    dialogo.setAttribute('aria-labelledby', 'instalar-titulo');
    dialogo.innerHTML = `
        <div class="dialogo-form">
            <h3 id="instalar-titulo">Instalar en iPhone o iPad</h3>
            <ol class="pasos-instalar">
                <li>Abre esta página en <b>Safari</b>.</li>
                <li>Toca el botón <b>Compartir</b> (el cuadrado con la flecha hacia arriba).</li>
                <li>Elige <b>Añadir a pantalla de inicio</b> y toca <b>Añadir</b>.</li>
            </ol>
            <p class="dialogo-nota">Aparece el icono de Semences y la app se abre a pantalla completa, también sin conexión.</p>
            <div class="modal-actions"><button type="button" class="btn-primary">Entendido</button></div>
        </div>`;
    dialogo.querySelector('button').addEventListener('click', () => dialogo.close());
    dialogo.addEventListener('close', () => dialogo.remove());
    document.body.appendChild(dialogo);
    dialogo.showModal();
}

window.addEventListener('load', crearOpcionInstalar);
