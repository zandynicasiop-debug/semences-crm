/**
 * AgroSimulador · Semences del Caribe — Web App de Google Apps Script
 *
 * Recibe los envíos de googleSync.js (POST con el cuerpo en JSON, como text/plain) y según "accion":
 *   sheets   → añade una fila de métricas a la hoja "Métricas"
 *   chat     → publica el mensaje en un espacio de Google Chat (webhook entrante)
 *   calendar → crea un evento en Google Calendar
 *   meet     → crea un evento con videollamada de Meet y devuelve { meetUrl }
 *   crm      → guarda (crea o actualiza) un registro del CRM en su pestaña
 *   sincronizar → base de datos compartida: aplica los cambios pendientes de la app
 *               ({ guardar: [{ modulo, registro }], eliminar: [{ modulo, id }] }) y devuelve todos los datos
 *
 * Instrucciones de despliegue: apps-script/DESPLIEGUE.md
 */

// ===== Configuración: rellena estos valores antes de desplegar =====
const CONFIG = {
  // Clave compartida: la misma que CONFIG_GOOGLE.token en googleSync.js. Envíos sin ella se rechazan.
  TOKEN: 'semences-caribe-secret-token-2026',
  // ID de la hoja de cálculo (lo que va entre /d/ y /edit en su URL). Vacío: la hoja a la que está
  // vinculado este script (si se creó desde Extensiones › Apps Script dentro de la hoja).
  SHEET_ID: '',
  HOJA_METRICAS: 'Métricas',
  // Webhook entrante del espacio de Google Chat (Configuración del espacio › Apps e integraciones › Webhooks)
  CHAT_WEBHOOK: '',
  // Calendario donde se crean eventos y reuniones. 'primary' es el calendario de quien despliega.
  CALENDAR_ID: 'primary',
  ZONA_HORARIA: 'America/Santo_Domingo',
  // Duración por defecto de inspecciones y reuniones de emergencia, en minutos
  DURACION_MIN: 30,
  // Inicio de sesión con Google (ver DESPLIEGUE.md). Vacío: sin inicio de sesión, basta con TOKEN.
  // Con un Client ID, cada envío tiene que traer una cuenta de Google válida y autorizada.
  CLIENT_ID: '',
  // Cuentas autorizadas: todas las de este dominio de Google Workspace (p. ej. 'semencesdelcaribe.com')…
  DOMINIO: '',
  // …y los correos de la columna A de esta pestaña (se crea sola la primera vez)
  HOJA_EQUIPO: 'Equipo'
};

// Columnas de la hoja de métricas, en orden
const COLUMNAS = [
  'fecha', 'semillasMiles', 'parcelasActivas', 'parcelasTotales',
  'eficiencia', 'alertasPendientes', 'alertasVencidas', 'clima'
];

function doPost(e) {
  let datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return responder({ ok: false, error: 'El cuerpo no es JSON válido' });
  }
  if (datos.token !== CONFIG.TOKEN) {
    return responder({ ok: false, error: 'Clave no válida' });
  }
  if (CONFIG.CLIENT_ID) {
    const cuenta = verificarCuenta(datos.idToken);
    if (!cuenta.ok) return responder(cuenta);
    datos.cuenta = cuenta.email;
  }

  try {
    switch (datos.accion) {
      case 'sheets': return responder(guardarMetricas(datos));
      case 'chat': return responder(publicarEnChat(datos.mensaje));
      case 'calendar': return responder(crearEvento(datos));
      case 'meet': return responder(crearReunionMeet(datos.titulo));
      case 'crm': return responder(guardarRegistroCRM(datos.modulo, datos.registro));
      case 'sincronizar': return responder(sincronizarDatos(datos));
      default: return responder({ ok: false, error: 'Acción desconocida: ' + datos.accion });
    }
  } catch (error) {
    console.error(datos.accion, error);
    return responder({ ok: false, error: String(error && error.message || error) });
  }
}

