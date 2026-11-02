// Pruebas sin base de datos: cifrado, correo y teléfonos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cifrar, descifrar } from '../src/cifrado.js';
import { construirCorreo } from '../src/correo.js';
import { normalizarTelefono, tarjetaChat } from '../src/avisos.js';
import { esPasajero, conReintentos, conVariacion } from '../src/reintentos.js';

const CLAVE = crypto.randomBytes(32).toString('hex');

test('cifrado: ida y vuelta, IV distinto cada vez y detecta manipulaciones', () => {
    const a = cifrar('1//token-de-refresco', CLAVE);
    const b = cifrar('1//token-de-refresco', CLAVE);
    assert.notEqual(a, b);
    assert.equal(descifrar(a, CLAVE), '1//token-de-refresco');
    assert.equal(Buffer.from(a.split(':')[1], 'base64url').length, 12);
    const partes = a.split(':');
    partes[2] = Buffer.from('otra cosa').toString('base64url');
    assert.throws(() => descifrar(partes.join(':'), CLAVE));
    assert.throws(() => descifrar(a, crypto.randomBytes(32).toString('hex')));
    assert.throws(() => cifrar('x', 'corta'));
});

const leer = (crudo) => Buffer.from(crudo, 'base64url').toString('utf8');

test('correo: cabeceras seguras, asunto UTF-8 y adjunto PDF', () => {
    const simple = leer(construirCorreo({ para: 'ana@semillasdata.com, luis@semillasdata.com', asunto: 'Cotización ñame', texto: 'Hola' }));
    assert.match(simple, /^To: ana@semillasdata.com, luis@semillasdata.com\r\n/);
    assert.match(simple, /Subject: =\?UTF-8\?B\?/);
    assert.ok(simple.includes(Buffer.from('Hola').toString('base64')));

    assert.throws(() => construirCorreo({ para: 'ana@x.com', asunto: 'Hola\r\nBcc: espia@x.com', texto: '' }), /saltos de línea/);
    assert.throws(() => construirCorreo({ para: 'ana@x.com\r\nBcc: espia@x.com', asunto: 'Hola' }), /no válido/);
    assert.throws(() => construirCorreo({ para: '', asunto: 'Hola' }), /destinatario/);
    assert.throws(() => construirCorreo({ para: 'ana@x.com', asunto: 'Hola', adjunto: { tipo: 'text/html', base64: 'eA==' } }), /PDF/);

    const pdf = Buffer.from('%PDF-1.4 prueba').toString('base64');
    const conAdjunto = leer(construirCorreo({ para: 'ana@x.com', asunto: 'PDF', texto: 'Adjunto', adjunto: { nombre: 'cotización.pdf', tipo: 'application/pdf', base64: pdf } }));
    assert.match(conAdjunto, /multipart\/mixed; boundary="semences-[0-9a-f]+"/);
    assert.match(conAdjunto, /Content-Disposition: attachment/);
    assert.ok(conAdjunto.includes(pdf));
});

test('teléfonos: República Dominicana e internacionales', () => {
    assert.equal(normalizarTelefono('809-555-1234'), '18095551234');
    assert.equal(normalizarTelefono('(829) 555 1234'), '18295551234');
    assert.equal(normalizarTelefono('+34 612 345 678'), '34612345678');
    assert.equal(normalizarTelefono('555-1234'), '');
    assert.equal(normalizarTelefono(''), '');
});

test('reintentos: la espera varía entre el 100 % y el 125 %', () => {
    const esperas = Array.from({ length: 200 }, () => conVariacion(1000));
    assert.ok(esperas.every(e => e >= 1000 && e <= 1250));
    assert.ok(new Set(esperas).size > 50);
});

test('reintentos: repite lo pasajero y no lo demás', async () => {
    assert.ok(esPasajero({ code: 429 }));
    assert.ok(esPasajero({ status: 503 }));
    assert.ok(!esPasajero({ code: 400 }));
    let n = 0;
    assert.equal(await conReintentos(async () => { if (++n < 3) throw Object.assign(new Error('x'), { status: 500 }); return 'listo'; }, { esperaMs: 1 }), 'listo');
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(conReintentos(async () => { n++; throw Object.assign(new Error('x'), { status: 400 }); }, { esperaMs: 1 }));
    assert.equal(n, 1);
});

