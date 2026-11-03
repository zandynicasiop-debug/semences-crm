/**
 * Idioma de lo que el servidor manda fuera de la app: avisos push, WhatsApp, correos y la campana. Cada
 * persona elige español o inglés en la app (idioma.js de la web) y queda en usuarios.idioma; aquí se traduce
 * al enviar, según quien lo recibe. Lo que se ve dentro de la app lo traduce la propia web.
 *
 * Como en la web: el código escribe en español y aquí están las traducciones, por línea. Cada línea se busca
 * entera y, si no está, por trozos separados con « · » o «; ». Lo que no esté (un nombre, una nota, lo que
 * escribió alguien) se queda como está. Google Chat (el espacio de todo el equipo) y lo que va a los clientes
 * sigue en español.
 */

export const IDIOMAS = ['es', 'en'];

const EXACTOS = new Map(Object.entries({
    'Semences del Caribe · Aviso del equipo': 'Semences del Caribe · Team alert',
    'Nueva solicitud de acceso': 'New access request',
    'Acceso aprobado': 'Access approved',
    'Tu acceso está aprobado': 'Your access is approved',
    'Germinación baja': 'Low germination',
    'sin variedad': 'no variety',
    'sin cliente': 'no client',
    'Agenda la reunión con Meet desde su ficha: Google le enviará la invitación.': 'Schedule the meeting with Meet from their record: Google will send them the invitation.',
    'Entrega hoy tu reporte semanal: desde el lunes la app lo pide antes de seguir.': 'Submit your weekly report today: from Monday the app asks for it before you can continue.',
    'Te invita a una videollamada ahora': 'Invites you to a video call now',
    '🎥 Unirse a Meet': '🎥 Join Meet',
    'Abrir la app': 'Open the app',
    'aviso automático del CRM': 'automatic CRM notice',
    'Sin pendientes': 'Nothing pending',
    'Todo el día': 'All day',
    'ALERTA': 'ALERT',
    // Estados, etapas, motivos y lugares que van dentro de los avisos
    'Registrado': 'Registered', 'En tránsito': 'In transit', 'Retenido en aduana': 'Held at customs', 'En reparto': 'Out for delivery',
    'Entregado': 'Delivered', 'Incidencia': 'Exception',
    'Inicio de germinación': 'Germination start', 'Fin de germinación': 'Germination end', 'Trasplante': 'Transplant',
    'Inicio de cosecha': 'Harvest start', 'Fin de cosecha': 'Harvest end',
    'Plagas o enfermedades': 'Pests or diseases', 'Falla de riego': 'Irrigation failure', 'Clima adverso': 'Bad weather',
    'Cosecha urgente': 'Urgent harvest', 'Problema con un tractor': 'Tractor problem', 'Seguridad': 'Security',
    'Toda la finca': 'Whole farm', 'Parcela libre': 'Free plot', 'Germinador': 'Germination room', 'Cuarto de riego': 'Irrigation room',
    'Almacén y empaque': 'Warehouse and packing', 'Almacén de agroquímicos': 'Agrochemical store', 'Oficinas': 'Offices',
    'Ventas (miles de semillas)': 'Sales (thousands of seeds)', 'Clientes nuevos': 'New clients', 'Visitas a clientes': 'Client visits',
    'Ensayos de validación por variedad': 'Validation trials by variety', 'Actividades cumplidas (%)': 'Activities completed (%)',
    'Vendedor': 'Sales rep', 'Técnico': 'Technician', 'Plantulador': 'Seedling grower', 'Administrativo': 'Admin staff', 'Master': 'Master',
    'RD y Venezuela': 'DR and Venezuela', 'todas las casas': 'all brands', '🇩🇴 RD': '🇩🇴 DR',
    // Títulos del resumen de la mañana (el símbolo de delante se quita antes de buscar)
    'Tu agenda de hoy': 'Your calendar today',
    'Seguimientos de clientes': 'Client follow-ups',
    'Tus tareas': 'Your tasks',
    'Procesos agronómicos de hoy': 'Crop processes today',
    'Germinador': 'Germination room',
    'Envíos': 'Shipments',
    'Tablero del equipo': 'Team board',
    'Consolidado del equipo': 'Team overview',
    'Borja · Semences del Caribe': 'Borja · Semences del Caribe'
}));

const plural = (n, uno, varios) => (Number(n) === 1 ? uno : varios);

