// Pruebas sin base de datos: cifrado, correo y teléfonos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cifrar, descifrar } from '../src/cifrado.js';
import { construirCorreo } from '../src/correo.js';
import { normalizarTelefono, tarjetaChat } from '../src/avisos.js';
import { esPasajero, conReintentos, conVariacion } from '../src/reintentos.js';
import { semanaDe, diasDeSemana, semanas, semanaValida } from '../src/reportes.js';
import { crearIA, ErrorIA } from '../src/ia.js';
import { traducir } from '../src/idioma.js';
import { diferencias, nombreDeRegistro } from '../src/auditoria.js';

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
    const vendedor = { modulos: ['clientes', 'visitas', 'pedidos', 'tareas', 'mensajes', 'sitios', 'reuniones'] };
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
    // Germinador (plantulador): trasplante de hoy o atrasado y germinación baja, sin lo despachado
    const germ = componerResumen({ persona, ambito: { cargo: 'plantulador', modulos: ['germinador', 'tareas'] }, hoy: '2026-11-03', zona: 'America/Santo_Domingo', umbral: 85, datos: { germinador: [
        { lote: 'L-1', variedad: 'Tomate', cliente: 'Finca Hoy', trasplante: '2026-11-03', germinacion: 95, estado: 'Listo para trasplante' },
        { lote: 'L-2', variedad: 'Pimiento', trasplante: '2026-11-01', germinacion: 70, estado: 'En cámara' },
        { lote: 'L-3', variedad: 'Melón', trasplante: '2026-11-01', germinacion: 50, estado: 'Despachado' }
    ] } });
    assert.deepEqual(germ, [{ clave: 'germinador', titulo: '🧫 Germinador', lineas: [
        'Lote L-2 · Pimiento: trasplante atrasado desde el 1/11', 'Lote L-1 · Tomate · Finca Hoy: trasplante hoy', 'Lote L-2 · Pimiento: germinación baja (70 %)'] }]);
    // Envíos: al vendedor, solo los de sus clientes asignados que llegan hoy o tienen un problema
    const env = componerResumen({ persona, ambito: { cargo: 'vendedor', modulos: ['clientes'], lectura: ['envios'] }, hoy: '2026-11-03', zona: 'America/Santo_Domingo', datos: {
        clientes: [{ id: 'm', nombre: 'Mío', asignado: 'luis@x.com' }, { id: 'o', nombre: 'Otro', asignado: 'otro@x.com' }],
        envios: [
            { transportista: 'DHL', guia: 'A1', clienteId: 'm', cliente: 'Mío', estado: 'En tránsito', eta: '2026-11-03' },
            { transportista: 'DHL', guia: 'A2', clienteId: 'o', cliente: 'Otro', estado: 'Retenido en aduana' },
            { transportista: 'FedEx', guia: 'A3', clienteId: 'm', cliente: 'Mío', estado: 'Entregado', eta: '2026-11-02' },
            { transportista: 'FedEx', guia: 'A4', clienteId: 'm', cliente: 'Mío', estado: 'En tránsito', eta: '2026-11-09' }
        ] } });
    assert.deepEqual(env.find(x => x.clave === 'envios').lineas, ['DHL A1 · Mío: En tránsito (llegada hoy)']);
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

