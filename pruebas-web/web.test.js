/**
 * Pruebas unitarias de la app web (las funciones clave que no dependen de la pantalla), sin navegador:
 * cada archivo se carga como en la página, en un contexto aislado de Node (vm) con window, localStorage
 * y document simulados. No necesitan instalar nada:
 *
 *   node --test pruebas-web/*.test.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

// Contexto como el de la página: los archivos comparten las variables globales, igual que con <script>.
// Como en index.html, primero van el diccionario y el idioma (español salvo que se pida otro)
function cargar(archivos, extras = {}, idioma = 'es') {
    const almacen = new Map([['sdc_idioma', idioma]]);
    const contexto = {
        console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Intl,
        localStorage: {
            getItem: (k) => (almacen.has(k) ? almacen.get(k) : null),
            setItem: (k, v) => almacen.set(k, String(v)),
            removeItem: (k) => almacen.delete(k)
        },
        document: { hidden: false, documentElement: {}, addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, querySelector() { return null; } },
        navigator: {},
        ...extras
    };
    contexto.window = contexto;
    contexto.addEventListener = () => {};
    vm.createContext(contexto);
    for (const archivo of ['textosIngles.js', 'idioma.js', ...archivos]) vm.runInContext(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'), contexto, { filename: archivo });
    contexto.almacen = almacen;
    // Las clases y las const de primer nivel de un <script> son globales pero no cuelgan de window:
    // se leen desde dentro del contexto
    contexto.global = (nombre) => vm.runInContext(nombre, contexto);
    return contexto;
}

// Lo que sale del contexto aislado se compara como datos normales
const plano = (valor) => JSON.parse(JSON.stringify(valor));

// ---------------------------------------------------------------------------------------------------
describe('cotizador: lista de precios y totales', () => {
    const app = cargar(['cotizador.js', 'crm.js']);
    const { leerImporte } = app;
    const cotizador = new (app.global('Cotizador'))();

    test('importes como en RD ("1,250.50") y como en Venezuela ("1.250,50", "45,50")', () => {
        const casos = {
            '45': 45, '45.50': 45.5, '1,250.50': 1250.5, '12,500,000': 12500000, '1,500': 1500,
            '45,50': 45.5, '45,5': 45.5, '1.250,50': 1250.5, '1.500.000': 1500000,
            '1.500': 1.5 // ambiguo: se mantiene como antes (decimal)
        };
        for (const [texto, esperado] of Object.entries(casos)) assert.equal(leerImporte(texto), esperado, texto);
        assert.ok(Number.isNaN(leerImporte('1,5,0')));
        assert.ok(Number.isNaN(leerImporte('gratis')));
    });

    test('leerPrecios: producto, moneda, precio y unidad de cada línea de la ficha', () => {
        const precios = plano(cotizador.leerPrecios([
            'Lista de precios 2026',
            '- Semilla de tomate saladette F1: $45 / sobre',
            '• Pimiento Fitó: US$45,50/sobre',
            '* Cebolla Gautier: RD$1,250.00',
            'Asesoría técnica: incluida',
            '- Muestra: $0 / sobre'
        ].join('\n')));
        assert.deepEqual(precios, [
            { nombre: 'Semilla de tomate saladette F1', moneda: '$', precio: 45, unidad: 'sobre' },
            { nombre: 'Pimiento Fitó', moneda: 'US$', precio: 45.5, unidad: 'sobre' },
            { nombre: 'Cebolla Gautier', moneda: 'RD$', precio: 1250, unidad: 'unidad' }
        ]);
        assert.deepEqual(plano(cotizador.leerPrecios('')), []);
        assert.deepEqual(plano(cotizador.leerPrecios(null)), []);
    });

    test('calcular: subtotales y un total por moneda (RD$ y US$ no se suman entre sí)', () => {
        cotizador.precios = cotizador.leerPrecios('- Tomate: US$45,50 / sobre\n- Cebolla: RD$1,250.00 / sobre\n- Melón: US$10 / sobre');
        cotizador.lineas = [{ producto: 'Tomate', cantidad: 10 }, { producto: 'Cebolla', cantidad: 2 }, { producto: 'Melón', cantidad: 3 }];
        const { filas, totales } = cotizador.calcular();
        assert.deepEqual(plano(filas.map(f => f.subtotal)), [455, 2500, 30]);
        assert.deepEqual(plano(totales), ['US$485.00', 'RD$2,500.00']);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('CRM: enlaces de WhatsApp y fechas', () => {
    const app = cargar(['crm.js']);

    test('WhatsApp de clientes dominicanos', () => {
        assert.equal(app.enlaceWhatsApp('809-555-1234'), 'https://wa.me/18095551234');
        assert.equal(app.enlaceWhatsApp('+1 829 555 1234'), 'https://wa.me/18295551234');
    });

    test('WhatsApp de clientes venezolanos (antes salía wa.me/04141234567, un enlace roto)', () => {
        assert.equal(app.enlaceWhatsApp('0414-123-4567'), 'https://wa.me/584141234567');
        assert.equal(app.enlaceWhatsApp('0212 555 1234'), 'https://wa.me/582125551234');
        assert.equal(app.enlaceWhatsApp('+58 424 1234567'), 'https://wa.me/584241234567');
        assert.equal(app.enlaceWhatsApp('0058 416 1234567'), 'https://wa.me/584161234567');
    });

    test('sin número válido, sin enlace', () => {
        assert.equal(app.enlaceWhatsApp(''), '');
        assert.equal(app.enlaceWhatsApp('sin teléfono'), '');
        assert.equal(app.enlaceWhatsApp('0123456'), '');
    });

    test('soloDigitos y hoyISO (fecha local, no la de UTC)', () => {
        assert.equal(app.global('soloDigitos')('(809) 555-1234 ext.'), '8095551234');
        const ahora = new Date();
        const local = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
        assert.equal(app.hoyISO(), local);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('base de datos de la app: copia local y sincronización', () => {
    let app;
    beforeEach(() => { app = cargar(['googleSync.js', 'datos.js']); });

    // Conector simulado: guarda lo que se le envía y responde lo que diga responder(cambios)
    function base(responder) {
        const enviados = [];
        const db = new (app.global('BaseDatos'))({ activo: true, sincronizarDatos: async (cambios) => { enviados.push(plano(cambios)); return responder(cambios, enviados.length); } });
        db.programar = () => {}; // Sin temporizadores en las pruebas: cada vuelta se lanza a mano
        return { db, enviados };
    }
    const vacio = () => ({ clientes: [], visitas: [], agronomia: [], rendimiento: [], germinador: [], sitios: [], mensajes: [], tareas: [] });

    test('guardar y eliminar: pendiente hasta subir; borrar algo que nunca subió no pide borrarlo en el servidor', () => {
        const { db } = base(() => null);
        db.guardar('clientes', { id: 'c1', nombre: 'Finca' });
        assert.equal(db.obtener('clientes', 'c1')._pendiente, true);
        assert.equal(db.pendientes(), 1);
        db.eliminar('clientes', 'c1');
        assert.equal(db.pendientes(), 0);
        assert.deepEqual(plano(db.borrados), []);
        // La copia local sobrevive a recargar la página
        db.guardar('tareas', { id: 't1', titulo: 'Regar' });
        const recargada = new (app.global('BaseDatos'))(null);
        assert.equal(recargada.obtener('tareas', 't1').titulo, 'Regar');
    });

    test('sincronizar: sube sin las marcas internas y se queda con lo del servidor', async () => {
        const { db, enviados } = base(() => ({ ok: true, datos: { ...vacio(), clientes: [{ id: 'c1', nombre: 'Finca' }, { id: 'c2', nombre: 'Otra' }] } }));
        db.guardar('clientes', { id: 'c1', nombre: 'Finca' });
        await db.sincronizar();
        assert.deepEqual(enviados[0].guardar, [{ modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca' } }]);
        assert.deepEqual(plano(db.datos.clientes.map(c => [c.id, Boolean(c._remoto), Boolean(c._pendiente)])), [['c1', true, false], ['c2', true, false]]);
        assert.equal(db.pendientes(), 0);
        assert.equal(db.error, null);
    });

    test('sincronizar: los números vuelven a ser números (también con coma decimal)', async () => {
        const { db } = base(() => ({ ok: true, datos: { ...vacio(), germinador: [{ id: 'g1', germinacion: '84,5', bandejas: '12', temperatura: '' }] } }));
        await db.sincronizar();
        const lote = db.obtener('germinador', 'g1');
        assert.equal(lote.germinacion, 84.5);
        assert.equal(lote.bandejas, 12);
        assert.equal(lote.temperatura, '');
    });

    test('sincronizar: un cambio hecho mientras viajaba la petición no se pierde', async () => {
        let db;
        ({ db } = base(() => {
            db.guardar('clientes', { id: 'c1', nombre: 'Finca (editada)' });
            return { ok: true, datos: { ...vacio(), clientes: [{ id: 'c1', nombre: 'Finca' }] } };
        }));
        db.guardar('clientes', { id: 'c1', nombre: 'Finca' });
        await db.sincronizar();
        assert.equal(db.obtener('clientes', 'c1').nombre, 'Finca (editada)');
        assert.equal(db.pendientes(), 1);
    });

    test('sincronizar: lo que se edita mientras sube por primera vez y se borra antes de la siguiente vuelta se borra también en el servidor', async () => {
        let db;
        ({ db } = base((cambios, vuelta) => {
            if (vuelta === 1) db.guardar('clientes', { id: 'c1', nombre: 'Finca (editada)' }); // Se edita mientras sube
            return { ok: true, datos: { ...vacio(), clientes: vuelta === 1 ? [{ id: 'c1', nombre: 'Finca' }] : [] } };
        }));
        db.guardar('clientes', { id: 'c1', nombre: 'Finca' });
        await db.sincronizar();
        db.eliminar('clientes', 'c1');
        assert.deepEqual(plano(db.borrados), [{ modulo: 'clientes', id: 'c1' }], 'el servidor ya lo tiene: hay que pedir que lo borre');
        assert.equal(db.pendientes(), 1);
    });

    test('sincronizar: sin conexión, todo sigue pendiente', async () => {
        const { db } = base(() => null);
        db.guardar('visitas', { id: 'v1' });
        await db.sincronizar();
        assert.equal(db.pendientes(), 1);
        assert.equal(db.error, 'Sin conexión con la hoja');
    });

    test('sincronizar: cambios rechazados por permisos se descartan (no se reintentan para siempre)', async () => {
        const { db } = base(() => ({ ok: false, codigo: 'permiso', error: 'No tienes permiso' }));
        db.guardar('clientes', { id: 'c-ajeno', pais: 'VE' });
        await db.sincronizar();
        assert.equal(db.pendientes(), 0);
        assert.equal(db.obtener('clientes', 'c-ajeno'), null);
    });

    test('muchos cambios pendientes (días sin señal) salen en tandas de 200, no se rechazan siempre', async () => {
        const servidor = new Map();
        const { db, enviados } = base((cambios) => {
            if (cambios.guardar.length > 500) return { ok: false, codigo: 'datos', error: 'Demasiados cambios a la vez (máximo 500)' };
            cambios.guardar.forEach(({ registro }) => servidor.set(registro.id, registro));
            return { ok: true, datos: { ...vacio(), visitas: [...servidor.values()] } };
        });
        for (let i = 0; i < 650; i++) db.guardar('visitas', { id: `v${i}`, comentarios: 'Visita de campo' });
        for (let vuelta = 0; vuelta < 10 && db.pendientes(); vuelta++) await db.sincronizar();
        assert.deepEqual(enviados.map(e => e.guardar.length), [200, 200, 200, 50]);
        assert.equal(servidor.size, 650);
        assert.equal(db.pendientes(), 0);
        assert.equal(db.datos.visitas.length, 650);
    });

    test('las tandas también respetan el tamaño (registros grandes)', async () => {
        const { db, enviados } = base((cambios) => ({ ok: true, datos: { ...vacio(), sitios: cambios.guardar.map(g => g.registro) } }));
        const texto = 'x'.repeat(90 * 1024);
        for (let i = 0; i < 100; i++) db.guardar('sitios', { id: `s${i}`, texto });
        await db.sincronizar();
        const bytes = JSON.stringify(enviados[0].guardar).length;
        assert.ok(enviados[0].guardar.length < 100, 'no van los 100 de golpe');
        assert.ok(bytes < 4.2 * 1024 * 1024, `la petición pesa ${bytes} bytes`);
    });

    test('olvidarTodo: al cerrar sesión no queda nada de esa cuenta en el navegador', () => {
        const { db } = base(() => null);
        db.guardar('clientes', { id: 'c1' });
        db.olvidarTodo();
        assert.equal(db.pendientes(), 0);
        assert.equal(app.almacen.get('sdc_clientes'), '[]');
    });
});

// ---------------------------------------------------------------------------------------------------
describe('conector con el backend y con Apps Script', () => {
    function conFetch(responder) {
        const llamadas = [];
        const app = cargar(['googleSync.js'], {
            fetch: async (url, opciones) => { llamadas.push({ url, opciones }); return { json: async () => responder(url, opciones) }; }
        });
        return { app, llamadas };
    }

    test('backend: va con la sesión (Bearer) y el JSON de la acción; sin sesión no envía nada', async () => {
        const { app, llamadas } = conFetch(() => ({ ok: true, eco: 1 }));
        const conector = new (app.global('GoogleWorkspaceConnector'))({ api: 'https://api.semillasdata.com/' });
        assert.equal(conector.api, 'https://api.semillasdata.com');
        assert.ok(conector.activo && conector.conBackend);
        assert.equal(await conector.enviar('sincronizar', {}, true), null, 'sin sesión');
        assert.equal(llamadas.length, 0);

        app.responsable = { sesionBackend: () => 'sesion-123', rechazado() {} };
        const r = await conector.enviar('telefono', { telefono: '04141234567' }, true);
        assert.deepEqual(plano(r), { ok: true, eco: 1 });
        assert.equal(llamadas[0].url, 'https://api.semillasdata.com/api/accion');
        assert.equal(llamadas[0].opciones.headers.Authorization, 'Bearer sesion-123');
        assert.deepEqual(JSON.parse(llamadas[0].opciones.body), { accion: 'telefono', telefono: '04141234567', idioma: 'es' }, 'con el idioma de la app');
    });

    test('backend: si la sesión caducó, avisa al responsable para pedir entrar de nuevo', async () => {
        const { app } = conFetch(() => ({ ok: false, codigo: 'sesion', error: 'Tu sesión caducó' }));
        const avisos = [];
        app.responsable = { sesionBackend: () => 'sesion-123', rechazado: (codigo, error) => avisos.push([codigo, error]) };
        await new (app.global('GoogleWorkspaceConnector'))({ api: 'https://api.x.com' }).enviar('sincronizar', {}, true);
        assert.deepEqual(avisos, [['sesion', 'Tu sesión caducó']]);
    });

    test('backend caído (respuesta que no es JSON o sin red): null, sin romper la app', async () => {
        const app = cargar(['googleSync.js'], { fetch: async () => { throw new TypeError('Failed to fetch'); } });
        app.responsable = { sesionBackend: () => 'sesion-123' };
        const errores = console.error;
        console.error = () => {};
        try {
            assert.equal(await new (app.global('GoogleWorkspaceConnector'))({ api: 'https://api.x.com' }).enviar('sincronizar', {}, true), null);
        } finally {
            console.error = errores;
        }
    });

    test('Apps Script: texto plano con la clave; sin esperar respuesta usa no-cors', async () => {
        const { app, llamadas } = conFetch(() => ({ ok: true }));
        const conector = new (app.global('GoogleWorkspaceConnector'))({ url: 'https://script.google.com/macros/s/X/exec', token: 'clave' });
        assert.ok(conector.activo && !conector.conBackend);
        await conector.enviar('chat', { mensaje: 'hola' });
        assert.equal(llamadas[0].opciones.mode, 'no-cors');
        assert.equal(llamadas[0].opciones.headers['Content-Type'], 'text/plain;charset=utf-8');
        assert.deepEqual(JSON.parse(llamadas[0].opciones.body), { accion: 'chat', token: 'clave', idToken: '', mensaje: 'hola' });
        // Sin backend, correo y reportes no existen: responden null sin llamar a nada
        assert.equal(await conector.enviarCorreo({}), null);
        assert.equal(llamadas.length, 1);
    });

    test('sin ninguna dirección configurada no se envía nada fuera del navegador', async () => {
        const { app, llamadas } = conFetch(() => ({}));
        const conector = new (app.global('GoogleWorkspaceConnector'))({});
        assert.equal(conector.activo, false);
        assert.equal(await conector.enviar('sincronizar', {}, true), null);
        assert.equal(llamadas.length, 0);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('panel de indicadores: los números de cada persona, con datos reales', () => {
    const app = cargar(['crm.js', 'panel.js']);
    const panel = app.panelIndicadores;
    const hoy = new Date(2026, 10, 2, 10, 0); // 2 de noviembre de 2026
    const datos = {
        clientes: [
            { id: 'c1', nombre: 'Finca López', casa: 'Gautier Semences', asignado: 'Luis@semillasdata.com', seguimiento: '2026-10-30' },
            { id: 'c2', nombre: 'Agro Constanza', casa: 'Hexagon Seeds', asignado: 'luis@semillasdata.com', seguimiento: '2026-11-02' },
            { id: 'c3', nombre: 'Hortalizas del Cibao', casa: 'Fitó', seguimiento: '2026-11-07' },
            { id: 'c4', nombre: 'Invernaderos Mérida', casa: 'Genome Seeds', seguimiento: '2026-11-22' }
        ],
        envios: [
            { id: 'e1', clienteId: 'c1', casa: 'Gautier Semences', estado: 'Entregado', semillasMiles: 120 },
            { id: 'e2', clienteId: 'c2', estado: 'Retenido en aduana', semillasMiles: '80', eta: '2026-11-04' },
            { id: 'e3', clienteId: 'c3', casa: 'Fitó', estado: 'En tránsito', semillasMiles: 45.5, eta: '2026-11-03' },
            { id: 'e4', clienteId: 'c4', casa: 'Genome Seeds', estado: 'En reparto' }
        ],
        germinador: [
            { id: 'g1', lote: 'L-031', estado: 'En cámara', germinacion: 93 },
            { id: 'g2', lote: 'L-032', estado: 'En cámara', germinacion: 78 },
            { id: 'g3', lote: 'L-033', estado: 'Listo para trasplante', germinacion: '96' },
            { id: 'g4', lote: 'L-034', estado: 'Despachado', germinacion: 40 },
            { id: 'g5', lote: 'L-035', estado: 'En cámara', germinacion: '' }
        ]
    };
    const como = (ambito, correo) => {
        app.responsable = { ambito, sesion: correo ? { email: correo } : null };
    };

    test('administración (o sin backend): todo lo visible, sumas reales y lo que está bajo el mínimo', () => {
        como(null);
        const r = panel.calcular(datos, hoy);
        assert.deepEqual(plano([r.clientes.mios, r.clientes.vencidos, r.clientes.proximos]), [4, 1, 2]); // c4 queda a más de 7 días
        assert.equal(r.envios.miles, 245.5);
        // La casa de un envío sin casa sale de su cliente; los envíos sin cantidad no cuentan en el gráfico
        assert.deepEqual(plano(r.envios.porCasa.map(x => [x.casa, x.miles])), [['Gautier Semences', 120], ['Hexagon Seeds', 80], ['Fitó', 45.5]]);
        assert.deepEqual(plano(r.envios.enCamino.map(e => e.id)), ['e3', 'e2', 'e4']); // por llegada; sin fecha, al final
        assert.equal(r.envios.problemas, 1);
        // Germinación: solo lotes en cámara o listos y con el dato; de menor a mayor
        assert.deepEqual(plano(r.germinador.medidos.map(m => m.valor)), [78, 93, 96]);
        assert.equal(Math.round(r.germinador.promedio * 10) / 10, 89);
        assert.equal(r.germinador.bajos, 1);
    });

    test('vendedor: sus clientes, sus seguimientos y los envíos de sus clientes; sin módulos de otros cargos', () => {
        como({ estado: 'aprobado', cargo: 'vendedor', paises: ['RD'], casas: ['Gautier Semences'], modulos: ['clientes', 'visitas'], lectura: ['envios'] }, 'luis@semillasdata.com');
        const r = panel.calcular(datos, hoy);
        assert.equal(r.vendedor, true);
        assert.deepEqual(plano([r.clientes.mios, r.clientes.visibles]), [2, 4]);
        assert.deepEqual(plano(r.clientes.seguimientos.map(s => [s.cliente.id, s.dias])), [['c1', -3], ['c2', 0]]);
        assert.deepEqual(plano(r.envios.porCasa.map(x => x.casa)), ['Gautier Semences', 'Hexagon Seeds']);
        assert.equal(r.envios.total, 2);
        assert.equal(panel.puedeVer('envios'), true);
        assert.equal(panel.puedeVer('germinador'), false);
    });

    test('sin datos no inventa nada: ceros y sin promedio', () => {
        como(null);
        const r = panel.calcular({}, hoy);
        assert.deepEqual(plano([r.clientes.mios, r.envios.miles, r.envios.enCamino.length, r.germinador.promedio]), [0, 0, 0, null]);
    });
});

// ---------------------------------------------------------------------------------------------------
describe('archivos de la app', () => {
    test('style.css tiene las llaves equilibradas (una sin cerrar deja sin estilos todo lo que va después)', () => {
        const css = fs.readFileSync(path.join(RAIZ, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        let nivel = 0;
        for (const c of css) {
            if (c === '{') nivel++;
            if (c === '}') nivel--;
            assert.ok(nivel >= 0, 'hay una llave de cierre de más');
        }
        assert.equal(nivel, 0, 'hay una regla sin cerrar');
    });

    test('cada script de index.html se publica en la web, se guarda sin conexión y va en las apps', () => {
        const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
        const scripts = [...html.matchAll(/<script src="([a-zA-Z]+\.js)"/g)].map(m => m[1]);
        const publicar = fs.readFileSync(path.join(RAIZ, 'publicar.sh'), 'utf8');
        const sw = fs.readFileSync(path.join(RAIZ, 'sw.js'), 'utf8');
        const apps = fs.readFileSync(path.join(RAIZ, 'herramientas', 'preparar-web.mjs'), 'utf8');
        for (const s of scripts) {
            assert.ok(publicar.includes(` ${s}`), `${s} falta en publicar.sh`);
            assert.ok(sw.includes(`'./${s}'`), `${s} falta en sw.js`);
            assert.ok(apps.includes(`'${s}'`), `${s} falta en herramientas/preparar-web.mjs`);
        }
    });
});

describe('idioma: la app en inglés', () => {
    // En inglés, idioma.js vigila la página; aquí basta con su función de traducir
    const enIngles = () => cargar([], { MutationObserver: class { observe() {} }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: {}, alert() {}, confirm() {}, prompt() {} }, 'en');

    test('en español no cambia nada y las fechas van en es-DO', () => {
        const app = cargar([]);
        assert.equal(app.traducir('Guardar cambios'), 'Guardar cambios');
        assert.equal(app.LOCALE, 'es-DO');
        assert.equal(app.document.documentElement.lang, 'es');
    });

    test('textos exactos, con datos y por trozos', () => {
        const app = enIngles();
        assert.equal(app.LOCALE, 'en-US');
        assert.equal(app.traducir('Guardar cambios'), 'Save changes');
        assert.equal(app.traducir('  Cerrar sesión '), '  Sign out ', 'respeta los espacios de los trozos de innerHTML');
        assert.equal(app.traducir('Sincronizado hace 5 s'), 'Synced 5 s ago');
        assert.equal(app.traducir('Guía 123456: En tránsito · Miami.'), 'Tracking 123456: In transit · Miami.');
        assert.equal(app.traducir('Alerta · Falla de riego · Cuarto de riego'), 'Alert · Irrigation failure · Irrigation room');
        assert.equal(app.traducir('⚠️ 1 seguimiento vencido'), '⚠️ 1 overdue follow-up');
        assert.equal(app.traducir('Escribe un número entre 1 y 100.'), 'Enter a number between 1 and 100.', 'las concretas van antes que «Escribe …»');
        assert.equal(app.traducir('Tienes 2 avisos nuevos (campana).'), 'You have 2 new notifications (bell).');
    });

    test('lo que escribe el equipo no se traduce, aunque se parezca a un ejemplo', () => {
        const app = enIngles();
        assert.equal(app.traducir('Finca López'), 'Finca López');
        assert.equal(app.traducir('Luis: hola, ¿cómo vas?'), 'Luis: hola, ¿cómo vas?');
        assert.equal(app.traducir('Plan de siembra de diciembre'), 'Plan de siembra de diciembre', 'los ejemplos solo se traducen como placeholder');
        assert.equal(app.traducir('Seguimiento · Finca López'), 'Follow-up · Finca López');
    });

    test('el diccionario no traduce dos veces ni tiene patrones que no compilan', () => {
        const app = enIngles();
        const exactos = app.TEXTOS_EN;
        for (const [es, en] of Object.entries(exactos)) {
            assert.ok(exactos[en] === undefined || exactos[en] === en, `«${es}» → «${en}», que a su vez se traduciría`);
        }
        for (const [expresion] of app.PATRONES_EN) assert.doesNotThrow(() => new RegExp(`^${expresion}$`, 'u'), expresion);
    });
});