// [expresión entera, inglés]: el inglés es un texto con {1}, {2}… o una función de lo capturado (ya traducido)
const PATRONES = [
    // Avisos de la app
    [/^(.+) \((.+)\) espera en la sala de espera\. Entra a la app › Equipo y accesos para asignarle país, casa comercial y cargo\.$/u, '{1} ({2}) is in the waiting room. Open the app › Team and access to assign their country, brand and role.'],
    [/^(.+) \((.+), (cuenta personal de Google|cuenta de la empresa)\) pidió acceso al CRM\.$/u, (n, c, tipo) => `${n} (${c}, ${tipo === 'cuenta de la empresa' ? 'company account' : 'personal Google account'}) requested access to the CRM.`],
    [/^Entra a la app › Equipo y accesos para asignarle país, casa comercial y cargo, o rechazarla\.$/u, 'Open the app › Team and access to assign their country, brand and role, or reject it.'],
    [/^Hola (.*), ya puedes usar la app de Semences del Caribe\. Ábrela de nuevo para entrar\.$/u, (n) => `Hi ${n}, you can now use the Semences del Caribe app. Open it again to sign in.`],
    [/^Hola (.*):$/u, (n) => `Hi ${n}:`],
    [/^Ya puedes usar el CRM de Semences del Caribe como (.+), con (.+) y (.+)\. Abre la app de nuevo para entrar\.$/u, 'You can now use the Semences del Caribe CRM as {1}, with {2} and {3}. Open the app again to sign in.'],
    [/^Te pasó el cliente (.+?)(?:: (.+))?$/u, (c, nota) => `Handed you the client ${c}${nota ? `: ${nota}` : ''}`],
    [/^Te invita a una videollamada ahora: (.+)$/u, 'Invites you to a video call now: {1}'],
    [/^Te asignó una tarea \(prioridad (alta|media|baja)(?:, para el (.+?))?\): (.+)$/u, (p, cuando, t) => `Assigned you a task (${{ alta: 'high', media: 'medium', baja: 'low' }[p]} priority${cuando ? `, due ${cuando}` : ''}): ${t}`],
    [/^Germinación baja · Lote (.+?): (.+)$/u, 'Low germination · Batch {1}: {2}'],
    [/^Germinación baja · Lote (.+)$/u, 'Low germination · Batch {1}'],
    [/^([\d.,]+) % \(por debajo del (\d+) %\)$/u, '{1}% (below {2}%)'],
    [/^cámara (.+)$/u, (c) => `chamber ${c.replace(/% HR/g, '% RH')}`],
    [/^Hola (.+), soy Borja, de Semences del Caribe\. ¡Bienvenido al equipo! Por este número te llegarán las alertas de la finca, tus tareas, las reuniones y los avisos de la app\. (Toca «✅ Recibido»|Contesta OK a este mensaje) para confirmar que te llegan\.$/u,
        (n, como) => `Hi ${n}, I’m Borja from Semences del Caribe. Welcome to the team! This number will send you farm alerts, your tasks, meetings and app notifications. ${como.startsWith('Toca') ? 'Tap “✅ Recibido”' : 'Reply OK to this message'} to confirm you’re getting them.`],
    [/^¡Gracias, (.+)! Confirmado: ya estás conectado con el equipo\. Cuando haya una alerta te escribo por aquí\. — Borja$/u, 'Thanks, {1}! Confirmed: you’re now connected with the team. When there’s an alert I’ll message you here. — Borja'],
    [/^Cotización por aprobar · (.+?): (.+)$/u, 'Quote awaiting approval · {1}: {2}'],
    [/^Cotización por aprobar · (.+)$/u, 'Quote awaiting approval · {1}'],
    [/^Cotización aprobada · (.+?): (.+)$/u, 'Quote approved · {1}: {2}'],
    [/^Cotización aprobada · (.+)$/u, 'Quote approved · {1}'],
    [/^Cotización rechazada · (.+?): (.+)$/u, 'Quote rejected · {1}: {2}'],
    [/^Cotización rechazada · (.+)$/u, 'Quote rejected · {1}'],
    [/^(.+) — preparó (.+)$/u, '{1} — prepared by {2}'],
    [/^(.+) — aprobó (.+)$/u, '{1} — approved by {2}'],
    [/^(.+) — rechazó (.+)$/u, '{1} — rejected by {2}'],
    [/^(.+) — registró (.+)$/u, '{1} — logged by {2}'],
    [/^(.+) — (.+)$/u, '{1} — {2}'],
    [/^Envío (.*?): (.+)$/u, 'Shipment {1}: {2}'],
    [/^Envío (.+)$/u, 'Shipment {1}'],
    [/^llegada estimada (.+)$/u, 'estimated arrival {1}'],
    [/^(.+), ([\d.,]+) mil semillas$/u, '{1}, {2} thousand seeds'],
    [/^([\d.,]+) mil semillas$/u, '{1} thousand seeds'],
    [/^Reporte semanal · (.+?): (.+)$/u, 'Weekly report · {1}: {2}'],
    [/^Reporte semanal · (.+)$/u, 'Weekly report · {1}'],
    [/^(\d+) completadas$/u, '{1} completed'],
    [/^(\d+) en progreso$/u, '{1} in progress'],
    [/^(\d+) retrasadas$/u, '{1} delayed'],
    [/^(\d+) sin éxito$/u, '{1} unsuccessful'],
    [/^Hola, (.+): entrega hoy tu reporte semanal \(menú › Reporte semanal\)\. Desde el lunes la app lo pide antes de seguir\.$/u, 'Hi, {1}: submit your weekly report today (menu › Weekly report). From Monday the app asks for it before you can continue.'],
    [/^Semana (\d+) del equipo$/u, 'Team week {1}'],
    [/^(\d+) de (\d+) reportes$/u, '{1} of {2} reports'],
    [/^Resumen del equipo de la semana (\d+): (.+)$/u, 'Team summary for week {1}: {2}'],
    [/^Nuevo mensaje: (.+)$/u, 'New message: {1}'],
    [/^Instagram · (.+?): (.+)$/u, 'Instagram · {1}: {2}'],
    [/^(.+) pasó a Reunión$/u, '{1} moved to Meeting'],
    [/^Expediente: (.+)$/u, 'File: {1}'],
    [/^Carpeta en Drive: (.+)$/u, 'Drive folder: {1}'],
    [/^Tu primer hueco libre: (.+)\.$/u, 'Your first free slot: {1}.'],
    [/^(.+) fijó tu meta de (.+): (.+) = (.+)$/u, '{1} set your goal for {2}: {3} = {4}'],
    [/^Te asignó un cliente nuevo que llegó por Instagram \((.+?)\): (.+)$/u, 'Assigned you a new client who came in through Instagram ({1}): {2}'],

    // Resumen de la mañana
    [/^Buenos días, (.+?)\. Soy Borja, tu resumen de hoy(?: \((.+?)\))?(?:: (.+)|(\.))?$/u, (n, alcance, resto, punto) => `Good morning, ${n}. I’m Borja, here’s your summary for today${alcance ? ` (${alcance})` : ''}${resto ? `: ${resto}` : punto}`],
    [/^Tu resumen de hoy \((.+)\) · Semences del Caribe$/u, 'Your summary for today ({1}) · Semences del Caribe'],
    [/^Tu alcance: (.+)\.$/u, 'Your scope: {1}.'],
    [/^• (.+)$/u, '• {1}'],
    [/^(.+) \(hoy\)$/u, '{1} (today)'],
    [/^(.+) \(atrasado desde el (.+)\)$/u, '{1} (overdue since {2})'],
    [/^(.+) \(vence hoy(, prioridad alta)?\)$/u, (t, alta) => `${t} (due today${alta ? ', high priority' : ''})`],
    [/^(.+) \(vencida desde el (.+?)(, prioridad alta)?\)$/u, (t, f, alta) => `${t} (overdue since ${f}${alta ? ', high priority' : ''})`],
    [/^(.+) \(termina hoy\)$/u, '{1} (ends today)'],
    [/^(.+) \(empieza hoy\)$/u, '{1} (starts today)'],
    [/^Lote (.+?): trasplante hoy$/u, 'Batch {1}: transplant today'],
    [/^(.+): trasplante hoy$/u, '{1}: transplant today'],
    [/^(.+): trasplante atrasado desde el (.+)$/u, '{1}: transplant overdue since {2}'],
    [/^(.+): germinación baja \((.+) %\)$/u, '{1}: low germination ({2}%)'],
    [/^Lote (.+)$/u, 'Batch {1}'],
    [/^(.+): (.+?) \(llegada hoy\)$/u, '{1}: {2} (arriving today)'],
    [/^(.+): (.+?) \(llegada estimada (.+)\)$/u, '{1}: {2} (estimated arrival {3})'],
    [/^(\d+) mensajes? sin leer$/u, (n) => `${n} unread message${plural(n, '', 's')}`],
    [/^(\d+) seguimientos? de clientes atrasados?$/u, (n) => `${n} overdue client follow-up${plural(n, '', 's')}`],
    [/^(\d+) tareas? vencidas? en el equipo$/u, (n) => `${n} overdue task${plural(n, '', 's')} on the team`],
    [/^(\d+) procesos? agronómicos? hoy$/u, (n) => `${n} crop process${plural(n, '', 'es')} today`],
    [/^(\d+) clientes? sin asignar$/u, (n) => `${n} unassigned client${plural(n, '', 's')}`],
    [/^(\d+) lotes? del germinador con germinación baja$/u, (n) => `${n} germination batch${plural(n, '', 'es')} with low germination`],
    [/^y (\d+) (eventos|clientes|tareas|procesos|lotes|envíos) más$/u, (n, que) => `and ${n} more ${{ eventos: 'events', clientes: 'clients', tareas: 'tasks', procesos: 'processes', lotes: 'batches', envíos: 'shipments' }[que]}`],
];

