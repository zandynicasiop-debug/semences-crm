#!/usr/bin/env node
/**
 * Prepara la app web para empaquetarla dentro de una app nativa: Capacitor (Android, iPhone, iPad) o
 * Electron (Windows, Mac). Uso:
 *
 *   node herramientas/preparar-web.mjs --plataforma=capacitor   → www/            (webDir de Capacitor)
 *   node herramientas/preparar-web.mjs --plataforma=electron    → escritorio/web/
 *
 * Qué hace (lo mismo que android/build.sh para la app Android propia):
 * - Copia la página, los estilos, los scripts, iconos y logos.
 * - Las librerías (Three.js, OrbitControls, jsPDF) van dentro de la app (android/lib): abre sin conexión.
 *   Se cambian las direcciones del CDN por lib/… y se quitan los integrity (la app va firmada entera).
 * - Añade nativo.js antes de los demás scripts: el puente con la app (window.AppNativa).
 * - En Capacitor añade android.js (el botón "atrás" de Android).
 * - Con la variable SEMENCES_API escribe la dirección del backend en googleSync.js (como el flujo de GitHub).
 * - No copia sw.js: dentro de una app los archivos ya están en el dispositivo.
 *
 * Sin dependencias: solo Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentos = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const plataforma = argumentos.plataforma || 'capacitor';
if (!['capacitor', 'electron'].includes(plataforma)) {
    console.error('Uso: node herramientas/preparar-web.mjs --plataforma=capacitor|electron [--destino=carpeta]');
    process.exit(1);
}
const destino = path.resolve(RAIZ, argumentos.destino || (plataforma === 'capacitor' ? 'www' : 'escritorio/web'));

export const ARCHIVOS = [
    'index.html', 'style.css', 'manifest.webmanifest',
    'tema.js', 'googleSync.js', 'app.js', 'datos.js', 'usuario.js', 'mapa.js', 'cotizador.js',
    'crm.js', 'equipo.js', 'tareas.js', 'tablero.js', 'bandejaInstagram.js', 'pwa.js', 'ventana.js'
];
export const CARPETAS = ['iconos', 'marcas'];
// Mismas direcciones que index.html → copia local (idéntica byte a byte a la de npm, ver DOCUMENTACION_COMPLETA.md)
export const LIBRERIAS = {
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js': 'lib/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js': 'lib/OrbitControls.js',
    'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js': 'lib/jspdf.umd.min.js'
};

// index.html para la app: librerías locales, sin integrity, con nativo.js primero (y android.js en Capacitor)
export function adaptarIndex(html, { plataforma }) {
    let salida = html;
    for (const [cdn, local] of Object.entries(LIBRERIAS)) {
        if (!salida.includes(cdn)) throw new Error(`No encuentro ${cdn} en index.html`);
        salida = salida.replace(cdn, local);
    }
    salida = salida.replace(/(src="lib\/[^"]+")\s+integrity="[^"]+"\s+crossorigin="anonymous"/g, '$1');
    if (salida.includes('integrity=')) throw new Error('Quedó un integrity en index.html');
    const conector = '<script src="googleSync.js"></script>';
    if (!salida.includes(conector)) throw new Error('No encuentro googleSync.js en index.html');
    salida = salida.replace(conector, `<!-- Puente con la app (Capacitor o Electron): window.AppNativa -->\n    <script src="nativo.js"></script>\n    ${conector}`);
    if (plataforma === 'capacitor') {
        salida = salida.replace('</body>', '    <!-- Botón "atrás" de Android -->\n    <script src="android.js"></script>\n</body>');
    }
    return salida;
}

// googleSync.js con la dirección del backend (o tal cual, sin conexión, si no hay SEMENCES_API)
export function configurarConector(js, api) {
    if (!api) return js;
    const hueco = "    api: '',";
    if (!js.includes(hueco)) throw new Error(`No encuentro ${hueco} en googleSync.js`);
    return js.replace(hueco, `    api: ${JSON.stringify(api.trim().replace(/\/+$/, ''))},`);
}

function preparar() {
    fs.rmSync(destino, { recursive: true, force: true });
    fs.mkdirSync(path.join(destino, 'lib'), { recursive: true });
    for (const archivo of ARCHIVOS) fs.copyFileSync(path.join(RAIZ, archivo), path.join(destino, archivo));
    for (const carpeta of CARPETAS) fs.cpSync(path.join(RAIZ, carpeta), path.join(destino, carpeta), { recursive: true });
    for (const local of Object.values(LIBRERIAS)) fs.copyFileSync(path.join(RAIZ, 'android', local), path.join(destino, local));
    fs.copyFileSync(path.join(RAIZ, 'nativo', 'nativo.js'), path.join(destino, 'nativo.js'));
    if (plataforma === 'capacitor') fs.copyFileSync(path.join(RAIZ, 'android', 'android.js'), path.join(destino, 'android.js'));

    const index = path.join(destino, 'index.html');
    fs.writeFileSync(index, adaptarIndex(fs.readFileSync(index, 'utf8'), { plataforma }));
    const conector = path.join(destino, 'googleSync.js');
    const api = process.env.SEMENCES_API || '';
    fs.writeFileSync(conector, configurarConector(fs.readFileSync(conector, 'utf8'), api));

    const archivos = fs.readdirSync(destino, { recursive: true }).filter(f => fs.statSync(path.join(destino, f)).isFile()).length;
    console.log(`Listo: ${path.relative(RAIZ, destino)}/ para ${plataforma} (${archivos} archivos)${api ? ` · backend ${api}` : ' · sin backend (SEMENCES_API vacía): la app funciona sin conexión'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) preparar();
