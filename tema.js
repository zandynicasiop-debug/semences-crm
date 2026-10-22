/**
 * Tema claro u oscuro de la interfaz. Por defecto sigue al teléfono o al ordenador (modo automático);
 * en el menú de módulos se puede fijar "claro" (para leer a pleno sol en el campo) u "oscuro".
 * La elección se guarda en este dispositivo. Se carga en <head> para que la página no parpadee al abrir.
 */
const TEMAS = ['auto', 'claro', 'oscuro'];
const NOMBRE_TEMA = { auto: 'automático', claro: 'claro', oscuro: 'oscuro' };
const COLOR_BARRA = { claro: '#F0FDF4', oscuro: '#0B1F14' }; // Barra del navegador: --sdc-claro y --sdc-fondo

function temaGuardado() {
    try {
        const tema = localStorage.getItem('sdc_tema');
        return TEMAS.includes(tema) ? tema : 'auto';
    } catch (e) {
        return 'auto';
    }
}

function aplicarTema(tema) {
    const raiz = document.documentElement;
    if (tema === 'auto') delete raiz.dataset.tema;
    else raiz.dataset.tema = tema;
    const claro = tema === 'claro' || (tema === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    const barra = document.querySelector('meta[name="theme-color"]');
    if (barra) barra.content = COLOR_BARRA[claro ? 'claro' : 'oscuro'];
    const opcion = document.getElementById('menu-tema');
    if (opcion) opcion.textContent = `Tema: ${NOMBRE_TEMA[tema]}`;
}

aplicarTema(temaGuardado());
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => aplicarTema(temaGuardado()));

// Opción del menú de módulos, junto a "Compartir la app" (pwa.js la crea en "load"): cada toque pasa
// a automático › claro › oscuro
window.addEventListener('load', () => setTimeout(() => {
    const lista = document.getElementById('lista-modulos');
    if (!lista) return;
    const opcion = document.createElement('button');
    opcion.type = 'button';
    opcion.id = 'menu-tema';
    opcion.className = 'menu-extra';
    opcion.addEventListener('click', () => {
        const siguiente = TEMAS[(TEMAS.indexOf(temaGuardado()) + 1) % TEMAS.length];
        try { localStorage.setItem('sdc_tema', siguiente); } catch (e) { /* Sin almacenamiento: solo esta visita */ }
        aplicarTema(siguiente);
        if (window.equipo) window.equipo.mostrarAviso(`Tema ${NOMBRE_TEMA[siguiente]}.`);
    });
    const compartir = document.getElementById('menu-compartir');
    if (compartir) {
        compartir.before(opcion);
    } else {
        const separador = document.createElement('hr');
        separador.className = 'menu-separador';
        lista.append(separador, opcion);
    }
    aplicarTema(temaGuardado());
}));
