/**
 * Service worker: la app abre sin conexión una vez visitada.
 *
 * - Archivos de la app: primero la red (así llegan las actualizaciones) y, sin conexión, la copia guardada.
 * - Librerías y fuentes de los CDN (URLs con versión fija): primero la copia guardada.
 * - Lo demás (el Apps Script de Google, Chat…) no pasa por aquí: siempre va a la red.
 * Al publicar cambios grandes, sube VERSION para descartar las copias viejas.
 */
const VERSION = 'semences-v28'; // Sube en cada publicación con cambios: descarta las copias viejas
const APP = [
    './', './index.html', './style.css', './manifest.webmanifest',
    './googleSync.js', './app.js', './colaEtapas.js', './datos.js', './usuario.js', './mapa.js', './cotizador.js',
    './crm.js', './equipo.js', './tareas.js', './tablero.js', './bandejaInstagram.js', './panel.js', './reporte.js', './accesos.js', './agenda.js', './reunionesMetas.js', './auditoria.js', './pwa.js', './ventana.js', './tema.js', './textosIngles.js', './idioma.js',
    './iconos/icono-192.png', './iconos/icono-512.png',
    './marcas/gautier.png', './marcas/hexagon.png', './marcas/genome.png', './marcas/fito.png'
];
// Las mismas direcciones que index.html. Se piden en modo CORS (como las pide la página con integrity):
// una copia "opaca" no serviría a un <script crossorigin> y el navegador la rechazaría
const CDN = [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js'
];
const ORIGENES_CDN = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (evento) => {
    evento.waitUntil(caches.open(VERSION).then(async (cache) => {
        await cache.addAll(APP);
        // Las librerías se guardan una a una: si un CDN falla, la instalación sigue
        await Promise.all(CDN.map(url => cache.add(new Request(url, { mode: 'cors' })).catch(() => {})));
    }));
    self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
    evento.waitUntil(caches.keys()
        .then(claves => Promise.all(claves.filter(c => c !== VERSION).map(c => caches.delete(c))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (evento) => {
    const peticion = evento.request;
    if (peticion.method !== 'GET') return;
    const url = new URL(peticion.url);

    if (url.origin === self.location.origin) {
        // Sin la caché del navegador (el hosting marca el código para 7 días): así nunca se mezcla una
        // página nueva con un estilo o un archivo viejo. La navegación no admite opciones: va tal cual
        const desdeRed = peticion.mode === 'navigate' ? fetch(peticion) : fetch(peticion, { cache: 'no-cache' });
        evento.respondWith(desdeRed
            .then(respuesta => {
                if (respuesta.ok) {
                    const copia = respuesta.clone();
                    caches.open(VERSION).then(cache => cache.put(peticion, copia));
                }
                return respuesta;
            })
            .catch(() => caches.match(peticion, { ignoreSearch: true })
                .then(guardada => guardada || caches.match('./index.html'))));
        return;
    }

    if (ORIGENES_CDN.includes(url.origin)) {
        evento.respondWith(caches.match(peticion).then(guardada => guardada || fetch(peticion).then(respuesta => {
            // Solo se guarda lo que llegó bien (o la hoja de fuentes, que llega "opaca"): un 404 o un 500
            // del CDN guardado aquí se serviría para siempre en lugar de la librería
            if (respuesta.ok || respuesta.type === 'opaque') {
                const copia = respuesta.clone();
                caches.open(VERSION).then(cache => cache.put(peticion, copia));
            }
            return respuesta;
        })));
    }
});

// ----- Avisos push (backend): llegan aunque la app esté cerrada -----
self.addEventListener('push', (evento) => {
    let datos = {};
    try { datos = evento.data ? evento.data.json() : {}; } catch (e) { datos = { texto: evento.data ? evento.data.text() : '' }; }
    const titulo = datos.titulo || 'Semences del Caribe · Aviso del equipo';
    evento.waitUntil(self.registration.showNotification(titulo, {
        body: datos.texto || '',
        icon: 'iconos/icono-192.png',
        badge: 'iconos/icono-192.png',
        lang: 'es',
        tag: `aviso-${Date.now()}`,
        data: { url: self.registration.scope }
    }));
});

// Al tocar el aviso: vuelve a la app si ya está abierta; si no, la abre
self.addEventListener('notificationclick', (evento) => {
    evento.notification.close();
    const destino = (evento.notification.data && evento.notification.data.url) || self.registration.scope;
    evento.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
        const abierta = ventanas.find(v => v.url.startsWith(self.registration.scope));
        return abierta ? abierta.focus() : self.clients.openWindow(destino);
    }));
});
