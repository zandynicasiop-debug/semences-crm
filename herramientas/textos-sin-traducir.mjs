#!/usr/bin/env node
/**
 * Lista los textos de la app que siguen en español con la app en inglés: los literales del código que
 * parecen texto para leer ('Guardar cambios', `Sincronizado hace ${s} s`…) y que textosIngles.js no traduce.
 * Para los que llevan datos (${…}) prueba con un dato cualquiera. Es una ayuda, no una prueba: salen también
 * algunos falsos avisos (nombres de marcas, textos que van a Google Chat o al PDF y se quedan en español).
 *
 *   node herramientas/textos-sin-traducir.mjs [archivo.js…]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ARCHIVOS } from './preparar-web.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_SON_DE_LA_PANTALLA = ['textosIngles.js', 'idioma.js', 'tema.js'];

// El traductor de la app, cargado como en la página y con la app en inglés
const contexto = { localStorage: { getItem: () => 'en', setItem() {} }, document: { documentElement: {}, addEventListener() {} },
    MutationObserver: class { observe() {} }, Node: {}, NodeFilter: {}, alert() {}, confirm() {}, prompt() {} };
contexto.window = contexto;
vm.createContext(contexto);
for (const archivo of ['textosIngles.js', 'idioma.js']) vm.runInContext(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'), contexto);
const traducir = contexto.traducir;

// ¿Parece texto para leer y en español? (fuera identificadores, clases, selectores, rutas, tipos MIME…)
const ESPANOL = /[áéíóúñ¿¡]|\b(de|del|la|las|los|el|en|con|para|que|por|una?|sin|tu|tus|se|al|y|hay|ya|no|es|más)\b/i;
function pareceTexto(texto) {
    if (!/\p{L}{3}/u.test(texto) || !ESPANOL.test(texto)) return false;
    if (/^[\w.-]+$/.test(texto) && !/^[A-ZÁÉÍÓÚÑ]/.test(texto)) return false;
    if (/^([.#[]|<\w|https?:|\/|data:|application\/|image\/)/.test(texto)) return false;
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b|=>|\(\)|;\s*$/.test(texto)) return false;
    return true;
}

const archivos = process.argv.slice(2).length ? process.argv.slice(2)
    : ARCHIVOS.filter(a => a.endsWith('.js') && !NO_SON_DE_LA_PANTALLA.includes(a)).concat('index.html');
let total = 0;
for (const archivo of archivos) {
    const lineas = fs.readFileSync(path.join(RAIZ, archivo), 'utf8').split('\n');
    const faltan = [];
    lineas.forEach((linea, i) => {
        if (/^\s*(\/\/|\*|\/\*|<!--)/.test(linea) || /console\.(log|warn|error)/.test(linea)) return;
        for (const m of linea.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]+)</g)) {
            // Los ${…} se cambian por un dato de ejemplo (pegados a una palabra son un plural: «aviso${…}» → «aviso»);
            // el HTML de dentro se trata como texto suelto
            const texto = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/(\p{L})\$\{[^}]*\}/gu, '$1').replace(/\$\{[^}]*\}/g, '3').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (pareceTexto(texto) && traducir(texto) === texto) faltan.push(`  ${i + 1}: ${texto.slice(0, 120)}`);
        }
    });
    if (faltan.length) console.log(`${archivo} (${faltan.length})\n${faltan.join('\n')}`);
    total += faltan.length;
}
console.log(total ? `\n${total} textos sin traducir (o falsos avisos)` : 'Todo traducido');