// Generales: solo si no sirvió nada de lo anterior ni partir por « · » o «; »
const GENERALES = [
    [/^(.+?): (.+)$/u, '{1}: {2}'],
    [/^(.+) \((.+)\)$/u, '{1} ({2})']
];

const SEPARADORES = [' · ', '; '];

function conPatrones(lista, texto, profundidad) {
    for (const [re, plantilla] of lista) {
        const r = re.exec(texto);
        if (!r) continue;
        const datos = r.slice(1).map(d => (d === undefined ? '' : linea(d, profundidad + 1) ?? d));
        const en = typeof plantilla === 'function' ? plantilla(...datos) : plantilla.replace(/\{(\d)\}/g, (_, n) => datos[Number(n) - 1] || '');
        if (en !== texto) return en;
    }
    return undefined;
}

// Una línea: entera, sin el símbolo de delante, por patrones, por trozos o por los generales; undefined si nada cambia
function linea(texto, profundidad = 0) {
    if (!texto || profundidad > 6) return undefined;
    const exacto = EXACTOS.get(texto);
    if (exacto !== undefined) return exacto;
    const simbolo = /^(\p{Extended_Pictographic}\uFE0F?\s+)(.+)$/u.exec(texto);
    if (simbolo) {
        const en = linea(simbolo[2], profundidad + 1);
        return en === undefined ? undefined : simbolo[1] + en;
    }
    const en = conPatrones(PATRONES, texto, profundidad);
    if (en !== undefined) return en;
    for (const sep of SEPARADORES) {
        if (!texto.includes(sep)) continue;
        const trozos = texto.split(sep);
        const traducidos = trozos.map(t => linea(t, profundidad + 1) ?? t);
        if (traducidos.some((t, i) => t !== trozos[i])) return traducidos.join(sep);
    }
    return conPatrones(GENERALES, texto, profundidad);
}

