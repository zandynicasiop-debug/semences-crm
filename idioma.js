/**
 * Idioma de la app: español (el del código) o inglés. Se elige con el botón English / Español de la
 * cabecera o de la pantalla de entrada, queda en este dispositivo y la página se recarga para aplicarlo.
 *
 * El código escribe sus textos en español, como siempre. En inglés, este archivo traduce cada texto al
 * pintarse (textos, placeholder, title, aria-label y alt), con el diccionario de textosIngles.js: primero el
 * texto exacto y, si no está, los patrones de los textos con datos ("Sincronizado hace 5 s"). Lo que no
 * está en el diccionario se queda en español, así que un texto nuevo sin traducir no rompe nada.
 *
 * Lo que escribe el equipo (nombres, notas, mensajes) no se traduce: va dentro de translate="no", o en
 * campos de texto, que no se tocan. Para avisos, alert/confirm/prompt y textos de la finca 3D (que no son
 * del DOM) está traducir(texto). Las fechas y números usan LOCALE (es-DO o en-US).
 */
(() => {
    const CLAVE = 'sdc_idioma';
    let idioma = 'es';
    try {
        if (localStorage.getItem(CLAVE) === 'en') idioma = 'en';
    } catch (error) {
        // Sin almacenamiento (modo privado estricto): español
    }
    window.IDIOMA = idioma;
    window.LOCALE = idioma === 'en' ? 'en-US' : 'es-DO';
    document.documentElement.lang = idioma;

    const exactos = new Map();
    const ejemplos = new Map();
    const patrones = [];
    let cargado = false;
    function cargar() {
        if (cargado) return;
        cargado = true;
        for (const [es, en] of Object.entries(window.TEXTOS_EN || {})) exactos.set(es, en);
        for (const [es, en] of Object.entries(window.EJEMPLOS_EN || {})) ejemplos.set(es, en);
        for (const [es, en] of window.PATRONES_EN || []) patrones.push([new RegExp(`^${es}$`, 'u'), en]);
    }

    const SEPARADOR = ' · ';

    // Un dato de dentro de un patrón: se traduce si es un texto de la app ("En tránsito", "3 % de maduración");
    // si no (un nombre, una nota), se queda como está
    function dato(texto) {
        if (!texto) return '';
        return nucleo(texto.trim()) ?? texto;
    }

    function nucleo(texto) {
        const en = exactos.get(texto);
        if (en !== undefined) return en;
        for (const [re, plantilla] of patrones) {
            const r = re.exec(texto);
            if (!r) continue;
            const datos = r.slice(1).map(dato);
            return typeof plantilla === 'function' ? plantilla(...datos) : plantilla.replace(/\{(\d)\}/g, (_, n) => datos[Number(n) - 1] || '');
        }
        // «⚠️ 1 seguimiento vencido»: el símbolo de delante se queda y se traduce el resto
        const simbolo = /^(\p{Extended_Pictographic}\uFE0F?\s+)([\s\S]+)$/u.exec(texto);
        if (simbolo) {
            const en = nucleo(simbolo[2]);
            if (en !== undefined) return simbolo[1] + en;
        }
        // «Seguimiento · Finca López»: cada trozo por su lado
        if (texto.includes(SEPARADOR)) {
            const trozos = texto.split(SEPARADOR);
            const en = trozos.map(t => nucleo(t) ?? t);
            if (en.some((t, i) => t !== trozos[i])) return en.join(SEPARADOR);
        }
        return undefined;
    }

    // Un texto en inglés si lo hay; si no, el mismo. Respeta los espacios de los lados (trozos de innerHTML)
    function traducir(texto) {
        if (idioma === 'es' || typeof texto !== 'string') return texto;
        cargar();
        const partes = /^(\s*)([\s\S]*?)(\s*)$/.exec(texto);
        if (!partes[2] || !/\p{L}/u.test(partes[2])) return texto;
        const en = nucleo(partes[2]);
        return en === undefined ? texto : partes[1] + en + partes[3];
    }
    window.traducir = traducir;

    // Cambiar de idioma: se guarda y se recarga (la finca 3D y los paneles se pintan de nuevo ya traducidos)
    function cambiar(nuevo) {
        try {
            localStorage.setItem(CLAVE, nuevo === 'en' ? 'en' : 'es');
        } catch (error) {
            return;
        }
        location.reload();
    }

    // Botón con el otro idioma, escrito en ese idioma (English / Español)
    function crearBoton(clase = '') {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = `btn-idioma ${clase}`.trim();
        boton.setAttribute('translate', 'no');
        const otro = idioma === 'en' ? 'es' : 'en';
        boton.lang = otro;
        // En pantallas estrechas la cabecera solo deja sitio para «EN» / «ES» (style.css)
        boton.innerHTML = `<span class="idioma-largo">${otro === 'en' ? 'English' : 'Español'}</span><span class="idioma-corto" aria-hidden="true">${otro.toUpperCase()}</span>`;
        boton.title = otro === 'en' ? 'Change the app to English' : 'Cambiar la app a español';
        boton.addEventListener('click', () => cambiar(otro));
        return boton;
    }

    window.Idioma = { actual: idioma, traducir, cambiar, crearBoton };

    // La cabecera lleva su botón junto a la cuenta (en el teléfono, también en la hoja «Más»)
    document.addEventListener('DOMContentLoaded', () => {
        const cuenta = document.getElementById('btn-responsable');
        if (cuenta) cuenta.parentNode.insertBefore(crearBoton('btn-idioma-cabecera'), cuenta);
    });

    if (idioma === 'es') return;

    // ----- Inglés: traducir lo que se pinta -----
    const ATRIBUTOS = ['placeholder', 'title', 'aria-label', 'alt'];
    const FUERA = 'script, style, textarea, [translate="no"], [contenteditable="true"]';

    function traducirTexto(nodo) {
        const padre = nodo.parentElement;
        if (!padre || padre.closest(FUERA)) return;
        const en = traducir(nodo.data);
        if (en !== nodo.data) nodo.data = en;
    }
    function traducirAtributos(el) {
        if (el.closest(FUERA)) return;
        for (const nombre of ATRIBUTOS) {
            const valor = el.getAttribute(nombre);
            if (!valor) continue;
            const en = (nombre === 'placeholder' && ejemplos.get(valor.trim())) || traducir(valor);
            if (en !== valor) el.setAttribute(nombre, en);
        }
        // Botones hechos con <input type="button|submit">
        if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && el.value) {
            const en = traducir(el.value);
            if (en !== el.value) el.value = en;
        }
    }
    function traducirArbol(raiz) {
        if (raiz.nodeType === Node.TEXT_NODE) return traducirTexto(raiz);
        if (raiz.nodeType !== Node.ELEMENT_NODE) return;
        if (raiz.closest(FUERA)) return;
        traducirAtributos(raiz);
        const recorrido = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(FUERA) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        });
        for (let n = recorrido.nextNode(); n; n = recorrido.nextNode()) {
            if (n.nodeType === Node.TEXT_NODE) traducirTexto(n);
            else traducirAtributos(n);
        }
    }

    // Desde el primer momento: el HTML de la página según llega y todo lo que pinte después cada módulo.
    // Las mutaciones se atienden antes de pintar, así que no se llega a ver el español
    new MutationObserver((cambios) => {
        for (const c of cambios) {
            if (c.type === 'childList') c.addedNodes.forEach(traducirArbol);
            else if (c.type === 'characterData') traducirTexto(c.target);
            else if (c.type === 'attributes') traducirAtributos(c.target);
        }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATRIBUTOS });
    traducirArbol(document.documentElement);

    // Ventanas del navegador
    const alerta = window.alert.bind(window);
    const confirmar = window.confirm.bind(window);
    const preguntar = window.prompt.bind(window);
    window.alert = (texto) => alerta(traducir(String(texto ?? '')));
    window.confirm = (texto) => confirmar(traducir(String(texto ?? '')));
    window.prompt = (texto, valor) => preguntar(traducir(String(texto ?? '')), valor);
})();