// Comprobación rápida en el navegador: abrir la URL del Web App debe mostrar { ok: true }
function doGet() {
  return responder({ ok: true, servicio: 'AgroSimulador · Semences del Caribe' });
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----- Sheets: una fila por envío, con cabecera la primera vez -----
function guardarMetricas(datos) {
  const libro = CONFIG.SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!libro) throw new Error('Configura SHEET_ID o crea el script desde la hoja');

  // Varias pestañas abiertas pueden escribir a la vez: se serializa con un candado
  const candado = LockService.getScriptLock();
  candado.waitLock(10000);
  try {
    let hoja = libro.getSheetByName(CONFIG.HOJA_METRICAS);
    if (!hoja) {
      hoja = libro.insertSheet(CONFIG.HOJA_METRICAS);
      hoja.appendRow(COLUMNAS);
      hoja.setFrozenRows(1);
      hoja.getRange(1, 1, 1, COLUMNAS.length).setFontWeight('bold');
    }
    const fila = COLUMNAS.map(col => col === 'fecha' ? new Date(datos.fecha || Date.now()) : (datos[col] ?? ''));
    hoja.appendRow(fila);
  } finally {
    candado.releaseLock();
  }
  return { ok: true };
}

// ----- Base de datos compartida: una pestaña por módulo ("CRM · clientes", ...), una fila por registro -----
// La columna "id" identifica cada registro. Todas las celdas se guardan como texto plano para que
// Sheets no convierta fechas ni números; la app recupera los tipos al leer.
const MODULOS_CRM = ['clientes', 'visitas', 'agronomia', 'rendimiento', 'sitios', 'mensajes', 'tareas']; // sitios: fichas del mapa · mensajes: chat · tareas: tareas del equipo · mensajes: chat del equipo

// ----- Inicio de sesión con Google: verificación del ID token y lista de cuentas autorizadas -----
// Devuelve { ok: true, email } o { ok: false, codigo: 'sesion' | 'acceso', error }
function verificarCuenta(idToken) {
  if (!idToken) return { ok: false, codigo: 'sesion', error: 'Falta iniciar sesión con Google' };
  // Un mismo token se verifica con Google una vez y se recuerda unos minutos
  const cache = CacheService.getScriptCache();
  const clave = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const guardado = cache.get(clave);
  let info = guardado ? JSON.parse(guardado) : null;
  if (!info) {
    const respuesta = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (respuesta.getResponseCode() !== 200) return { ok: false, codigo: 'sesion', error: 'Sesión de Google caducada o no válida' };
    info = JSON.parse(respuesta.getContentText());
  }
  const segundosRestantes = Number(info.exp) - Math.floor(Date.now() / 1000);
  if (info.aud !== CONFIG.CLIENT_ID) return { ok: false, codigo: 'sesion', error: 'La sesión no es de esta app' };
  if (String(info.email_verified) !== 'true') return { ok: false, codigo: 'acceso', error: 'La cuenta de Google no tiene el correo verificado' };
  if (segundosRestantes <= 0) return { ok: false, codigo: 'sesion', error: 'Sesión de Google caducada' };
  const email = String(info.email).toLowerCase();
  if (!cuentaAutorizada(email, info.hd)) {
    return { ok: false, codigo: 'acceso', error: 'La cuenta ' + email + ' no está autorizada. Pide que la añadan a la pestaña "' + CONFIG.HOJA_EQUIPO + '" de la hoja.' };
  }
  if (!guardado) cache.put(clave, JSON.stringify({ aud: info.aud, email: info.email, email_verified: info.email_verified, exp: info.exp, hd: info.hd || '' }), Math.min(600, segundosRestantes));
  return { ok: true, email: email };
}

function cuentaAutorizada(email, dominioCuenta) {
  if (CONFIG.DOMINIO && (dominioCuenta === CONFIG.DOMINIO || email.endsWith('@' + CONFIG.DOMINIO))) return true;
  const cache = CacheService.getScriptCache();
  let lista = cache.get('equipo');
  if (lista === null) {
    const libro = abrirLibro();
    let hoja = libro.getSheetByName(CONFIG.HOJA_EQUIPO);
    if (!hoja) {
      hoja = libro.insertSheet(CONFIG.HOJA_EQUIPO);
      hoja.getRange(1, 1, 1, 3).setValues([['correo', 'nombre', 'notas']]).setFontWeight('bold');
      hoja.setFrozenRows(1);
    }
    const filas = hoja.getLastRow() > 1 ? hoja.getRange(2, 1, hoja.getLastRow() - 1, 1).getDisplayValues() : [];
    lista = filas.map(f => String(f[0]).trim().toLowerCase()).filter(Boolean).join('\n');
    cache.put('equipo', lista, 120); // Los cambios en la pestaña se notan en 2 minutos como mucho
  }
  return lista.split('\n').includes(email);
}

