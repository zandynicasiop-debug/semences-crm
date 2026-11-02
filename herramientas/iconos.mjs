#!/usr/bin/env node
/**
 * Genera los iconos y pantallas de inicio de las apps a partir del icono vectorial de la marca (el mismo de
 * android/icono/icono.html): Android (Capacitor), iPhone/iPad (Capacitor) y escritorio (Electron).
 * Solo hace falta volver a ejecutarlo si cambia el icono; las imágenes generadas van en el repositorio.
 *
 *   npm run iconos        (necesita Playwright con Chromium: npx playwright install chromium)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
    try { ({ chromium } = createRequire(path.join(process.env.PLAYWRIGHT_RAIZ || '', 'x'))('playwright')); } catch (e2) {
        console.error('Hace falta Playwright: npm i -D playwright && npx playwright install chromium (o PLAYWRIGHT_RAIZ=<carpeta node_modules>)');
        process.exit(1);
    }
}

const FONDO = '#0B1F14';
// Brote de Lucide (ISC), igual que en la web y en la app Android propia
const BROTE = `<path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/>
    <path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/>`;
const DEGRADADO = `<defs><radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#14532D"/><stop offset="1" stop-color="${FONDO}"/></radialGradient></defs>`;
const brote = (x, y, escala) => `<g transform="translate(${x} ${y}) scale(${escala})" fill="none" stroke="#4ADE80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BROTE}</g>`;

// Variantes en un lienzo de 512 × 512
const VARIANTES = {
    // Círculo con el brote (icono clásico de Android y de escritorio), fondo transparente
    redondo: `${DEGRADADO}<circle cx="256" cy="256" r="248" fill="url(#g)"/><circle cx="256" cy="256" r="246" fill="none" stroke="#22C55E" stroke-opacity="0.45" stroke-width="4"/>${brote(106, 96, 12.5)}`,
    // Cuadrado lleno (iOS redondea las esquinas él mismo y no admite transparencia)
    cuadrado: `${DEGRADADO}<rect width="512" height="512" fill="url(#g)"/>${brote(106, 96, 12.5)}`,
    // Solo el brote, dentro de la zona segura del icono adaptable de Android (el 66 % central)
    primerplano: brote(160, 150, 8)
};

function svg(variante, lado, fondo = '') {
    const cuerpo = VARIANTES[variante];
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${fondo || 'transparent'}}</style></head><body>
<svg width="${lado}" height="${lado}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">${cuerpo}</svg></body></html>`;
}

// Pantalla de inicio: fondo de la marca y el icono redondo en el centro
function pantalla(ancho, alto, proporcion = 0.28) {
    const lado = Math.round(Math.min(ancho, alto) * proporcion * (Math.max(ancho, alto) / Math.min(ancho, alto) > 1.2 ? 1.25 : 1));
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${ancho}px;height:${alto}px;background:${FONDO};display:flex;align-items:center;justify-content:center}</style></head><body>
<svg width="${lado}" height="${lado}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">${VARIANTES.redondo}</svg></body></html>`;
}

const ANDROID = path.join(RAIZ, 'movil/android/app/src/main/res');
const IOS = path.join(RAIZ, 'movil/ios/App/App/Assets.xcassets');
const DENSIDADES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const navegador = await chromium.launch();
const pagina = await navegador.newPage();
async function render(html, ancho, alto, destino, { opaco = false } = {}) {
    await pagina.setViewportSize({ width: ancho, height: alto });
    await pagina.setContent(html);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    await pagina.screenshot({ path: destino, omitBackground: !opaco, clip: { x: 0, y: 0, width: ancho, height: alto } });
}

let n = 0;
for (const [densidad, f] of Object.entries(DENSIDADES)) {
    const mipmap = path.join(ANDROID, `mipmap-${densidad}`);
    await render(svg('redondo', 48 * f), 48 * f, 48 * f, path.join(mipmap, 'ic_launcher.png'));
    await render(svg('redondo', 48 * f), 48 * f, 48 * f, path.join(mipmap, 'ic_launcher_round.png'));
    await render(svg('primerplano', 108 * f), 108 * f, 108 * f, path.join(mipmap, 'ic_launcher_foreground.png'));
    const [pa, pl] = [{ mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] }[densidad]][0];
    await render(pantalla(pa, pl), pa, pl, path.join(ANDROID, `drawable-port-${densidad}`, 'splash.png'), { opaco: true });
    await render(pantalla(pl, pa), pl, pa, path.join(ANDROID, `drawable-land-${densidad}`, 'splash.png'), { opaco: true });
    n += 5;
}
await render(pantalla(480, 320), 480, 320, path.join(ANDROID, 'drawable', 'splash.png'), { opaco: true });
fs.writeFileSync(path.join(ANDROID, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${FONDO}</color>\n</resources>\n`);

// iPhone y iPad: un icono de 1024 sin transparencia y la pantalla de inicio de 2732 (la del iPad Pro)
await render(svg('cuadrado', 1024, FONDO), 1024, 1024, path.join(IOS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), { opaco: true });
for (const nombre of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await render(pantalla(2732, 2732, 0.18), 2732, 2732, path.join(IOS, 'Splash.imageset', nombre), { opaco: true });
}

// Escritorio (Electron): 1024 con transparencia; electron-builder saca de aquí el .ico y el .icns
await render(svg('redondo', 1024), 1024, 1024, path.join(RAIZ, 'escritorio/recursos/icono.png'));
await navegador.close();
console.log(`Listo: ${n + 6} imágenes de Android, 4 de iOS y el icono de escritorio`);