test('envíos: DHL y FedEx oficiales se traducen a los estados de la app (y el token de FedEx se reutiliza)', async () => {
    const { crearTransportistas } = await import('../src/envios.js');
    const llamadas = [];
    const respuestas = {
        'api-eu.dhl.com': { shipments: [{ status: { statusCode: 'transit', description: 'Shipment is on hold at customs', location: { address: { addressLocality: 'SANTO DOMINGO' } } }, estimatedTimeOfDelivery: '2026-11-06T18:00:00Z' }] },
        'apis.fedex.com/oauth/token': { access_token: 'tok-fedex', expires_in: 3600 },
        'apis.fedex.com/track/v1/trackingnumbers': { output: { completeTrackResults: [{ trackResults: [{ latestStatusDetail: { code: 'OD', description: 'On FedEx vehicle for delivery', scanLocation: { city: 'CARACAS' } }, dateAndTimes: [{ type: 'ESTIMATED_DELIVERY', dateTime: '2026-11-04T20:00:00-04:00' }] }] }] } }
    };
    const fetchFalso = async (url, opciones) => {
        llamadas.push({ url, opciones });
        const clave = Object.keys(respuestas).find(k => url.includes(k));
        return new Response(JSON.stringify(respuestas[clave]), { status: 200 });
    };
    const t = crearTransportistas({ envios: { dhlClave: 'clave-dhl', fedexId: 'id', fedexSecreto: 'secreto', fedexUrl: 'https://apis.fedex.com' } }, fetchFalso);
    assert.deepEqual(await t.consultar('DHL', 'JD0144'), { estado: 'Retenido en aduana', detalle: 'Shipment is on hold at customs', ubicacion: 'SANTO DOMINGO', eta: '2026-11-06' });
    assert.equal(llamadas[0].opciones.headers['DHL-API-Key'], 'clave-dhl');
    assert.deepEqual(await t.consultar('FedEx', '794612345678'), { estado: 'En reparto', detalle: 'On FedEx vehicle for delivery', ubicacion: 'CARACAS', eta: '2026-11-04' });
    await t.consultar('FedEx', '794612345678');
    assert.equal(llamadas.filter(l => l.url.includes('oauth')).length, 1); // Un solo token para las dos consultas
    assert.equal(llamadas.at(-1).opciones.headers.Authorization, 'Bearer tok-fedex');
    await assert.rejects(t.consultar('DHL', 'x&y=1'), /guía no válido/);
    const sinClaves = crearTransportistas({ envios: { dhlClave: '', fedexId: '', fedexSecreto: '', fedexUrl: 'https://apis.fedex.com' } }, fetchFalso);
    assert.equal(sinClaves.activo('DHL'), false);
    assert.equal(await sinClaves.consultar('DHL', 'JD0144'), null);
});

test('reporte semanal: semanas ISO (de lunes a domingo) en la zona del equipo', () => {
    assert.equal(semanaDe('2026-11-02'), '2026-W45'); // lunes
    assert.equal(semanaDe('2026-11-08'), '2026-W45'); // domingo: la misma semana
    assert.equal(semanaDe('2026-01-01'), '2026-W01'); // jueves 1 de enero
    assert.equal(semanaDe('2027-01-01'), '2026-W53'); // viernes 1 de enero: todavía la última de 2026
    assert.equal(semanaDe('2025-12-29'), '2026-W01'); // lunes de diciembre que ya es la semana 1
    assert.deepEqual(diasDeSemana('2026-W45'), { lunes: '2026-11-02', domingo: '2026-11-08' });
    assert.deepEqual(diasDeSemana('2026-W01'), { lunes: '2025-12-29', domingo: '2026-01-04' });
    assert.equal(semanaValida('2026-W45'), true);
    assert.equal(semanaValida('2026-W54'), false);
    assert.equal(semanaValida("2026-W45' OR 1"), false);
    // Domingo 8 a las 23:30 en Santo Domingo ya es lunes 9 en UTC: sigue contando la semana 45
    const s = semanas({ zonaHoraria: 'America/Santo_Domingo' }, new Date('2026-11-09T03:30:00Z'));
    assert.deepEqual([s.actual, s.anterior], ['2026-W45', '2026-W44']);
    // El viernes de la semana pasada (30 de octubre) a las 00:00 locales
    assert.equal(s.viernesAnterior.toISOString(), '2026-10-30T04:00:00.000Z');
});