test('reportes: la carpeta del cliente se busca por su id y se crea solo si falta', async () => {
    const { carpetaDelCliente } = await import('../src/google.js');
    const pedido = [];
    const unidad = (existentes) => ({ files: {
        list: async (p) => { pedido.push(['list', p]); return { data: { files: existentes } }; },
        create: async (p) => { pedido.push(['create', p]); return { data: { id: 'carpeta-nueva' } }; }
    } });
    assert.equal(await carpetaDelCliente(unidad([{ id: 'carpeta-vieja' }]), 'raiz1', { id: 'cli-17', nombre: 'Finca Ñapa' }), 'carpeta-vieja');
    assert.match(pedido[0][1].q, /'raiz1' in parents and appProperties has \{ key = 'semencesCliente' and value = 'cli-17' \}/);
    assert.equal(pedido.length, 1);
    assert.equal(await carpetaDelCliente(unidad([]), 'raiz1', { id: 'cli-18', nombre: 'Otra' }), 'carpeta-nueva');
    assert.deepEqual(pedido.at(-1)[1].requestBody, { name: 'Otra', mimeType: 'application/vnd.google-apps.folder', parents: ['raiz1'], appProperties: { semencesCliente: 'cli-18' } });
});

test('cifrado atado a la cuenta: el token de una persona no sirve en la fila de otra', () => {
    const t = cifrar('1//refresco', CLAVE, 'google:ana@x.com');
    assert.equal(descifrar(t, CLAVE, 'google:ana@x.com'), '1//refresco');
    assert.throws(() => descifrar(t, CLAVE, 'google:luis@x.com'));
    assert.throws(() => descifrar(t, CLAVE));
});

