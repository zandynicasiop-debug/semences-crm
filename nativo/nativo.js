/**
 * Puente entre la app web y la app nativa que la contiene: Capacitor (Android, iPhone, iPad) o Electron
 * (Windows, Mac). Va antes que los demás scripts (lo añade herramientas/preparar-web.mjs) y crea
 * window.AppNativa, con la misma forma que el objeto Java de la app Android propia (window.AndroidApp):
 *
 *   plataforma                       'android' | 'ios' | 'escritorio'
 *   abrirExterno(url)                abre una dirección en el navegador del sistema. Google no deja entrar
 *                                    desde dentro de una app: el inicio de sesión se abre fuera
 *   tomarVueltaGoogle()              JSON { codigo, error } de la última vuelta de Google (semences://sesion),
 *                                    o "null"; se entrega una sola vez
 *   guardarArchivo(nombre, b64, tipo) PDF de una cotización: compartir o guardar (móvil) o "Guardar como" (escritorio)
 *   actualizarWidget(json)           sin widget en estas apps: no hace nada
 *
 * Cuando llega la vuelta de Google, avisa a usuario.js con window.alVolverDeGoogle(), igual que Android.
 * En un navegador normal no hace nada: window.AppNativa queda como esté (googleSync.js lo deja en null).
 */
(function () {
    'use strict';

    var cap = window.Capacitor;
    var enCapacitor = Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    var escritorio = window.semencesEscritorio || null; // Lo crea el preload de Electron (escritorio/preload.cjs)
    if (!enCapacitor && !escritorio) return;

    var vueltaPendiente = null;

    // semences://sesion?codigo=…  (o ?error=…): la vuelta del inicio de sesión que manda el backend
    function recibirEnlace(url) {
        var enlace;
        try { enlace = new URL(String(url || '')); } catch (e) { return false; }
        if (enlace.protocol !== 'semences:' || enlace.hostname !== 'sesion') return false;
        vueltaPendiente = { codigo: enlace.searchParams.get('codigo') || '', error: enlace.searchParams.get('error') || '' };
        if (typeof window.alVolverDeGoogle === 'function') window.alVolverDeGoogle();
        return true;
    }

    var nativa = {
        tomarVueltaGoogle: function () {
            var vuelta = vueltaPendiente;
            vueltaPendiente = null;
            return JSON.stringify(vuelta);
        },
        actualizarWidget: function () { /* Sin widget en Capacitor ni en Electron */ }
    };

    if (enCapacitor) {
        var P = cap.Plugins;
        nativa.plataforma = cap.getPlatform(); // 'android' o 'ios'
        // Chrome Custom Tabs (Android) o Safari (iPhone/iPad): Google sí permite entrar ahí
        nativa.abrirExterno = function (url) {
            P.Browser.open({ url: url }).catch(function () { window.open(url, '_blank'); });
        };
        // El PDF se guarda en la caché de la app y se abre el menú de compartir del sistema:
        // WhatsApp, correo, Drive o "Guardar en Archivos"
        nativa.guardarArchivo = function (nombre, base64, tipo) {
            var limpio = String(nombre || 'archivo.pdf').replace(/[^\p{L}\p{N}._-]+/gu, '_');
            return P.Filesystem.writeFile({ path: limpio, data: base64, directory: 'CACHE' })
                .then(function (r) { return P.Share.share({ title: limpio, dialogTitle: 'Guardar o enviar ' + limpio, files: [r.uri] }); })
                .catch(function (error) {
                    // Cancelar el menú de compartir no es un error
                    if (!/cancel/i.test(String(error && error.message))) window.alert('No se pudo guardar el archivo: ' + (error && error.message ? error.message : error));
                });
        };
        P.App.addListener('appUrlOpen', function (evento) {
            if (recibirEnlace(evento.url) && nativa.plataforma === 'ios') P.Browser.close().catch(function () {});
        });
        // La app estaba cerrada y la abrió el enlace de vuelta
        P.App.getLaunchUrl().then(function (r) { if (r && r.url) recibirEnlace(r.url); }).catch(function () {});
        // Botón "atrás" de Android: cierra lo abierto (android.js) y, si no queda nada, sale de la app
        P.App.addListener('backButton', function () {
            if (!(typeof window.atrasAndroid === 'function' && window.atrasAndroid())) P.App.exitApp();
        });
    } else {
        nativa.plataforma = 'escritorio';
        nativa.abrirExterno = function (url) { escritorio.abrirExterno(url); };
        nativa.guardarArchivo = function (nombre, base64, tipo) { return escritorio.guardarArchivo(nombre, base64, tipo); };
        escritorio.alRecibirEnlace(recibirEnlace);
        // La app se abrió con el enlace (Windows lo pasa al arrancar)
        escritorio.tomarEnlacePendiente().then(function (url) { if (url) recibirEnlace(url); });
    }

    window.AppNativa = nativa;
    document.documentElement.classList.add('app-nativa', 'app-' + nativa.plataforma);
})();