function abrirLibro() {
  const libro = CONFIG.SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!libro) throw new Error('Configura SHEET_ID o crea el script desde la hoja');
  return libro;
}

function comprobarModulo(modulo) {
  if (MODULOS_CRM.indexOf(modulo) < 0) throw new Error('Módulo de CRM desconocido: ' + modulo);
}

function hojaDeModulo(libro, modulo, crear) {
  const nombre = 'CRM · ' + modulo;
  let hoja = libro.getSheetByName(nombre);
  if (!hoja && crear) {
    hoja = libro.insertSheet(nombre);
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function cabecera(hoja) {
  return hoja.getLastColumn() ? hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String) : [];
}

// Número de fila del registro con ese id, o 0 si no está
function filaDeId(hoja, columnas, id) {
  const col = columnas.indexOf('id');
  const ultima = hoja.getLastRow();
  if (col < 0 || ultima < 2) return 0;
  const ids = hoja.getRange(2, col + 1, ultima - 1, 1).getDisplayValues().map(f => f[0]);
  const i = ids.indexOf(String(id));
  return i < 0 ? 0 : i + 2;
}

// Crea el registro o actualiza su fila si ya existe (sin candado: lo pone quien llama)
function guardarRegistro(libro, modulo, registro) {
  comprobarModulo(modulo);
  if (!registro || typeof registro !== 'object' || !registro.id) throw new Error('Registro sin id');
  const hoja = hojaDeModulo(libro, modulo, true);
  let columnas = cabecera(hoja);
  if (!columnas.length) columnas = ['id'];
  const nuevas = Object.keys(registro).filter(k => columnas.indexOf(k) < 0);
  if (nuevas.length || hoja.getLastColumn() === 0) {
    columnas = columnas.concat(nuevas);
    hoja.getRange(1, 1, 1, columnas.length).setValues([columnas]).setFontWeight('bold');
  }
  const fila = filaDeId(hoja, columnas, registro.id) || hoja.getLastRow() + 1;
  const valores = columnas.map(col => (registro[col] === undefined || registro[col] === null) ? '' : String(registro[col]));
  hoja.getRange(fila, 1, 1, columnas.length).setNumberFormat('@').setValues([valores]);
}

function eliminarRegistro(libro, modulo, id) {
  comprobarModulo(modulo);
  const hoja = hojaDeModulo(libro, modulo, false);
  if (!hoja) return;
  const fila = filaDeId(hoja, cabecera(hoja), id);
  if (fila) hoja.deleteRow(fila);
}

// Todos los registros de todos los módulos, como objetos { columna: texto }
function listarTodo(libro) {
  const datos = {};
  MODULOS_CRM.forEach(modulo => {
    datos[modulo] = [];
    const hoja = hojaDeModulo(libro, modulo, false);
    if (!hoja || hoja.getLastRow() < 2) return;
    const filas = hoja.getDataRange().getDisplayValues();
    const columnas = filas.shift();
    filas.forEach(f => {
      const registro = {};
      columnas.forEach((col, i) => { if (col && f[i] !== '') registro[col] = f[i]; });
      if (registro.id) datos[modulo].push(registro);
    });
  });
  return datos;
}

// Guardado suelto de un registro (acción 'crm')
function guardarRegistroCRM(modulo, registro) {
  const libro = abrirLibro();
  const candado = LockService.getScriptLock();
  candado.waitLock(10000);
  try {
    guardarRegistro(libro, modulo, registro);
  } finally {
    candado.releaseLock();
  }
  return { ok: true };
}

// Sincronización de la app: primero sus cambios pendientes, luego la foto completa de los datos
function sincronizarDatos(datos) {
  const libro = abrirLibro();
  const candado = LockService.getScriptLock();
  candado.waitLock(20000);
  try {
    // Con inicio de sesión, cada registro guarda la cuenta verificada que lo subió (no la escrita en la app)
    (datos.guardar || []).forEach(op => guardarRegistro(libro, op.modulo, datos.cuenta ? Object.assign({}, op.registro, { cuenta: datos.cuenta }) : op.registro));
    (datos.eliminar || []).forEach(op => eliminarRegistro(libro, op.modulo, op.id));
    return { ok: true, datos: listarTodo(libro), hora: new Date().toISOString() };
  } finally {
    candado.releaseLock();
  }
}

// ----- Chat: mensaje al espacio por su webhook entrante -----
function publicarEnChat(mensaje) {
  if (!CONFIG.CHAT_WEBHOOK) throw new Error('Configura CHAT_WEBHOOK');
  if (!mensaje) throw new Error('Mensaje vacío');
  const respuesta = UrlFetchApp.fetch(CONFIG.CHAT_WEBHOOK, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: String(mensaje).slice(0, 4000) }),
    muteHttpExceptions: true
  });
  const codigo = respuesta.getResponseCode();
  if (codigo >= 300) throw new Error('Google Chat respondió ' + codigo);
  return { ok: true };
}