test('resumen: horas locales, secciones según el cargo y textos para cada canal', async () => {
    const { enZona, inicioDelDia, componerResumen, textosResumen } = await import('../src/resumen.js');
    assert.deepEqual(enZona(new Date('2026-11-03T11:05:00Z'), 'America/Santo_Domingo'), { fecha: '2026-11-03', hora: 7, minuto: 5 });
    assert.deepEqual(enZona(new Date('2026-11-03T03:30:00Z'), 'America/Santo_Domingo'), { fecha: '2026-11-02', hora: 23, minuto: 30 });
    assert.equal(inicioDelDia('2026-11-03', 'America/Santo_Domingo').toISOString(), '2026-11-03T04:00:00.000Z');
    assert.equal(inicioDelDia('2026-07-01', 'Europe/Madrid').toISOString(), '2026-06-30T22:00:00.000Z'); // Con horario de verano

    const datos = {
        clientes: [
            { id: 'a', nombre: 'Finca Hoy', seguimiento: '2026-11-03' },
            { id: 'b', nombre: 'Finca Atrasada', seguimiento: '2026-10-30' },
            { id: 'c', nombre: 'Finca Futura', seguimiento: '2026-11-10' },
            { id: 'd', nombre: 'Finca de Otro', seguimiento: '2026-11-03', asignado: 'otro@x.com' }
        ],
        tareas: [
            { titulo: 'Llevar muestras', para: 'Luis Vendedor', vence: '2026-11-03', prioridad: 'Alta' },
            { titulo: 'Vieja', para: 'luis@x.com', vence: '2026-11-01' },
            { titulo: 'Hecha', para: 'Luis Vendedor', vence: '2026-11-03', hecha: '2026-11-02' },
            { titulo: 'De otro', para: 'Ana', vence: '2026-11-03' }
        ],
        agronomia: [{ proceso: 'Trasplante', cliente: 'Finca Hoy', lote: 'L1', fechaInicio: '2026-11-03' }]
    };
    const persona = { nombre: 'Luis Vendedor', email: 'luis@x.com' };
    const vendedor = { modulos: ['clientes', 'visitas', 'tareas', 'mensajes', 'sitios'] };
    const eventos = [{ inicio: '2026-11-03T13:30:00Z', titulo: 'Visita a Constanza', meet: '' }, { inicio: '2026-11-03', todoElDia: true, titulo: 'Feria' }];
    const s = componerResumen({ persona, ambito: vendedor, datos, eventos, sinLeer: 2, hoy: '2026-11-03', zona: 'America/Santo_Domingo' });
    assert.deepEqual(s.map(x => x.titulo), ['📅 Tu agenda de hoy', '🤝 Seguimientos de clientes', '📋 Tus tareas', '💬 Tablero del equipo']);
    assert.match(s[0].lineas[0], /^9:30.*Visita a Constanza$/);
    assert.equal(s[0].lineas[1], 'Todo el día · Feria');
    assert.deepEqual(s[1].lineas, ['Finca Atrasada (atrasado desde el 30/10)', 'Finca Hoy (hoy)']);
    assert.deepEqual(s[2].lineas, ['Vieja (vencida desde el 1/11)', 'Llevar muestras (vence hoy, prioridad alta)']);
    // El técnico ve procesos y no seguimientos de clientes
    const tecnico = componerResumen({ persona, ambito: { modulos: ['agronomia', 'rendimiento', 'visitas', 'tareas'] }, datos, hoy: '2026-11-03', zona: 'America/Santo_Domingo' });
    assert.deepEqual(tecnico.map(x => x.titulo), ['📋 Tus tareas', '🌱 Procesos agronómicos de hoy']);
    assert.equal(tecnico[1].lineas[0], 'Trasplante · Finca Hoy · L1 (empieza hoy)');
    assert.deepEqual(componerResumen({ persona, ambito: vendedor, datos: {}, hoy: '2026-11-03', zona: 'America/Santo_Domingo' }), []);

    const ambitoLuis = { cargo: 'vendedor', paises: ['RD'], casas: ['Gautier Semences', 'Fitó'], modulos: vendedor.modulos };
    const textos = textosResumen(s, persona, '2026-11-03', ambitoLuis);
    assert.ok(!textos.whatsapp.includes('\n') && textos.whatsapp.length <= 1000);
    assert.match(textos.whatsapp, /^☀️ Buenos días, Luis\. Soy Borja, tu resumen de hoy \(Vendedor · 🇩🇴 RD · Gautier Semences, Fitó\)/);
    // Las 7 variables de la plantilla de varias líneas: cada una en una sola línea; lo vacío, "Sin pendientes"
    assert.equal(textos.parametros.length, 7);
    assert.deepEqual(textos.parametros.slice(0, 2), ['Luis', 'Vendedor · 🇩🇴 RD · Gautier Semences, Fitó']);
    assert.equal(textos.parametros[3], 'Finca Atrasada (atrasado desde el 30/10); Finca Hoy (hoy)');
    assert.equal(textos.parametros[5], 'Sin pendientes');
    assert.ok(textos.parametros.every(p => !p.includes('\n')));
    assert.match(textos.correo.texto, /Tu alcance: Vendedor · 🇩🇴 RD · Gautier Semences, Fitó\./);
    assert.match(textos.correo.texto, /• Finca Hoy \(hoy\)/);
    assert.equal(textos.correo.asunto, '☀️ Tu resumen de hoy (3/11) · Semences del Caribe');

    // Administrativo: además, las cifras del equipo en su ámbito
    const admin = componerResumen({ persona: { nombre: 'Ana', email: 'ana@x.com' }, ambito: { cargo: 'administrativo', modulos: ['clientes', 'agronomia', 'tareas'] }, datos, hoy: '2026-11-03', zona: 'America/Santo_Domingo' });
    assert.deepEqual(admin.at(-1), { clave: 'equipo', titulo: '📊 Consolidado del equipo', lineas: ['1 seguimiento de clientes atrasado', '1 tarea vencida en el equipo', '1 proceso agronómico hoy', '3 clientes sin asignar'] });
    const { textoAlcance } = await import('../src/resumen.js');
    assert.equal(textoAlcance({ cargo: 'master', paises: ['RD', 'VE'], casas: ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó'] }), 'Master · RD y Venezuela · todas las casas');
});

test('Google Chat: tarjeta con botón de Meet y el texto de la persona escapado', () => {
    const t = tarjetaChat('📹 Ana abrió una videollamada\n<b>Hola</b> & bienvenidos\nhttps://meet.google.com/abc-defg-hij', 'https://semillasdata.com');
    const card = t.cardsV2[0].card;
    assert.equal(card.header.title, '📹 Ana abrió una videollamada');
    assert.equal(card.sections[0].widgets[0].textParagraph.text, '&lt;b&gt;Hola&lt;/b&gt; &amp; bienvenidos');
    assert.deepEqual(card.sections[0].widgets[1].buttonList.buttons.map(b => [b.text, b.onClick.openLink.url]),
        [['🎥 Unirse a Meet', 'https://meet.google.com/abc-defg-hij'], ['Abrir la app', 'https://semillasdata.com']]);
    // Un título suelto, sin app configurada: tarjeta sin secciones
    assert.deepEqual(tarjetaChat('Solo título', '').cardsV2[0].card.sections, []);
    // Un enlace que no es de Meet no se convierte en botón
    assert.equal(tarjetaChat('Aviso\nhttps://meet.google.com.malvado.com/x', '').cardsV2[0].card.sections[0].widgets.length, 1);
});