// El texto en el idioma de quien lo recibe (línea a línea); en español, tal cual
export function traducir(texto, idioma) {
    if (idioma !== 'en' || typeof texto !== 'string' || !texto) return texto;
    return texto.split('\n').map(l => linea(l) ?? l).join('\n');
}

// Idioma de cada persona: Map(id → 'es' | 'en')
export async function idiomasDe(pool, usuarioIds) {
    const ids = [...new Set(usuarioIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const [filas] = await pool.query('SELECT id, idioma FROM usuarios WHERE id IN (?)', [ids]);
    return new Map(filas.map(f => [f.id, f.idioma === 'en' ? 'en' : 'es']));
}

// Idioma de un destino de la cola: la huella de un dispositivo (push) o un teléfono (WhatsApp)
export async function idiomaDestino(pool, canal, destino) {
    const [filas] = canal === 'push'
        ? await pool.query('SELECT u.idioma FROM push_suscripciones p JOIN usuarios u ON u.id = p.usuario_id WHERE p.huella = ? LIMIT 1', [destino])
        : await pool.query('SELECT idioma FROM usuarios WHERE telefono = ? LIMIT 1', [destino]);
    return filas[0] && filas[0].idioma === 'en' ? 'en' : 'es';
}

export async function idiomaCorreo(pool, correo) {
    const [filas] = await pool.query('SELECT idioma FROM usuarios WHERE email = ? LIMIT 1', [String(correo).toLowerCase()]);
    return filas[0] && filas[0].idioma === 'en' ? 'en' : 'es';
}