// ----- Calendar: evento simple ({ titulo, inicio, fin, descripcion }) -----
function crearEvento(datos) {
  const calendario = CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!calendario) throw new Error('No se encontró el calendario ' + CONFIG.CALENDAR_ID);

  const inicio = datos.inicio ? new Date(datos.inicio) : new Date();
  const fin = datos.fin ? new Date(datos.fin) : new Date(inicio.getTime() + CONFIG.DURACION_MIN * 60000);
  if (isNaN(inicio) || isNaN(fin) || fin <= inicio) throw new Error('Fechas de inicio o fin no válidas');

  const evento = calendario.createEvent(datos.titulo || 'Inspección · Semences del Caribe', inicio, fin, {
    description: datos.descripcion || ''
  });
  return { ok: true, eventoId: evento.getId() };
}

// ----- Meet: evento que empieza ahora con videollamada (servicio avanzado de Calendar) -----
function crearReunionMeet(titulo) {
  const inicio = new Date();
  const fin = new Date(inicio.getTime() + CONFIG.DURACION_MIN * 60000);
  const evento = Calendar.Events.insert({
    summary: titulo || 'Emergencia técnica · Semences del Caribe',
    start: { dateTime: inicio.toISOString(), timeZone: CONFIG.ZONA_HORARIA },
    end: { dateTime: fin.toISOString(), timeZone: CONFIG.ZONA_HORARIA },
    conferenceData: {
      createRequest: {
        requestId: Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  }, CONFIG.CALENDAR_ID, { conferenceDataVersion: 1 });

  const meetUrl = evento.hangoutLink ||
    ((evento.conferenceData && evento.conferenceData.entryPoints) || [])
      .filter(p => p.entryPointType === 'video')
      .map(p => p.uri)[0] || '';
  if (!meetUrl) throw new Error('Calendar no devolvió enlace de Meet');
  return { ok: true, meetUrl, eventoId: evento.id };
}

/**
 * Prueba desde el editor (Ejecutar › probarTodo): simula los cuatro envíos sin pasar por la web.
 * Revisa el resultado en Registro de ejecución.
 */
function probarTodo() {
  const enviar = (cuerpo) => JSON.parse(doPost({ postData: { contents: JSON.stringify({ token: CONFIG.TOKEN, ...cuerpo }) } }).getContent());
  console.log('sheets', enviar({
    accion: 'sheets', fecha: new Date().toISOString(), semillasMiles: 210, parcelasActivas: 11,
    parcelasTotales: 12, eficiencia: 100, alertasPendientes: 0, alertasVencidas: 0, clima: 'Soleado'
  }));
  if (CONFIG.CHAT_WEBHOOK) console.log('chat', enviar({ accion: 'chat', mensaje: 'Prueba del AgroSimulador' }));
  console.log('calendar', enviar({ accion: 'calendar', titulo: 'Prueba · inspección de invernaderos' }));
  console.log('meet', enviar({ accion: 'meet', titulo: 'Prueba · sala de emergencia técnica' }));
}
