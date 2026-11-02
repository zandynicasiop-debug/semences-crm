/**
 * Pruebas del backend completo contra una base real (MySQL y MariaDB), con Google y Meta simulados.
 * Bases: PRUEBA_BASES="host:puerto,host:puerto" (por defecto, las de Docker en 33061 y 33062).
 * Usuario y base de prueba: semences / prueba / semences_prueba.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { leerConfig } from '../src/config.js';
import { conectar } from '../src/db.js';
import { crearAvisos } from '../src/avisos.js';
import { crearApp } from '../src/aplicacion.js';
import { repasar, INTENTOS } from '../src/cola.js';
import { enviarResumenes } from '../src/resumen.js';

const BASES = (process.env.PRUEBA_BASES || '127.0.0.1:33061,127.0.0.1:33062').split(',');

// Google simulado: recuerda lo que se le pidió y con qué token
function googleFalso() {
    const g = {
        llamadas: [],
        identidades: {},   // código → identidad que "devuelve Google"
        fallo: null,
        canjearCodigo: async (codigo) => {
            if (!g.identidades[codigo]) throw new Error('invalid code');
            return g.identidades[codigo];
        },
        urlAutorizacion: (estado, opciones = {}) => { g.ultimaAutorizacion = opciones; return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(estado)}`; },
        enviarCorreo: async (token, alRenovar, crudo) => {
            if (g.fallo) throw g.fallo;
            g.llamadas.push({ tipo: 'correo', token, crudo });
            return 'correo-1';
        },
        crearEvento: async (token, alRenovar, evento, conMeet) => {
            if (g.fallo) throw g.fallo;
            g.llamadas.push({ tipo: 'evento', token, evento, conMeet });
            alRenovar('token-renovado');
            return { id: 'evento-1', enlace: 'https://calendar.google.com/evento-1', meet: conMeet ? 'https://meet.google.com/abc-defg-hij' : '' };
        },
        eventos: async (token) => {
            g.llamadas.push({ tipo: 'eventos', token });
            return token === 'refresco-jefa' ? [{ inicio: '2026-11-03T14:00:00Z', titulo: 'Comité de la mañana', meet: 'https://meet.google.com/aaa-bbbb-ccc' }] : [];
        },
        ocupado: async (token, alRenovar, inicio, fin) => {
            g.llamadas.push({ tipo: 'ocupado', inicio, fin });
            return [{ inicio: '2026-11-03T14:00:00Z', fin: '2026-11-03T15:00:00Z' }];
        },
        exportarHoja: async (token, alRenovar, datos) => {
            g.llamadas.push({ tipo: 'exportar', datos });
            return { id: datos.hojaId || 'hoja-1', enlace: `https://docs.google.com/spreadsheets/d/${datos.hojaId || 'hoja-1'}/edit` };
        },
        crearReporte: async (token, alRenovar, datos) => {
            g.llamadas.push({ tipo: 'reporte', token, datos });
            return { id: 'pdf-1', enlace: 'https://drive.google.com/file/d/pdf-1/view' };
        }
    };
    return g;
}

for (const base of BASES) {
    const [host, puerto] = base.split(':');
    describe(`backend con la base ${base}`, () => {
        let pool, servidor, url, google, peticionesMeta, config, avisos, respuestaMeta, pushEnviados, respuestaPush;
        const sesiones = {};

        const llamar = async (ruta, { metodo = 'POST', cuerpo, sesion, origen } = {}) => {
            const cabeceras = { 'Content-Type': 'application/json' };
            if (sesion) cabeceras.Authorization = `Bearer ${sesion}`;
            if (origen) cabeceras.Origin = origen;
            const r = await fetch(url + ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined, redirect: 'manual' });
            const texto = await r.text();
            let json = null;
            try { json = JSON.parse(texto); } catch (e) { /* redirección */ }
            return { estado: r.status, json, cabeceras: r.headers };
        };
        const accion = (sesion, datos) => llamar('/api/accion', { sesion, cuerpo: datos });

        // Entrada completa como en la web: inicio → Google → vuelta a la página → canje con el secreto
        const entrarComo = async (codigoGoogle, vuelta = 'https://semillasdata.com/') => {
            const verificador = crypto.randomBytes(32).toString('base64url');
            const reto = crypto.createHash('sha256').update(verificador).digest('base64url');
            const inicio = await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=${encodeURIComponent(vuelta)}`, { metodo: 'GET' });
            const estado = new URL(inicio.cabeceras.get('location')).searchParams.get('state');
            const vueltaGoogle = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=${codigoGoogle}`, { metodo: 'GET' });
            const destino = new URL(vueltaGoogle.cabeceras.get('location'));
            const fragmento = new URLSearchParams(destino.hash.slice(1));
            if (fragmento.get('google-error')) return { estado: 403, error: fragmento.get('google-error'), destino };
            return { ...(await llamar('/api/auth/canjear', { cuerpo: { codigo: fragmento.get('google-codigo'), verificador } })), destino };
        };

        before(async () => {
            config = leerConfig({
                URL_PUBLICA: 'http://localhost:0',
                MYSQL_HOST: host, MYSQL_PUERTO: puerto, MYSQL_USUARIO: 'semences', MYSQL_CLAVE: 'prueba', MYSQL_BASE: 'semences_prueba',
                GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secreto',
                DOMINIO: 'semillasdata.com', ADMINS: 'jefa@gmail.com',
                // Las pruebas de siempre, con el acceso cerrado; las cuentas personales (opción B) se prueban al final
                CUENTAS_PERSONALES: 'no',
                CLAVE_CIFRADO: crypto.randomBytes(32).toString('hex'),
                ORIGENES: 'https://semillasdata.com', ENTRADAS_POR_MINUTO: '1000',
                CHAT_WEBHOOK: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k',
                WHATSAPP_TOKEN: 'meta-token', WHATSAPP_TELEFONO_ID: '123', WHATSAPP_PLANTILLA: 'aviso_equipo', WHATSAPP_PLANTILLA_CLIENTES: 'aviso_cliente',
                VAPID_PUBLICA: 'BPublica', VAPID_PRIVADA: 'privada'
            });
            // MariaDB tarda unos segundos en aceptar conexiones la primera vez
            for (let i = 0; ; i++) {
                try { pool = await conectar(config.mysql); break; } catch (e) { if (i > 60) throw e; await new Promise(r => setTimeout(r, 1000)); }
            }
            // Base limpia: se borran las tablas y conectar() las vuelve a crear
            for (const tabla of ['sesiones', 'codigos', 'registros', 'metricas', 'equipo', 'cola_avisos', 'push_suscripciones', 'directos', 'usuarios']) await pool.query(`DROP TABLE IF EXISTS ${tabla}`);
            await pool.end();
            pool = await conectar(config.mysql);

            google = googleFalso();
            google.identidades = {
                'codigo-ana': { email: 'Ana@semillasdata.com', verificado: true, dominio: 'semillasdata.com', nombre: 'Ana', foto: '', tokenRefresco: 'refresco-ana', permisos: 'openid email' },
                'codigo-jefa': { email: 'jefa@gmail.com', verificado: true, dominio: '', nombre: 'Jefa', foto: '', tokenRefresco: 'refresco-jefa', permisos: 'openid' },
                'codigo-intrusa': { email: 'intrusa@gmail.com', verificado: true, dominio: '', nombre: 'X', foto: '', tokenRefresco: 'r', permisos: '' },
                'codigo-sinverificar': { email: 'luis@semillasdata.com', verificado: false, dominio: 'semillasdata.com', nombre: 'Luis', foto: '', tokenRefresco: '', permisos: '' },
                'codigo-externa': { email: 'externa@gmail.com', verificado: true, dominio: '', nombre: 'Externa', foto: '', tokenRefresco: 'refresco-externa', permisos: '' }
            };
            peticionesMeta = [];
            respuestaMeta = () => 200;
            const fetchFalso = async (destino, opciones) => {
                peticionesMeta.push({ destino, cuerpo: JSON.parse(opciones.body), cabeceras: opciones.headers });
                const estado = destino.startsWith('https://graph.facebook.com') ? respuestaMeta(JSON.parse(opciones.body)) : 200;
                return new Response(estado === 200 ? '{}' : '{"error":{"message":"rechazado"}}', { status: estado });
            };
            pushEnviados = [];
            respuestaPush = () => null;
            const pushFalso = async (suscripcion, cuerpo, opciones) => {
                const fallo = respuestaPush(suscripcion);
                if (fallo) throw Object.assign(new Error(`Received unexpected response code`), { statusCode: fallo });
                pushEnviados.push({ endpoint: suscripcion.endpoint, contenido: JSON.parse(cuerpo), opciones });
            };
            avisos = crearAvisos(config, fetchFalso, pushFalso);
            const app = crearApp({ config, pool, google, avisos, registrar: { error: () => {} } });
            await new Promise(r => { servidor = app.listen(0, r); });
            url = `http://127.0.0.1:${servidor.address().port}`;
        });

        after(async () => {
            await new Promise(r => servidor.close(r));
            await pool.end();
        });

        test('salud', async () => {
            const r = await llamar('/api/salud', { metodo: 'GET' });
            assert.equal(r.estado, 200);
            assert.equal(r.json.base, 'ok');
            assert.deepEqual(r.json.integraciones, { chat: true, whatsapp: true, whatsappClientes: true, push: true, reportes: false });
            assert.deepEqual(r.json.colaAvisos, {});
            assert.equal(r.json.clavePush, 'BPublica');
        });

        test('entrar: dominio y admins sí; ajenos y sin verificar no', async () => {
            const ana = await entrarComo('codigo-ana');
            assert.equal(ana.estado, 200);
            assert.equal(ana.destino.origin + ana.destino.pathname, 'https://semillasdata.com/');
            assert.equal(ana.json.usuario.email, 'ana@semillasdata.com');
            assert.equal(ana.json.usuario.admin, false);
            assert.equal(ana.json.usuario.googleConectado, true);
            assert.equal(ana.json.usuario.estado, 'pendiente'); // Todo el que no es Master empieza en la sala de espera
            sesiones.ana = ana.json.sesion;

            const jefa = await entrarComo('codigo-jefa');
            assert.equal(jefa.json.usuario.admin, true);
            assert.equal(jefa.json.usuario.estado, 'aprobado');
            assert.equal(jefa.json.usuario.cargo, 'master');
            sesiones.jefa = jefa.json.sesion;

            // La jefa (Master) aprueba a Ana con todo, para el resto de pruebas
            const aprobada = await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'ana@semillasdata.com', cargo: 'administrativo', paises: ['RD', 'VE'], casas: ['Gautier Semences', 'Hexagon Seeds', 'Genome Seeds', 'Fitó'] });
            assert.equal(aprobada.estado, 200);

            assert.match((await entrarComo('codigo-intrusa')).error, /no está autorizada/);
            assert.match((await entrarComo('codigo-sinverificar')).error, /verificado/);
            assert.match((await entrarComo('inventado')).error, /Google no aceptó/);
        });

        test('la vuelta solo puede ir a páginas de la app', async () => {
            const reto = 'a'.repeat(43);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=${encodeURIComponent('https://malvado.com/')}`, { metodo: 'GET' })).estado, 400);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&vuelta=no-es-url`, { metodo: 'GET' })).estado, 400);
            assert.equal((await llamar('/api/auth/google/inicio?reto=corto', { metodo: 'GET' })).estado, 400);
        });

        test('en la base no hay tokens ni sesiones en claro', async () => {
            const [usuarios] = await pool.query('SELECT token_google FROM usuarios');
            for (const u of usuarios) assert.ok(u.token_google.startsWith('v1:') && !u.token_google.includes('refresco'));
            const [filas] = await pool.query('SELECT huella FROM sesiones');
            assert.ok(filas.every(f => f.huella !== sesiones.ana && /^[0-9a-f]{64}$/.test(f.huella)));
        });

        test('sin sesión, o con una inventada, no se puede hacer nada', async () => {
            assert.equal((await accion(undefined, { accion: 'sincronizar' })).estado, 401);
            assert.equal((await accion('x'.repeat(43), { accion: 'sincronizar' })).estado, 401);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.ana })).json.usuario.email, 'ana@semillasdata.com');
        });

        test('sincronizar: guarda, firma con la cuenta real, elimina y devuelve todo', async () => {
            const r = await accion(sesiones.ana, {
                accion: 'sincronizar',
                guardar: [
                    { modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca Ñame', cuenta: 'falsa@x.com', semillas: 25 } },
                    { modulo: 'tareas', registro: { id: 't1', titulo: 'Visitar Constanza' } }
                ]
            });
            assert.equal(r.estado, 200);
            assert.equal(r.json.datos.clientes[0].nombre, 'Finca Ñame');
            assert.equal(r.json.datos.clientes[0].cuenta, 'ana@semillasdata.com');
            assert.equal(r.json.datos.clientes[0].semillas, 25);
            assert.deepEqual(Object.keys(r.json.datos).sort(), ['agronomia', 'clientes', 'germinador', 'mensajes', 'rendimiento', 'sitios', 'tareas', 'visitas']);

            const otra = await accion(sesiones.jefa, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'c1', nombre: 'Finca Ñame (editada)' } }], eliminar: [{ modulo: 'tareas', id: 't1' }] });
            assert.equal(otra.json.datos.clientes.length, 1);
            assert.equal(otra.json.datos.clientes[0].nombre, 'Finca Ñame (editada)');
            assert.equal(otra.json.datos.tareas.length, 0);
        });

        test('sincronizar: si un cambio es inválido no se aplica ninguno', async () => {
            const r = await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'c2', nombre: 'Nueva' } }, { modulo: 'hackeo', registro: { id: 'x' } }] });
            assert.equal(r.estado, 400);
            const todo = await accion(sesiones.ana, { accion: 'sincronizar' });
            assert.equal(todo.json.datos.clientes.find(c => c.id === 'c2'), undefined);
            assert.equal((await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { nombre: 'sin id' } }] })).estado, 400);
        });

        test('acciones desconocidas o con nombres trampa', async () => {
            for (const nombre of ['borrarTodo', '__proto__', 'constructor', 'toString']) {
                const r = await accion(sesiones.ana, { accion: nombre });
                assert.equal(r.estado, 400, nombre);
            }
        });

        test('Meet y Calendar con la cuenta de la persona; el token renovado se guarda cifrado', async () => {
            const meet = await accion(sesiones.ana, { accion: 'meet', titulo: 'Emergencia' });
            assert.equal(meet.json.meetUrl, 'https://meet.google.com/abc-defg-hij');
            const llamada = google.llamadas.find(l => l.tipo === 'evento' && l.conMeet);
            assert.equal(llamada.token, 'refresco-ana');
            assert.ok(llamada.evento.conferenceData.createRequest.requestId);
            await new Promise(r => setTimeout(r, 50));
            const [[fila]] = await pool.query("SELECT token_google FROM usuarios WHERE email = 'ana@semillasdata.com'");
            assert.ok(!fila.token_google.includes('renovado'));

            const cal = await accion(sesiones.ana, { accion: 'calendar', titulo: 'Visita', inicio: '2026-11-03T09:00:00-04:00', fin: '2026-11-03T09:30:00-04:00' });
            assert.equal(cal.json.ok, true);
            assert.equal(google.llamadas.at(-1).token, 'token-renovado');
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', inicio: '2026-11-03T10:00:00Z', fin: '2026-11-03T09:00:00Z' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', inicio: 'mañana' })).estado, 400);
        });

        test('reunión con el cliente: invitación de Calendar, Meet y aviso por WhatsApp', async () => {
            await pool.query('DELETE FROM cola_avisos');
            const r = await accion(sesiones.ana, {
                accion: 'calendar', titulo: 'Reunión · Finca Ñapa', inicio: '2026-11-03T14:00:00Z', fin: '2026-11-03T14:30:00Z',
                invitados: ['cliente@finca.do'], conMeet: true, whatsapp: '809 555 7777'
            });
            assert.equal(r.json.meetUrl, 'https://meet.google.com/abc-defg-hij');
            assert.equal(r.json.avisoWhatsapp, true);
            const evento = google.llamadas.at(-1);
            assert.equal(evento.conMeet, true);
            assert.deepEqual(evento.evento.attendees, [{ email: 'cliente@finca.do' }]);
            assert.ok(evento.evento.conferenceData.createRequest.requestId);
            const [[cola]] = await pool.query("SELECT destino, plantilla, texto FROM cola_avisos WHERE canal = 'whatsapp'");
            assert.equal(cola.destino, '18095557777');
            assert.equal(cola.plantilla, 'aviso_cliente');
            assert.match(cola.texto, /invitación a "Reunión · Finca Ñapa" el martes, 3 de noviembre.*10:00.*Google Meet/);
            // Sale con la plantilla de clientes, no con la del equipo
            peticionesMeta.length = 0;
            await repasar(pool, avisos);
            assert.equal(peticionesMeta.find(p => p.destino.startsWith('https://graph.facebook.com')).cuerpo.template.name, 'aviso_cliente');

            // Sin invitados no hay aviso al cliente; un invitado inválido se rechaza
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', titulo: 'Solo yo', whatsapp: '8095557777' })).json.avisoWhatsapp, false);
            assert.equal((await accion(sesiones.ana, { accion: 'calendar', invitados: ['no es correo'] })).estado, 400);
        });

        test('disponibilidad: tramos ocupados del calendario', async () => {
            const r = await accion(sesiones.ana, { accion: 'disponibilidad', inicio: '2026-11-03T13:00:00Z', fin: '2026-11-03T16:00:00Z' });
            assert.deepEqual(r.json.ocupado, [{ inicio: '2026-11-03T14:00:00Z', fin: '2026-11-03T15:00:00Z' }]);
            assert.equal((await accion(sesiones.ana, { accion: 'disponibilidad', inicio: '2026-11-03T16:00:00Z', fin: '2026-11-03T13:00:00Z' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'disponibilidad', inicio: '2026-01-01T00:00:00Z', fin: '2026-12-31T00:00:00Z' })).estado, 400);
        });

        test('exportar a Google Sheets: una pestaña por módulo y la misma hoja cada vez', async () => {
            await accion(sesiones.ana, { accion: 'sincronizar', guardar: [
                { modulo: 'clientes', registro: { id: 'c9', nombre: '=HYPERLINK("http://malo")', correo: 'c@finca.do', _pendiente: true, clienteId: 'x', nuevoCampo: 'sí' } },
                { modulo: 'visitas', registro: { id: 'v1', fecha: '2026-11-01', cliente: 'Finca Ñame', estado: 'Bueno' } }
            ] });
            const r = await accion(sesiones.ana, { accion: 'exportar' });
            assert.equal(r.json.enlace, 'https://docs.google.com/spreadsheets/d/hoja-1/edit');
            const { pestanas, hojaId } = google.llamadas.at(-1).datos;
            assert.equal(hojaId, '');
            assert.deepEqual(pestanas.map(p => p.nombre), ['Clientes', 'Visitas', 'Procesos agronómicos', 'Rendimiento', 'Germinador', 'Tareas']);
            const [cabecera, ...filas] = pestanas[0].filas;
            assert.deepEqual(cabecera.slice(0, 3), ['Nombre', 'Correo', 'Teléfono']);
            assert.ok(cabecera.includes('nuevoCampo') && cabecera.includes('Registró') && !cabecera.includes('_pendiente') && !cabecera.includes('clienteId'));
            const fila = filas.find(f => f[cabecera.indexOf('Id')] === 'c9');
            assert.equal(fila[0], '=HYPERLINK("http://malo")'); // Se escribe tal cual (RAW): no es una fórmula
            assert.equal(fila[cabecera.indexOf('Cuenta')], 'ana@semillasdata.com');
            assert.equal(r.json.filas.Visitas, 1);
            // La segunda vez reescribe la misma hoja
            await accion(sesiones.ana, { accion: 'exportar' });
            assert.equal(google.llamadas.at(-1).datos.hojaId, 'hoja-1');
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.ana })).json.usuario.hojaExportacion, 'https://docs.google.com/spreadsheets/d/hoja-1/edit');
        });

        test('correo desde el Gmail de la persona', async () => {
            const r = await accion(sesiones.ana, { accion: 'correo', para: 'cliente@finca.do', asunto: 'Cotización', texto: 'Adjunta', adjunto: { nombre: 'cot.pdf', tipo: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') } });
            assert.equal(r.json.ok, true);
            const crudo = Buffer.from(google.llamadas.at(-1).crudo, 'base64url').toString();
            assert.match(crudo, /^To: cliente@finca.do/);
            assert.equal(r.json.avisoWhatsapp, false);
            await pool.query('DELETE FROM cola_avisos');
            const conAviso = await accion(sesiones.ana, { accion: 'correo', para: 'cliente@finca.do', asunto: 'Cotización de Semences', texto: 'Hola', whatsapp: '8295551212' });
            assert.equal(conAviso.json.avisoWhatsapp, true);
            const [[cola]] = await pool.query("SELECT destino, plantilla, texto FROM cola_avisos");
            assert.deepEqual(cola, { destino: '18295551212', plantilla: 'aviso_cliente', texto: 'Le enviamos un correo a cliente@finca.do: "Cotización de Semences". Revise su bandeja de entrada.' });
            await pool.query('DELETE FROM cola_avisos');
            assert.equal((await accion(sesiones.ana, { accion: 'correo', para: 'a@b.com', asunto: 'x\nBcc: c@d.com' })).estado, 400);
        });

        test('Google retiró el permiso: se pide volver a conectar y se borra el token', async () => {
            google.fallo = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
            const r = await accion(sesiones.jefa, { accion: 'meet' });
            google.fallo = null;
            assert.equal(r.estado, 403);
            assert.equal(r.json.codigo, 'google');
            const [[fila]] = await pool.query("SELECT token_google FROM usuarios WHERE email = 'jefa@gmail.com'");
            assert.equal(fila.token_google, null);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.jefa })).json.usuario.googleConectado, false);
        });

        test('reportes: sin plantilla configurada lo dice; con plantilla genera el PDF', async () => {
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', titulo: 'Visita' })).estado, 503);
            const r = await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', titulo: 'Visita a/finca', campos: { cliente: 'Ana', fecha: '3/11' } });
            assert.equal(r.json.enlace, 'https://drive.google.com/file/d/pdf-1/view');
            const datos = google.llamadas.at(-1).datos;
            assert.equal(datos.titulo, 'Visita a finca');
            assert.deepEqual(datos.campos, { cliente: 'Ana', fecha: '3/11' });
            assert.equal(datos.carpetaCliente, null);
            await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', titulo: 'R', cliente: { id: 'cli-17', nombre: 'Finca\nÑapa/Sur' } });
            assert.deepEqual(google.llamadas.at(-1).datos.carpetaCliente, { id: 'cli-17', nombre: 'Finca Ñapa Sur' });
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', cliente: { id: "x' or name contains '" } })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '../../etc', titulo: 'x' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'reporte', plantillaId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', campos: { 'a}}{{b': 1 } })).estado, 400);
        });

        test('equipo: solo admins; añadir permite entrar y quitar cierra sus sesiones', async () => {
            assert.equal((await accion(sesiones.ana, { accion: 'equipo', operacion: 'listar' })).estado, 403);
            const guardado = await accion(sesiones.jefa, { accion: 'equipo', operacion: 'guardar', email: 'Externa@gmail.com', nombre: 'Externa', telefono: '809 555 1234' });
            assert.deepEqual(guardado.json.equipo, [{ email: 'externa@gmail.com', nombre: 'Externa', telefono: '18095551234', notas: '' }]);
            const externa = await entrarComo('codigo-externa');
            assert.equal(externa.estado, 200);
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'externa@gmail.com', cargo: 'vendedor', paises: ['RD'], casas: ['Fitó'] });
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'quitar', email: 'externa@gmail.com' });
            assert.equal((await accion(externa.json.sesion, { accion: 'sincronizar' })).estado, 401);
        });

        test('avisar: Google Chat y WhatsApp a todos los teléfonos', async () => {
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'guardar', email: 'campo@gmail.com', telefono: '8295550000' });
            assert.equal((await accion(sesiones.ana, { accion: 'telefono', telefono: '123' })).estado, 400);
            const tel = await accion(sesiones.ana, { accion: 'telefono', telefono: '(849) 555-1111' });
            assert.equal(tel.json.usuario.telefono, '18495551111');

            peticionesMeta.length = 0;
            const r = await accion(sesiones.ana, { accion: 'avisar', mensaje: '🚨 Plaga en\nparcela 3' });
            assert.equal(r.json.chat, 'enviado');
            assert.deepEqual(r.json.whatsapp, { encolados: 2 });
            assert.deepEqual(r.json.push, { encolados: 0 });
            const chat = peticionesMeta.find(p => p.destino.startsWith('https://chat.googleapis.com'));
            assert.equal(chat.cuerpo.fallbackText, '🚨 Plaga en\nparcela 3');
            const tarjeta = chat.cuerpo.cardsV2[0].card;
            assert.equal(tarjeta.header.title, '🚨 Plaga en');
            assert.equal(tarjeta.sections[0].widgets[0].textParagraph.text, 'parcela 3');
            assert.deepEqual(tarjeta.sections[0].widgets[1].buttonList.buttons.map(b => [b.text, b.onClick.openLink.url]), [['Abrir la app', 'https://semillasdata.com']]);
            // WhatsApp no sale en la petición: sale de la cola
            assert.equal(peticionesMeta.filter(p => p.destino.startsWith('https://graph.facebook.com')).length, 0);

            assert.deepEqual(await repasar(pool, avisos), { enviados: 2, reintentar: 0, fallidos: 0 });
            const whatsapp = peticionesMeta.filter(p => p.destino.startsWith('https://graph.facebook.com'));
            assert.deepEqual(whatsapp.map(p => p.cuerpo.to).sort(), ['18295550000', '18495551111']);
            assert.equal(whatsapp[0].cuerpo.template.components[0].parameters[0].text, '🚨 Plaga en parcela 3');
            assert.equal(whatsapp[0].cabeceras.Authorization, 'Bearer meta-token');
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 0 });
        });

        test('cola de WhatsApp: reintenta lo pasajero, abandona lo definitivo y recupera lo atascado', async () => {
            await pool.query('DELETE FROM cola_avisos');
            // Meta saturado para un número y rechazo definitivo para otro
            respuestaMeta = (cuerpo) => cuerpo.to === '18295550000' ? 503 : 400;
            await accion(sesiones.ana, { accion: 'avisar', mensaje: 'Reintento' });
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 1, fallidos: 1 });
            const [[fallido]] = await pool.query("SELECT destino, error FROM cola_avisos WHERE estado = 'fallido'");
            assert.equal(fallido.destino, '18495551111');
            assert.match(fallido.error, /400/);
            // El pendiente espera su turno: un repaso inmediato no lo toca
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 0 });
            const [[pendiente]] = await pool.query("SELECT intentos, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), proximo) espera FROM cola_avisos WHERE estado = 'pendiente'");
            assert.equal(pendiente.intentos, 1);
            assert.ok(pendiente.espera > 20 && pendiente.espera <= 38, `espera ${pendiente.espera}`); // 30 s + hasta 25 %

            // Llega su hora y Meta ya responde
            respuestaMeta = () => 200;
            await pool.query("UPDATE cola_avisos SET proximo = UTC_TIMESTAMP() WHERE estado = 'pendiente'");
            assert.deepEqual(await repasar(pool, avisos), { enviados: 1, reintentar: 0, fallidos: 0 });

            // Si Meta sigue caído, se abandona al llegar a INTENTOS
            respuestaMeta = () => 500;
            await pool.query(`INSERT INTO cola_avisos (destino, texto, intentos) VALUES ('18095550000', 'x', ${INTENTOS - 1})`);
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 1 });

            // Un mensaje que quedó "enviando" porque el proceso se cayó se vuelve a enviar a los 5 minutos
            respuestaMeta = () => 200;
            await pool.query("INSERT INTO cola_avisos (destino, texto, estado, reclamado) VALUES ('18095550001', 'atascado', 'enviando', UTC_TIMESTAMP() - INTERVAL 6 MINUTE)");
            await pool.query("INSERT INTO cola_avisos (destino, texto, estado, reclamado) VALUES ('18095550002', 'en curso', 'enviando', UTC_TIMESTAMP())");
            assert.deepEqual(await repasar(pool, avisos), { enviados: 1, reintentar: 0, fallidos: 0 });

            const salud = await llamar('/api/salud', { metodo: 'GET' });
            assert.deepEqual(salud.json.colaAvisos, { whatsapp: { enviado: 2, fallido: 2, enviando: 1 } });
            const equipo = await accion(sesiones.jefa, { accion: 'equipo', operacion: 'listar' });
            assert.equal(equipo.json.avisos.ultimosFallidos.length, 2);
            await pool.query('DELETE FROM cola_avisos');
        });

        const suscripcion = (n) => ({
            endpoint: `https://fcm.googleapis.com/fcm/send/dispositivo-${n}`,
            keys: { p256dh: `B${'x'.repeat(86)}${n}`, auth: `auth-${n}-xxxxxxxx` }
        });

        test('push: alta y baja solo de servicios push reales', async () => {
            for (const malo of [
                { ...suscripcion(9), endpoint: 'https://malvado.com/robar' },
                { ...suscripcion(9), endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
                { ...suscripcion(9), endpoint: 'https://fcm.googleapis.com:8443/x' },
                { ...suscripcion(9), endpoint: 'https://fcm.googleapis.com.malvado.com/x' },
                { ...suscripcion(9), keys: { p256dh: 'corta', auth: 'x' } },
                null
            ]) {
                assert.equal((await accion(sesiones.ana, { accion: 'push', operacion: 'alta', suscripcion: malo })).estado, 400, JSON.stringify(malo));
            }
            assert.equal((await accion(sesiones.ana, { accion: 'push', operacion: 'alta', suscripcion: { ...suscripcion(8), endpoint: 'https://web.push.apple.com/QGuq' } })).json.activo, true);
            assert.equal((await accion(sesiones.ana, { accion: 'push', operacion: 'alta', suscripcion: suscripcion(1) })).json.activo, true);
            assert.equal((await accion(sesiones.jefa, { accion: 'push', operacion: 'alta', suscripcion: suscripcion(2) })).json.activo, true);
            assert.equal((await accion(sesiones.ana, { accion: 'push', operacion: 'consultar', endpoint: suscripcion(1).endpoint })).json.activo, true);
            // Nadie puede dar de baja la suscripción de otra persona
            await accion(sesiones.ana, { accion: 'push', operacion: 'baja', endpoint: suscripcion(2).endpoint });
            assert.equal((await accion(sesiones.jefa, { accion: 'push', operacion: 'consultar', endpoint: suscripcion(2).endpoint })).json.activo, true);
            await accion(sesiones.ana, { accion: 'push', operacion: 'baja', endpoint: 'https://web.push.apple.com/QGuq' });
            const [filas] = await pool.query('SELECT endpoint FROM push_suscripciones ORDER BY endpoint');
            assert.deepEqual(filas.map(f => f.endpoint), [suscripcion(1).endpoint, suscripcion(2).endpoint]);
        });

        test('push: el aviso llega a los demás, con título y texto, y lo caducado se borra', async () => {
            // Solo push en esta prueba: sin teléfonos de WhatsApp
            await pool.query("UPDATE usuarios SET telefono = ''");
            await pool.query("UPDATE equipo SET telefono = ''");
            pushEnviados.length = 0;
            const r = await accion(sesiones.jefa, { accion: 'avisar', mensaje: '🚨 ALERTA · Plaga · Parcela 3\nMosca blanca en el invernadero\n— Jefa' });
            assert.deepEqual(r.json.push, { encolados: 1 }); // La de Ana; la jefa no se avisa a sí misma
            await repasar(pool, avisos);
            assert.equal(pushEnviados.length, 1);
            assert.equal(pushEnviados[0].endpoint, suscripcion(1).endpoint);
            assert.deepEqual(pushEnviados[0].contenido, { titulo: '🚨 ALERTA · Plaga · Parcela 3', texto: 'Mosca blanca en el invernadero\n— Jefa' });
            assert.equal(pushEnviados[0].opciones.vapidDetails.publicKey, 'BPublica');
            assert.equal(pushEnviados[0].opciones.urgency, 'high');

            // El servicio push está saturado: se reintenta; si dice 410, la suscripción ya no existe y se borra
            respuestaPush = () => 503;
            await accion(sesiones.jefa, { accion: 'avisar', mensaje: 'Otro aviso' });
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 1, fallidos: 0 });
            respuestaPush = () => 410;
            await pool.query("UPDATE cola_avisos SET proximo = UTC_TIMESTAMP() WHERE estado = 'pendiente'");
            assert.deepEqual(await repasar(pool, avisos), { enviados: 0, reintentar: 0, fallidos: 1 });
            assert.equal((await accion(sesiones.ana, { accion: 'push', operacion: 'consultar', endpoint: suscripcion(1).endpoint })).json.activo, false);
            const [[fila]] = await pool.query("SELECT error FROM cola_avisos WHERE canal = 'push' AND estado = 'fallido'");
            assert.match(fila.error, /caducada \(410\): borrada/);
            respuestaPush = () => null;

            // Quien sale del equipo deja de recibir avisos push
            const externa = await entrarComo('codigo-externa').catch(() => null);
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'guardar', email: 'externa@gmail.com' });
            const dentro = await entrarComo('codigo-externa');
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'externa@gmail.com', cargo: 'vendedor', paises: ['RD'], casas: ['Fitó'] });
            await accion(dentro.json.sesion, { accion: 'push', operacion: 'alta', suscripcion: suscripcion(5) });
            await accion(sesiones.jefa, { accion: 'equipo', operacion: 'quitar', email: 'externa@gmail.com' });
            const [quedan] = await pool.query('SELECT endpoint FROM push_suscripciones WHERE endpoint = ?', [suscripcion(5).endpoint]);
            assert.equal(quedan.length, 0, externa ? '' : '');
        });

        test('la base trabaja en UTC aunque el servidor esté en otra zona', async () => {
            const [[fila]] = await pool.query('SELECT @@session.time_zone zona, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) diferencia');
            assert.equal(fila.zona, '+00:00');
            assert.equal(Number(fila.diferencia), 0);
        });

        test('CORS: solo los orígenes de la app', async () => {
            const bueno = await llamar('/api/salud', { metodo: 'GET', origen: 'https://semillasdata.com' });
            assert.equal(bueno.cabeceras.get('access-control-allow-origin'), 'https://semillasdata.com');
            const malo = await llamar('/api/salud', { metodo: 'GET', origen: 'https://malvado.com' });
            assert.equal(malo.cabeceras.get('access-control-allow-origin'), null);
            const previa = await fetch(`${url}/api/accion`, { method: 'OPTIONS', headers: { Origin: 'https://malvado.com' } });
            assert.equal(previa.status, 403);
        });

        test('cabeceras de seguridad (Helmet) y límite de peticiones estándar', async () => {
            const r = await llamar('/api/salud', { metodo: 'GET' });
            assert.match(r.cabeceras.get('content-security-policy'), /default-src 'none'/);
            assert.match(r.cabeceras.get('strict-transport-security'), /max-age=31536000/);
            assert.equal(r.cabeceras.get('x-content-type-options'), 'nosniff');
            assert.equal(r.cabeceras.get('x-frame-options'), 'SAMEORIGIN');
            assert.equal(r.cabeceras.get('referrer-policy'), 'no-referrer');
            assert.equal(r.cabeceras.get('cache-control'), 'no-store');
            assert.equal(r.cabeceras.get('x-powered-by'), null);
            assert.match(r.cabeceras.get('ratelimit-policy'), /600-in-1min/);
        });

        test('entrada de datos: solo objetos JSON, sin contaminar prototipos ni nombres de acción raros', async () => {
            const crudo = (cuerpo) => fetch(`${url}/api/accion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesiones.ana}` }, body: cuerpo });
            assert.equal((await crudo('[1,2]')).status, 400);
            assert.equal((await crudo('{"accion":"sincronizar","guardar":[{"modulo":"clientes","registro":{"id":"p1","__proto__":{"admin":true}}}]}')).status, 400);
            assert.equal((await crudo('{"accion":"sincronizar","constructor":{"prototype":{"x":1}}}')).status, 400);
            assert.equal((await crudo('{"accion":"sin cro"}')).status, 400);
            assert.equal((await crudo('{"accion":{"$ne":1}}')).status, 400);
            assert.equal((await crudo('{"accion":"toString"}')).status, 400, 'una acción heredada de Object no existe');
            let anidado = '{"accion":"sincronizar","x":'; for (let i = 0; i < 40; i++) anidado += '{"a":'; anidado += '1' + '}'.repeat(41);
            assert.equal((await crudo(anidado)).status, 400);
            assert.equal((await crudo('{no es json')).status, 400);
        });

        test('inyección SQL: los textos con SQL se guardan como texto y la base sigue intacta', async () => {
            const malicioso = "x'); DROP TABLE registros; --";
            const r = await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: malicioso, nombre: "Robert'); DROP TABLE usuarios;--", pais: 'RD', casa: 'Fitó' } }] });
            assert.equal(r.estado, 200);
            const guardado = r.json.datos.clientes.find(c => c.id === malicioso);
            assert.equal(guardado.nombre, "Robert'); DROP TABLE usuarios;--");
            assert.equal((await accion(sesiones.ana, { accion: 'sincronizar', guardar: [{ modulo: "clientes' OR '1'='1", registro: { id: 'z' } }] })).estado, 400);
            const [[tablas]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('registros', 'usuarios')");
            assert.equal(Number(tablas.n), 2);
            await accion(sesiones.ana, { accion: 'sincronizar', eliminar: [{ modulo: 'clientes', id: malicioso }] });
        });

        test('app Android: vuelta a semences:// y código atado al secreto de la app', async () => {
            const verificador = crypto.randomBytes(32).toString('base64url');
            const reto = crypto.createHash('sha256').update(verificador).digest('base64url');
            const inicio = await llamar(`/api/auth/google/inicio?reto=${reto}`, { metodo: 'GET' });
            assert.equal(inicio.estado, 302);
            const urlGoogle = new URL(inicio.cabeceras.get('location'));
            const estado = urlGoogle.searchParams.get('state');

            const vuelta = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=codigo-ana`, { metodo: 'GET' });
            const destino = new URL(vuelta.cabeceras.get('location'));
            assert.equal(destino.protocol, 'semences:');
            const codigo = destino.searchParams.get('codigo');
            assert.ok(codigo);

            // Sin el secreto de la app que empezó, el código no sirve (y queda gastado)
            const vuelta2 = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado)}&code=codigo-ana`, { metodo: 'GET' });
            const codigo2 = new URL(vuelta2.cabeceras.get('location')).searchParams.get('codigo');
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo: codigo2, verificador: 'otro-secreto' } })).estado, 401);
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo: codigo2, verificador } })).estado, 401);

            const canje = await llamar('/api/auth/canjear', { cuerpo: { codigo, verificador } });
            assert.equal(canje.json.usuario.email, 'ana@semillasdata.com');
            assert.equal((await llamar('/api/auth/canjear', { cuerpo: { codigo, verificador } })).estado, 401);

            const falsa = await llamar(`/api/auth/google/vuelta?state=${encodeURIComponent(estado.slice(0, -2) + 'xx')}&code=codigo-ana`, { metodo: 'GET' });
            assert.ok(new URL(falsa.cabeceras.get('location')).searchParams.get('error'));
            const basura = await llamar('/api/auth/google/vuelta?state=no.vale&code=codigo-ana', { metodo: 'GET' });
            assert.ok(new URL(basura.cabeceras.get('location')).searchParams.get('error'));
        });

        test('el límite de entradas por minuto frena los intentos en serie', async () => {
            const app = crearApp({ config: { ...config, entradasPorMinuto: 3 }, pool, google, avisos: crearAvisos(config, async () => new Response('{}')), registrar: { error: () => {} } });
            const otro = await new Promise(r => { const s = app.listen(0, () => r(s)); });
            const base = `http://127.0.0.1:${otro.address().port}`;
            const estados = [];
            for (let i = 0; i < 5; i++) estados.push((await fetch(`${base}/api/auth/canjear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
            await new Promise(r => otro.close(r));
            assert.deepEqual(estados, [401, 401, 401, 429, 429]);
        });

        test('sala de espera: sin aprobar solo se deja el teléfono; al Master le llega el aviso', async () => {
            await pool.query('DELETE FROM cola_avisos');
            await pool.query("UPDATE usuarios SET telefono = '18095550101' WHERE email = 'jefa@gmail.com'");
            google.identidades['codigo-luis'] = { email: 'luis@semillasdata.com', verificado: true, dominio: 'semillasdata.com', nombre: 'Luis', foto: 'https://lh3.googleusercontent.com/luis', tokenRefresco: 'r-luis', permisos: '' };
            const luis = await entrarComo('codigo-luis');
            sesiones.luis = luis.json.sesion;
            assert.equal(luis.json.usuario.estado, 'pendiente');
            assert.deepEqual(luis.json.usuario.modulos, []);
            const bloqueado = await accion(sesiones.luis, { accion: 'sincronizar' });
            assert.equal(bloqueado.estado, 403);
            assert.equal(bloqueado.json.codigo, 'espera');
            assert.equal((await accion(sesiones.luis, { accion: 'sala', telefono: '123' })).estado, 400);
            const sala = await accion(sesiones.luis, { accion: 'sala', telefono: '829 555 0202' });
            assert.equal(sala.json.usuario.solicitado, true);
            await accion(sesiones.luis, { accion: 'sala', telefono: '829 555 0202' }); // La segunda vez no avisa otra vez
            const [avisosMaster] = await pool.query("SELECT destino, texto FROM cola_avisos WHERE canal = 'whatsapp'");
            assert.equal(avisosMaster.length, 1);
            assert.equal(avisosMaster[0].destino, '18095550101');
            assert.match(avisosMaster[0].texto, /Nueva solicitud de acceso\nLuis \(luis@semillasdata.com\)/);
            // Solo un Master gestiona los accesos
            assert.equal((await accion(sesiones.ana, { accion: 'accesos', operacion: 'listar' })).estado, 403);
            const lista = await accion(sesiones.jefa, { accion: 'accesos', operacion: 'listar' });
            assert.equal(lista.json.personas[0].email, 'luis@semillasdata.com'); // Los pendientes primero
            assert.deepEqual(lista.json.opciones.cargos, ['vendedor', 'tecnico', 'plantulador', 'administrativo']);
            // Aprobación incompleta o con valores inventados: no
            for (const malo of [{ cargo: 'master', paises: ['RD'], casas: ['Fitó'] }, { cargo: 'vendedor', paises: [], casas: ['Fitó'] }, { cargo: 'vendedor', paises: ['XX'], casas: ['Fitó'] }, { cargo: 'jefe', paises: ['RD'], casas: ['Fitó'] }]) {
                assert.equal((await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'luis@semillasdata.com', ...malo })).estado, 400, JSON.stringify(malo));
            }
            assert.equal((await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'jefa@gmail.com', cargo: 'vendedor', paises: ['RD'], casas: ['Fitó'] })).estado, 400);
            await pool.query('DELETE FROM cola_avisos');
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'luis@semillasdata.com', cargo: 'vendedor', paises: ['RD'], casas: ['Gautier Semences'] });
            const [[aviso]] = await pool.query("SELECT destino, texto FROM cola_avisos WHERE canal = 'whatsapp'");
            assert.equal(aviso.destino, '18295550202');
            assert.match(aviso.texto, /Acceso aprobado/);
            const yo = (await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.luis })).json.usuario;
            assert.deepEqual([yo.estado, yo.cargo, yo.paises, yo.casas], ['aprobado', 'vendedor', ['RD'], ['Gautier Semences']]);
            assert.deepEqual(yo.modulos, ['clientes', 'visitas', 'tareas', 'mensajes', 'sitios']);
        });

        test('ámbito: cada quien ve y escribe solo su país, su casa comercial y los módulos de su cargo', async () => {
            await pool.query('DELETE FROM registros');
            const base = [
                { modulo: 'clientes', registro: { id: 'rd-g', nombre: 'Finca RD Gautier', pais: 'RD', casa: 'Gautier Semences', telefono: '809' } },
                { modulo: 'clientes', registro: { id: 'rd-f', nombre: 'Finca RD Fitó', pais: 'RD', casa: 'Fitó' } },
                { modulo: 'clientes', registro: { id: 've-g', nombre: 'Finca VE Gautier', pais: 'VE', casa: 'Gautier Semences' } },
                { modulo: 'clientes', registro: { id: 'viejo', nombre: 'Sin país ni casa' } },
                { modulo: 'agronomia', registro: { id: 'p1', clienteId: 'rd-g', pais: 'RD', casa: 'Gautier Semences', proceso: 'Siembra' } },
                { modulo: 'tareas', registro: { id: 't-equipo', titulo: 'Reunión del lunes' } }
            ];
            assert.equal((await accion(sesiones.ana, { accion: 'sincronizar', guardar: base })).estado, 200);

            // Luis: vendedor, RD + Gautier
            const luis = (await accion(sesiones.luis, { accion: 'sincronizar' })).json.datos;
            assert.deepEqual(Object.keys(luis).sort(), ['clientes', 'mensajes', 'sitios', 'tareas', 'visitas']);
            assert.deepEqual(luis.clientes.map(c => c.id), ['rd-g']);
            assert.equal(luis.tareas.length, 1); // Las tareas son de todo el equipo
            // No puede crear fuera de su ámbito, ni en módulos que no son suyos, ni pisar ni borrar lo ajeno
            for (const op of [
                { guardar: [{ modulo: 'clientes', registro: { id: 'nuevo', nombre: 'X', pais: 'VE', casa: 'Gautier Semences' } }] },
                { guardar: [{ modulo: 'clientes', registro: { id: 'nuevo', nombre: 'X' } }] },
                { guardar: [{ modulo: 'agronomia', registro: { id: 'p2', pais: 'RD', casa: 'Gautier Semences' } }] },
                { guardar: [{ modulo: 'clientes', registro: { id: 'rd-f', nombre: 'Lo cambio a mi casa', pais: 'RD', casa: 'Gautier Semences' } }] },
                { eliminar: [{ modulo: 'clientes', id: 've-g' }] }
            ]) {
                const r = await accion(sesiones.luis, { accion: 'sincronizar', ...op });
                assert.equal(r.estado, 403, JSON.stringify(op));
                assert.equal(r.json.codigo, 'permiso');
            }
            assert.equal((await accion(sesiones.luis, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'mio', nombre: 'Nuevo de Luis', pais: 'RD', casa: 'Gautier Semences' } }] })).estado, 200);
            assert.equal((await accion(sesiones.luis, { accion: 'crm', modulo: 'clientes', registro: { id: 'otro', nombre: 'X', pais: 'VE', casa: 'Fitó' } })).estado, 403);

            // Técnico de RD + Gautier: procesos sí; de los clientes solo el nombre
            google.identidades['codigo-tec'] = { email: 'tec@semillasdata.com', verificado: true, dominio: 'semillasdata.com', nombre: 'Tec', foto: '', tokenRefresco: 'r', permisos: '' };
            sesiones.tec = (await entrarComo('codigo-tec')).json.sesion;
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'tec@semillasdata.com', cargo: 'tecnico', paises: ['RD'], casas: ['Gautier Semences'] });
            const tec = (await accion(sesiones.tec, { accion: 'sincronizar' })).json.datos;
            assert.deepEqual(tec.agronomia.map(p => p.id), ['p1']);
            assert.deepEqual(tec.clientes.find(c => c.id === 'rd-g'), { id: 'rd-g', nombre: 'Finca RD Gautier', pais: 'RD', casa: 'Gautier Semences' });
            assert.equal((await accion(sesiones.tec, { accion: 'sincronizar', guardar: [{ modulo: 'clientes', registro: { id: 'z', nombre: 'Z', pais: 'RD', casa: 'Gautier Semences' } }] })).estado, 403);

            // Quien lo ve todo (la jefa) ve también lo que no tiene país ni casa
            const jefa = (await accion(sesiones.jefa, { accion: 'sincronizar' })).json.datos;
            assert.ok(jefa.clientes.some(c => c.id === 'viejo'));
            // La exportación respeta el ámbito
            await accion(sesiones.luis, { accion: 'exportar' }).catch(() => {});
            const exportado = google.llamadas.filter(l => l.tipo === 'exportar').at(-1);
            assert.ok(!JSON.stringify(exportado.datos.pestanas).includes('Finca VE Gautier'));
        });

        test('tablero: presencia, mensajes directos y pasar un cliente', async () => {
            await pool.query('DELETE FROM cola_avisos');
            await accion(sesiones.luis, { accion: 'presencia', estado: 'en_parcela' });
            const tablero = await accion(sesiones.ana, { accion: 'presencia' });
            const luis = tablero.json.equipo.find(p => p.email === 'luis@semillasdata.com');
            assert.deepEqual([luis.estado, luis.cargo, luis.foto], ['en_parcela', 'vendedor', 'https://lh3.googleusercontent.com/luis']);
            assert.ok(!tablero.json.equipo.some(p => p.email === 'externa@gmail.com')); // Fuera del equipo: no sale
            await pool.query("UPDATE usuarios SET visto = UTC_TIMESTAMP() - INTERVAL 10 MINUTE WHERE email = 'luis@semillasdata.com'");
            assert.equal((await accion(sesiones.ana, { accion: 'presencia' })).json.equipo.find(p => p.email === 'luis@semillasdata.com').estado, 'desconectado');

            // Mensaje directo: bandeja + WhatsApp a esa persona (no a todo el equipo)
            assert.equal((await accion(sesiones.ana, { accion: 'directo', para: 'nadie@x.com', texto: 'Hola' })).estado, 404);
            assert.equal((await accion(sesiones.ana, { accion: 'directo', para: 'ana@semillasdata.com', texto: 'Hola' })).estado, 400);
            await accion(sesiones.ana, { accion: 'directo', para: 'luis@semillasdata.com', texto: '¿Pasas por Constanza?', tipo: 'reunion', enlace: 'https://meet.google.com/abc-defg-hij' });
            await accion(sesiones.ana, { accion: 'directo', para: 'luis@semillasdata.com', texto: 'Enlace raro', enlace: 'https://malvado.com' });
            const [wa] = await pool.query("SELECT destino, texto FROM cola_avisos WHERE canal = 'whatsapp' ORDER BY id");
            assert.deepEqual(wa.map(w => w.destino), ['18295550202', '18295550202']);
            assert.match(wa[0].texto, /📹 Ana Prueba|📹 Ana/);
            assert.equal((await accion(sesiones.luis, { accion: 'presencia' })).json.sinLeer, 2);
            const bandeja = (await accion(sesiones.luis, { accion: 'bandeja' })).json.mensajes;
            assert.deepEqual(bandeja.map(m => [m.tipo, m.enlace]), [['mensaje', ''], ['reunion', 'https://meet.google.com/abc-defg-hij']]);
            assert.equal((await accion(sesiones.luis, { accion: 'presencia' })).json.sinLeer, 0);

            // Pasar un cliente: solo si quien lo recibe puede verlo
            assert.equal((await accion(sesiones.ana, { accion: 'pasarCliente', clienteId: 've-g', para: 'luis@semillasdata.com' })).estado, 400);
            assert.equal((await accion(sesiones.ana, { accion: 'pasarCliente', clienteId: 'rd-g', para: 'tec@semillasdata.com' })).estado, 400); // El técnico no gestiona clientes
            assert.equal((await accion(sesiones.luis, { accion: 'pasarCliente', clienteId: 've-g', para: 'ana@semillasdata.com' })).estado, 403);
            const pase = await accion(sesiones.ana, { accion: 'pasarCliente', clienteId: 'rd-g', para: 'luis@semillasdata.com', nota: 'Llama mañana' });
            assert.equal(pase.estado, 200);
            const cliente = (await accion(sesiones.luis, { accion: 'sincronizar' })).json.datos.clientes.find(c => c.id === 'rd-g');
            assert.deepEqual([cliente.asignado, cliente.asignadoNombre, cliente.telefono], ['luis@semillasdata.com', 'Luis', '809']);
            assert.match((await accion(sesiones.luis, { accion: 'bandeja' })).json.mensajes[0].texto, /Te pasó el cliente Finca RD Gautier: Llama mañana/);
        });

        test('resumen de la mañana: a su hora, una vez al día, solo con lo suyo y por su canal', async () => {
            await pool.query('DELETE FROM cola_avisos');
            await pool.query('UPDATE usuarios SET resumen_fecha = NULL, resumen_activo = 1');
            // Que la jefa vuelva a tener Google conectado (una prueba anterior se lo quitó)
            await entrarComo('codigo-jefa');
            await accion(sesiones.ana, { accion: 'sincronizar', guardar: [
                { modulo: 'clientes', registro: { id: 'rd-g', nombre: 'Finca RD Gautier', pais: 'RD', casa: 'Gautier Semences', seguimiento: '2026-11-03', asignado: 'luis@semillasdata.com', asignadoNombre: 'Luis' } },
                { modulo: 'clientes', registro: { id: 've-g', nombre: 'Finca VE Gautier', pais: 'VE', casa: 'Gautier Semences', seguimiento: '2026-11-02' } },
                { modulo: 'tareas', registro: { id: 't-luis', titulo: 'Llevar muestras', para: 'Luis', vence: '2026-11-03', prioridad: 'Alta' } }
            ] });
            // La jefa, sin WhatsApp ni push: el resumen le tiene que llegar por correo
            await pool.query("UPDATE usuarios SET telefono = '' WHERE email = 'jefa@gmail.com'");
            await pool.query("DELETE p FROM push_suscripciones p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = 'jefa@gmail.com'");
            const ctx = { pool, config: { ...config, resumenHora: 7, whatsapp: { ...config.whatsapp, plantillaResumen: 'resumen_diario' } }, google, avisos, registrar: { error: () => {} } };
            // 6:59 en Santo Domingo (10:59 UTC): aún no
            assert.equal((await enviarResumenes(ctx, new Date('2026-11-03T10:59:00Z'))).enviados, 0);
            // 7:05
            const r = await enviarResumenes(ctx, new Date('2026-11-03T11:05:00Z'));
            const luis = r.personas.find(p => p.email === 'luis@semillasdata.com');
            assert.equal(luis.canal, 'whatsapp'); // Tiene WhatsApp
            const [[wa]] = await pool.query("SELECT texto, plantilla, parametros FROM cola_avisos WHERE destino = '18295550202'");
            assert.match(wa.texto, /Soy Borja.*Finca RD Gautier \(hoy\).*Llevar muestras \(vence hoy, prioridad alta\)/);
            assert.ok(!wa.texto.includes('Finca VE Gautier')); // Venezuela no es de su ámbito
            // Con la plantilla de resumen, a Meta le llegan sus 7 variables
            assert.equal(wa.plantilla, 'resumen_diario');
            assert.deepEqual(JSON.parse(wa.parametros).slice(0, 4), ['Luis', 'Vendedor · 🇩🇴 RD · Gautier Semences', 'Sin pendientes', 'Finca RD Gautier (hoy)']);
            peticionesMeta.length = 0;
            await repasar(pool, avisos);
            const plantilla = peticionesMeta.find(p => p.cuerpo.to === '18295550202').cuerpo.template;
            assert.equal(plantilla.name, 'resumen_diario');
            assert.equal(plantilla.components[0].parameters.length, 7);
            assert.equal(plantilla.components[0].parameters[4].text, 'Llevar muestras (vence hoy, prioridad alta)');
            // La jefa: por correo, a sí misma, con su agenda de Google Calendar
            assert.deepEqual(r.personas.find(p => p.email === 'jefa@gmail.com'), { email: 'jefa@gmail.com', canal: 'correo' });
            const correo = Buffer.from(google.llamadas.filter(l => l.tipo === 'correo').at(-1).crudo, 'base64url').toString();
            assert.match(correo, /^To: jefa@gmail.com/);
            const cuerpo = Buffer.from(correo.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
            assert.match(cuerpo, /📅 Tu agenda de hoy\n• 10:00.*Comité de la mañana \(Meet: https:\/\/meet.google.com\/aaa-bbbb-ccc\)/);
            assert.match(cuerpo, /Finca VE Gautier \(atrasado desde el 2\/11\)/); // La jefa lo ve todo
            // Una sola vez al día, aunque se llame otra vez (o desde otro proceso)
            assert.equal((await enviarResumenes(ctx, new Date('2026-11-03T12:00:00Z'))).enviados, 0);
            // A las 12:00 local ya no sale lo de hoy (ventana de 5 horas)
            await pool.query('UPDATE usuarios SET resumen_fecha = NULL');
            assert.equal((await enviarResumenes(ctx, new Date('2026-11-03T16:30:00Z'))).enviados, 0);
            // Quien lo desactiva no lo recibe
            await accion(sesiones.luis, { accion: 'resumen', activo: false });
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.luis })).json.usuario.resumen, false);
            const dia2 = await enviarResumenes(ctx, new Date('2026-11-04T11:10:00Z'));
            assert.ok(!dia2.personas.some(p => p.email === 'luis@semillasdata.com'));
            // Con RESUMEN_HORA=no no sale nada
            await pool.query('UPDATE usuarios SET resumen_fecha = NULL, resumen_activo = 1');
            assert.equal((await enviarResumenes({ ...ctx, config: { ...config, resumenHora: null } }, new Date('2026-11-05T11:10:00Z'))).enviados, 0);
        });

        test('germinador: el plantulador ve sus lotes y la germinación baja avisa solo a quien ve el lote', async () => {
            const crear = async (codigo, email, nombre, cargo, paises, casas, telefono) => {
                google.identidades[codigo] = { email, verificado: true, dominio: 'semillasdata.com', nombre, foto: '', tokenRefresco: `r-${codigo}`, permisos: '' };
                const r = await entrarComo(codigo);
                await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email, cargo, paises, casas });
                await pool.query('UPDATE usuarios SET telefono = ? WHERE email = ?', [telefono, email]);
                return r.json.sesion;
            };
            const plantu = await crear('codigo-plantu', 'plantu@semillasdata.com', 'Pedro Plantulador', 'plantulador', ['RD'], ['Gautier Semences'], '18095551001');
            await crear('codigo-tecrd', 'tecrd@semillasdata.com', 'Tere Técnica', 'tecnico', ['RD'], ['Gautier Semences'], '18095551002');
            await crear('codigo-tecve', 'tecve@semillasdata.com', 'Víctor Técnico', 'tecnico', ['VE'], ['Gautier Semences'], '18095551003');
            await pool.query('DELETE FROM cola_avisos');

            // El plantulador: germinador, tareas y chat; de los clientes, solo el nombre
            const yo = (await llamar('/api/yo', { metodo: 'GET', sesion: plantu })).json.usuario;
            assert.deepEqual(yo.modulos, ['germinador', 'tareas', 'mensajes', 'sitios']);
            const lote = { id: 'lote-1', lote: 'L-031', clienteId: 'rd-g', cliente: 'Finca RD Gautier', variedad: 'Tomate Hexagon', estado: 'En cámara', pais: 'RD', casa: 'Gautier Semences', germinacion: 92, temperatura: 26.5, humedad: 88 };
            const r1 = await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: lote }] });
            assert.equal(r1.estado, 200);
            assert.ok(!('agronomia' in r1.json.datos));
            assert.deepEqual(Object.keys(r1.json.datos.clientes.find(c => c.id === 'rd-g')).sort(), ['casa', 'id', 'nombre', 'pais']);
            assert.equal((await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'agronomia', registro: { id: 'x', pais: 'RD', casa: 'Gautier Semences' } }] })).estado, 403);
            assert.equal((await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: { ...lote, id: 'lote-ve', pais: 'VE' } }] })).estado, 403);
            // 92 %: sin aviso
            assert.equal((await pool.query('SELECT COUNT(*) n FROM cola_avisos'))[0][0].n, 0);

            // Baja a 72 %: aviso a la técnica de RD + Gautier y a los Master; no al vendedor, ni a Venezuela, ni a quien lo registró
            await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: { ...lote, germinacion: 72 } }] });
            const [wa] = await pool.query("SELECT destino, texto FROM cola_avisos WHERE canal = 'whatsapp' ORDER BY destino");
            const destinos = wa.map(w => w.destino);
            assert.ok(destinos.includes('18095551002'), JSON.stringify(destinos));
            assert.ok(!destinos.includes('18095551003') && !destinos.includes('18095551001') && !destinos.includes('18295550202'), JSON.stringify(destinos));
            assert.match(wa[0].texto, /🚨 Germinación baja · Lote L-031\n72 % \(por debajo del 85 %\) · Tomate Hexagon · Finca RD Gautier · cámara 26.5 °C \/ 88 % HR — registró Pedro Plantulador/);
            // Sigue bajo: no se repite; sube y vuelve a bajar: sí
            await pool.query('DELETE FROM cola_avisos');
            await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: { ...lote, germinacion: 70 } }] });
            assert.equal((await pool.query('SELECT COUNT(*) n FROM cola_avisos'))[0][0].n, 0);
            await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: { ...lote, germinacion: 90 } }] });
            await accion(plantu, { accion: 'crm', modulo: 'germinador', registro: { ...lote, germinacion: 60 } });
            assert.ok((await pool.query('SELECT COUNT(*) n FROM cola_avisos'))[0][0].n > 0);
            // Un lote despachado o descartado no avisa
            await pool.query('DELETE FROM cola_avisos');
            await accion(plantu, { accion: 'sincronizar', guardar: [{ modulo: 'germinador', registro: { ...lote, id: 'lote-2', germinacion: 40, estado: 'Descartado' } }] });
            assert.equal((await pool.query('SELECT COUNT(*) n FROM cola_avisos'))[0][0].n, 0);
            // El vendedor no ve el germinador
            assert.ok(!('germinador' in (await accion(sesiones.luis, { accion: 'sincronizar' })).json.datos));
        });

        test('rechazar a alguien lo saca: sesiones fuera y sin avisos', async () => {
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'rechazar', email: 'tec@semillasdata.com' });
            assert.equal((await accion(sesiones.tec, { accion: 'sincronizar' })).estado, 401);
            const otra = await entrarComo('codigo-tec');
            const r = await accion(otra.json.sesion, { accion: 'sala', telefono: '8095550303' });
            assert.equal(r.json.codigo, 'rechazado');
            await accion(sesiones.jefa, { accion: 'accesos', operacion: 'reabrir', email: 'tec@semillasdata.com' });
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: otra.json.sesion })).json.usuario.estado, 'pendiente');
        });

        test('cuentas personales (opción B): entran a la sala de espera y no ven nada hasta que un Master las aprueba', async () => {
            const reto = 'b'.repeat(43);
            // Apagadas: el botón de cuenta personal no sirve y quien no es del dominio no entra
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&cuenta=personal`, { metodo: 'GET' })).estado, 403);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&cuenta=otra`, { metodo: 'GET' })).estado, 400);
            assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&cuenta=conectar`, { metodo: 'GET' })).estado, 302);
            assert.equal(google.ultimaAutorizacion.cuenta, 'conectar');

            config.google.cuentasPersonales = true;
            try {
                assert.equal((await llamar('/api/salud', { metodo: 'GET' })).json.acceso.cuentasPersonales, true);
                assert.equal((await llamar(`/api/auth/google/inicio?reto=${reto}&cuenta=personal`, { metodo: 'GET' })).estado, 302);
                assert.equal(google.ultimaAutorizacion.cuenta, 'personal');

                // Cuenta de Gmail sin permisos de Workspace (sin token de refresco): entra, pero a la sala de espera
                google.identidades['codigo-gmail'] = { email: 'Productor@gmail.com', verificado: true, dominio: '', nombre: 'Productor', foto: '', tokenRefresco: '', permisos: 'openid email profile' };
                const r = await entrarComo('codigo-gmail');
                assert.equal(r.estado, 200);
                assert.equal(r.json.usuario.estado, 'pendiente');
                assert.equal(r.json.usuario.tipoCuenta, 'personal');
                assert.equal(r.json.usuario.googleConectado, false);
                const productor = r.json.sesion;
                assert.equal((await accion(productor, { accion: 'sincronizar' })).estado, 403);
                assert.equal((await accion(productor, { accion: 'exportar' })).estado, 403);
                assert.equal((await accion(productor, { accion: 'sala', telefono: '0414 123 4567' })).json.usuario.telefono, '584141234567');
                // Sin el correo verificado, tampoco con la opción B
                assert.match((await entrarComo('codigo-sinverificar')).error, /verificado/);

                // El Master la ve marcada como cuenta personal y la aprueba como cualquier otra
                const lista = await accion(sesiones.jefa, { accion: 'accesos', operacion: 'listar' });
                assert.equal(lista.json.personas.find(p => p.email === 'productor@gmail.com').tipoCuenta, 'personal');
                assert.equal(lista.json.personas.find(p => p.email === 'ana@semillasdata.com').tipoCuenta, 'empresa');
                await accion(sesiones.jefa, { accion: 'accesos', operacion: 'aprobar', email: 'productor@gmail.com', cargo: 'vendedor', paises: ['VE'], casas: ['Fitó'] });
                const datos = await accion(productor, { accion: 'sincronizar' });
                assert.equal(datos.estado, 200);
                assert.ok(datos.json.datos.clientes.every(c => c.pais === 'VE' && c.casa === 'Fitó'));
                // Sin Gmail conectado, lo que usa Google pide conectarlo
                const correo = await accion(productor, { accion: 'correo', para: 'x@y.com', asunto: 'Hola', texto: 'x' });
                assert.equal(correo.estado, 403);
                assert.equal(correo.json.codigo, 'google');
            } finally {
                config.google.cuentasPersonales = false;
            }
        });

        test('salir cierra la sesión', async () => {
            assert.equal((await llamar('/api/salir', { sesion: sesiones.ana })).estado, 200);
            assert.equal((await llamar('/api/yo', { metodo: 'GET', sesion: sesiones.ana })).estado, 401);
        });
    });
}