test('IA: sin clave está apagada; rechazos, respuestas cortadas y JSON roto se tratan como error', async () => {
    const config = { ia: { clave: '', modelo: 'claude-opus-5-5' } };
    assert.equal(crearIA(config).activo, false);
    const responder = (respuesta) => crearIA(config, { beta: { messages: { create: async () => respuesta } } });
    const reporte = { persona: { nombre: 'Luis', cargo: 'vendedor' }, reporte: { semana: '2026-W44', resumen: '', actividades: [] }, anterior: null };
    await assert.rejects(responder({ stop_reason: 'refusal', content: [] }).revisarReporte(reporte), ErrorIA);
    await assert.rejects(responder({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"resu' }] }).revisarReporte(reporte), /cortada/);
    await assert.rejects(responder({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no es json' }] }).revisarReporte(reporte), /formato/);
    const bien = await responder({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"resumen":"ok"}' }] }).revisarReporte(reporte);
    assert.deepEqual(bien, { datos: { resumen: 'ok' }, modelo: 'claude-opus-5-5' });
});

test('idioma: los avisos del servidor en inglés, línea a línea; lo escrito por alguien se queda igual', () => {
    assert.equal(traducir('✅ Acceso aprobado\nHola Ana, ya puedes usar la app de Semences del Caribe. Ábrela de nuevo para entrar.', 'es'),
        '✅ Acceso aprobado\nHola Ana, ya puedes usar la app de Semences del Caribe. Ábrela de nuevo para entrar.');
    assert.equal(traducir('✅ Acceso aprobado\nHola Ana, ya puedes usar la app de Semences del Caribe. Ábrela de nuevo para entrar.', 'en'),
        '✅ Access approved\nHi Ana, you can now use the Semences del Caribe app. Open it again to sign in.');
    assert.equal(traducir('📦 Envío DHL 123 · Finca López\nEn tránsito · Miami · llegada estimada 5/11', 'en'),
        '📦 Shipment DHL 123 · Finca López\nIn transit · Miami · estimated arrival 5/11');
    assert.equal(traducir('🚨 ALERTA · Falla de riego · Cuarto de riego\nSe rompió la bomba\n— Luis', 'en'),
        '🚨 ALERT · Irrigation failure · Irrigation room\nSe rompió la bomba\n— Luis');
    assert.equal(traducir('💬 Luis\nhola, ¿cómo vas?', 'en'), '💬 Luis\nhola, ¿cómo vas?');
    assert.equal(traducir('☀️ Buenos días, Ana. Soy Borja, tu resumen de hoy\n📋 Tus tareas: 1 · Revisar riego (vence hoy, prioridad alta)', 'en'),
        '☀️ Good morning, Ana. I’m Borja, here’s your summary for today\n📋 Your tasks: 1 · Revisar riego (due today, high priority)');
});

test('auditoría: diferencias campo a campo sin ruido y nombre legible de cada registro', () => {
    assert.deepEqual(diferencias({ nombre: 'A', telefono: '1', cuenta: 'x', notas: '' }, { nombre: 'A', telefono: '2', cuenta: 'y' }), { telefono: ['1', '2'] },
        'la cuenta la pone el servidor y vacío = sin campo');
    assert.deepEqual(diferencias(null, { id: 'c1', nombre: 'Finca' }), { nombre: [null, 'Finca'] });
    assert.equal(diferencias({ notas: 'x'.repeat(900) }, {}).notas[0].length, 501, 'los textos largos se recortan');
    assert.equal(nombreDeRegistro({ id: 'e1', transportista: 'DHL', guia: 'JD1' }), 'DHL JD1');
    assert.equal(nombreDeRegistro({ id: 'l1', lote: 'L-7' }), 'Lote L-7');
    assert.equal(nombreDeRegistro({ id: 'x9' }), 'x9');
});

test('arranque en cPanel: inicio.cjs se puede cargar con require() (LiteSpeed y Passenger lo hacen así)', () => {
    const carpeta = fileURLToPath(new URL('..', import.meta.url));
    // Sin configuración: tiene que llegar a app.js y decir qué falta, no fallar al cargarse (ERR_REQUIRE_ASYNC_MODULE)
    const r = spawnSync(process.execPath, ['-e', "require('./inicio.cjs')"], { cwd: carpeta, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
    assert.doesNotMatch(r.stderr, /ERR_REQUIRE_ASYNC_MODULE|ERR_REQUIRE_ESM/);
    assert.match(r.stderr, /Falta configurar/);
});

test('cotizaciones: líneas libres, total del servidor y solo administración aprueba', async () => {
    const { ajustarCotizacion, puedeEscribir } = await import('../src/permisos.js');
    const vendedor = { cargo: 'vendedor', master: false, paises: ['RD'], casas: ['Fitó'], modulos: ['cotizaciones'] };
    const admin = { cargo: 'administrativo', master: false, paises: ['RD'], casas: ['Fitó'], modulos: ['cotizaciones'] };
    const luis = { nombre: 'Luis', email: 'luis@x.com' }, ana = { nombre: 'Ana', email: 'ana@x.com' };
    const base = { id: 'co-1', pais: 'RD', casa: 'Fitó', cliente: 'Finca', moneda: 'XX', total: 1,
        lineas: [{ producto: ' Tomate\nsaladette ', cantidad: '10', unidad: 'sobre', precio: 45.555 }, { producto: '', cantidad: 3, precio: 1 }, { producto: 'Melón', cantidad: 0, precio: 9 }] };

    // El vendedor no puede aprobarla él mismo: queda pendiente, con el total calculado aquí
    const enviada = ajustarCotizacion(vendedor, luis, { ...base, estado: 'Aprobada', revisadoPor: 'Yo' }, null);
    assert.deepEqual([enviada.estado, enviada.total, enviada.moneda, enviada.revisadoPor], ['Pendiente', 455.6, 'US$', undefined]);
    assert.deepEqual(enviada.lineas, [{ producto: 'Tomate saladette', cantidad: 10, unidad: 'sobre', precio: 45.56 }]);

    // Administración la aprueba: el servidor firma quién y cuándo
    const aprobada = ajustarCotizacion(admin, ana, { ...enviada, estado: 'Aprobada', revisadoPor: 'Otro' }, enviada);
    assert.equal(aprobada.estado, 'Aprobada');
    assert.equal(aprobada.revisadoPor, 'Ana');
    assert.ok(aprobada.revisadoEn);

    // Si el vendedor la reenvía tal cual, sigue aprobada; si cambia un precio, vuelve a aprobación
    assert.equal(ajustarCotizacion(vendedor, luis, { ...aprobada, estado: 'Pendiente' }, aprobada).estado, 'Aprobada');
    const cambiada = ajustarCotizacion(vendedor, luis, { ...aprobada, lineas: [{ ...aprobada.lineas[0], precio: 40 }] }, aprobada);
    assert.deepEqual([cambiada.estado, cambiada.revisadoPor, cambiada.total], ['Pendiente', undefined, 400]);

    // Rechazo con motivo; el motivo no queda en otra cosa que no sea rechazada
    const rechazada = ajustarCotizacion(admin, ana, { ...cambiada, estado: 'Rechazada', motivo: 'Precio bajo' }, cambiada);
    assert.deepEqual([rechazada.estado, rechazada.motivo], ['Rechazada', 'Precio bajo']);
    assert.equal(ajustarCotizacion(admin, ana, { ...rechazada, estado: 'Aprobada' }, rechazada).motivo, undefined);

    // Una aprobada solo la borra administración
    assert.equal(puedeEscribir(vendedor, 'cotizaciones', aprobada, 'eliminar'), false);
    assert.equal(puedeEscribir(admin, 'cotizaciones', aprobada, 'eliminar'), true);
    assert.equal(puedeEscribir(vendedor, 'cotizaciones', cambiada, 'eliminar'), true);
});
