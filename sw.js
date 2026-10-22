/**
 * Service worker: la app abre sin conexión una vez visitada.
 *
 * - Archivos de la app: primero la red (así llegan las actualizaciones) y, sin conexión, la copia guardada.
 * - Librerías y fuentes de los CDN (URLs con versión fija): primero la copia guardada.
 * - Lo demás (el Apps Script de Google, Chat…) no pasa por aquí: siempre va a la red.
 * Al publicar cambios grandes, sube VERSION para descartar las copias viejas.
 */
const VERSION = 'semences-v5';
const APP = [
    './', './index.html', './style.css', './manifest.webmanifest',
    './googleSync.js', './app.js', './datos.js', './usuario.js', './mapa.js', './cotizador.js',
    './crm.js', './equipo.js', './tareas.js', './pwa.js', './ventana.js', './tema.js',
    './iconos/icono-192.png', './iconos/icono-512.png',
    './marcas/gautier.png', './marcas/hexagon.png', './marcas/genome.png', './marcas/fito.png'
];
const CDN = [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];
const ORIGENES_CDN = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (evento) => {
    evento.waitUntil(caches.open(VERSION).then(async (cache) => {
        await cache.addAll(APP);
        // Las librerías se guardan una a una: si un CDN falla, la instalación sigue
        await Promise.all(CDN.map(url => cache.add(url).catch(() => {})));
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
        evento.respondWith(fetch(peticion)
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
            const copia = respuesta.clone();
            caches.open(VERSION).then(cache => cache.put(peticion, copia));
            return respuesta;
        })));
    }
});
