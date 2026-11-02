/**
 * App de escritorio de Semences del Caribe (Windows y Mac) con Electron: la misma app web, dentro de una ventana.
 *
 * - La web va dentro de la app (carpeta web/, la prepara herramientas/preparar-web.mjs) y se sirve con un protocolo
 *   propio, app://semences, que el backend tiene en sus ORIGENES. Nada de file:// (sin origen, inseguro).
 * - Seguridad: aislamiento de contexto, sandbox, sin Node en la página, política de contenido (CSP), solo se navega
 *   dentro de la app; los enlaces externos (Google, WhatsApp, Meet, correo) se abren en el navegador del sistema.
 * - Inicio de sesión con Google: Google no permite entrar desde una ventana de Electron, así que se abre en el
 *   navegador del sistema y el backend vuelve con semences://sesion?codigo=…, que el sistema entrega a esta app
 *   (protocolo registrado al instalar). Windows lo pasa como argumento; Mac, con el evento open-url.
 */
const { app, BrowserWindow, protocol, net, shell, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ESQUEMA = 'app';
const ORIGEN = 'app://semences';
const WEB = path.join(__dirname, 'web');
const PROTOCOLO_VUELTA = 'semences';

// Política de contenido de la página: solo sus propios archivos; estilos en línea (los usa la interfaz),
// fuentes de Google, fotos de las cuentas de Google y llamadas por https al backend
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self' https:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
].join('; ');

protocol.registerSchemesAsPrivileged([
    { scheme: ESQUEMA, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let ventana = null;
let enlacePendiente = null;

// Una sola copia abierta: si se abre otra (p. ej. el enlace de vuelta de Google en Windows), avisa a la primera
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (evento, argumentos) => {
        entregarEnlace(argumentos.find(a => a.startsWith(`${PROTOCOLO_VUELTA}://`)));
        if (ventana) {
            if (ventana.isMinimized()) ventana.restore();
            ventana.focus();
        }
    });
}

// semences:// abre esta app (al instalar lo registra el instalador; en desarrollo, aquí)
if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOLO_VUELTA, process.execPath, [path.resolve(process.argv[1])]);
} else {
    app.setAsDefaultProtocolClient(PROTOCOLO_VUELTA);
}

// Mac entrega el enlace con este evento (también si la app estaba cerrada: antes de "ready")
app.on('open-url', (evento, url) => {
    evento.preventDefault();
    entregarEnlace(url);
});

function entregarEnlace(url) {
    if (!url || !String(url).startsWith(`${PROTOCOLO_VUELTA}://`)) return;
    if (ventana && !ventana.webContents.isLoading()) ventana.webContents.send('enlace', String(url));
    else enlacePendiente = String(url);
}

// Archivo de la app para una dirección app://semences/…, sin salir nunca de la carpeta web/
function archivoDe(url) {
    const { pathname } = new URL(url);
    const relativo = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const archivo = path.normalize(path.join(WEB, relativo));
    return archivo.startsWith(WEB + path.sep) ? archivo : null;
}

const esDeLaApp = (url) => {
    try { return new URL(url).origin === ORIGEN; } catch (e) { return false; }
};
const esExternoPermitido = (url) => /^(https:|mailto:|tel:)/i.test(String(url));

// Las peticiones del puente solo valen si vienen de la página de la app
const remitenteValido = (evento) => esDeLaApp(evento.senderFrame ? evento.senderFrame.url : '');

function crearVentana() {
    ventana = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 960,
        minHeight: 620,
        backgroundColor: '#0B1F14',
        title: 'Semences del Caribe',
        icon: path.join(__dirname, 'recursos', 'icono.png'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            spellcheck: false
        }
    });
    ventana.once('ready-to-show', () => ventana.show());

    // Ventanas nuevas (target=_blank): fuera, al navegador del sistema
    ventana.webContents.setWindowOpenHandler(({ url }) => {
        if (esExternoPermitido(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    // Navegar fuera de la app (p. ej. al inicio de sesión de Google): se abre en el navegador del sistema
    ventana.webContents.on('will-navigate', (evento, url) => {
        if (esDeLaApp(url)) return;
        evento.preventDefault();
        if (esExternoPermitido(url)) shell.openExternal(url);
    });
    ventana.webContents.on('did-finish-load', () => {
        if (enlacePendiente) {
            ventana.webContents.send('enlace', enlacePendiente);
            enlacePendiente = null;
        }
    });
    ventana.on('closed', () => { ventana = null; });
    ventana.loadURL(`${ORIGEN}/index.html`);
}

app.whenReady().then(() => {
    // Windows y Linux: la app se abrió con el enlace como argumento
    entregarEnlace(process.argv.find(a => a.startsWith(`${PROTOCOLO_VUELTA}://`)));

    protocol.handle(ESQUEMA, async (peticion) => {
        const archivo = archivoDe(peticion.url);
        if (!archivo || !fs.existsSync(archivo)) return new Response('No encontrado', { status: 404 });
        const respuesta = await net.fetch(pathToFileURL(archivo).toString());
        const cabeceras = new Headers(respuesta.headers);
        if (archivo.endsWith('.html')) cabeceras.set('Content-Security-Policy', CSP);
        cabeceras.set('X-Content-Type-Options', 'nosniff');
        return new Response(respuesta.body, { status: respuesta.status, headers: cabeceras });
    });

    // Permisos del navegador: solo avisos del sistema y copiar al portapapeles (enlace de la app)
    session.defaultSession.setPermissionRequestHandler((contenidos, permiso, responder) => {
        responder(['notifications', 'clipboard-sanitized-write'].includes(permiso) && esDeLaApp(contenidos.getURL()));
    });

    ipcMain.on('abrir-externo', (evento, url) => {
        if (remitenteValido(evento) && /^https:\/\//i.test(String(url))) shell.openExternal(String(url));
    });
    ipcMain.handle('tomar-enlace-pendiente', (evento) => {
        if (!remitenteValido(evento)) return null;
        const url = enlacePendiente;
        enlacePendiente = null;
        return url;
    });
    // Cotización en PDF: "Guardar como", con Descargas por defecto
    ipcMain.handle('guardar-archivo', async (evento, { nombre, base64, tipo }) => {
        if (!remitenteValido(evento)) return { ok: false };
        const limpio = path.basename(String(nombre || 'archivo.pdf')).replace(/[^\p{L}\p{N}._ -]+/gu, '_');
        const extension = path.extname(limpio).slice(1) || 'pdf';
        const { canceled, filePath } = await dialog.showSaveDialog(ventana, {
            title: 'Guardar',
            defaultPath: path.join(app.getPath('downloads'), limpio),
            filters: [{ name: tipo === 'application/pdf' ? 'Documento PDF' : 'Archivo', extensions: [extension] }]
        });
        if (canceled || !filePath) return { ok: false, cancelado: true };
        await fs.promises.writeFile(filePath, Buffer.from(String(base64 || ''), 'base64'));
        shell.showItemInFolder(filePath);
        return { ok: true };
    });

    crearVentana();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) crearVentana(); });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
