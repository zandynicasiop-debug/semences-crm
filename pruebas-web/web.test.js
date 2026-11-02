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

// Contexto como el de la página: los archivos comparten las variables globales, igual que con <script>
function cargar(archivos, extras = {}) {
    const almacen = new Map();
    const contexto = {
        console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Intl,
        localStorage: {
            getItem: (k) => (almacen.has(k) ? almacen.get(k) : null),
            setItem: (k, v) => almacen.set(k, String(v)),
            removeItem: (k) => almacen.delete(k)
        },
        document: { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return {}; }, querySelector() { return null; } },
        navigator: {},
        ...extras
    };
    contexto.window = contexto;
    contexto.addEventListener = () => {};
    vm.createContext(contexto);
    for (const archivo of archivos) vm.runInContext(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'), contexto, { filename: archivo });
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
        assert.deepEqual(JSON.parse(llamadas[0].opciones.body), { accion: 'telefono', telefono: '04141234567' });
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
