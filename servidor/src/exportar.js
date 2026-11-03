/**
 * Exportación del CRM a Google Sheets: una pestaña por módulo, con cabeceras en español.
 * Las columnas conocidas van primero y en orden; los campos nuevos que vaya teniendo la app se añaden
 * al final con su nombre. No se exportan los campos internos (los que empiezan por "_" ni clienteId).
 */
export const PESTANAS = [
    ['clientes', 'Clientes', { nombre: 'Nombre', correo: 'Correo', telefono: 'Teléfono', whatsapp: 'WhatsApp', ubicacion: 'Ubicación', marca: 'Marca', etapa: 'Etapa', seguimiento: 'Próximo seguimiento', proximaReunion: 'Próxima reunión', reunionMeet: 'Enlace de Meet', pais: 'País', casa: 'Casa comercial', asignadoNombre: 'Asignado a' }],
    ['visitas', 'Visitas', { fecha: 'Fecha', cliente: 'Cliente', ubicacion: 'Ubicación', estado: 'Estado del cultivo', comentarios: 'Comentarios' }],
    ['agronomia', 'Procesos agronómicos', { cliente: 'Cliente', lote: 'Lote', variedad: 'Variedad', proceso: 'Fase', fechaInicio: 'Inicio', fechaFin: 'Fin', germinacion: 'Germinación (%)', comentarios: 'Comentarios' }],
    ['rendimiento', 'Rendimiento', { cliente: 'Cliente', lote: 'Lote', fecha: 'Fecha', rendimientoPlanta: 'Rendimiento por planta', canastos: 'Canastos', unidades: 'Unidades', detalles: 'Detalles' }],
    ['germinador', 'Germinador', { lote: 'Lote', cliente: 'Cliente', variedad: 'Variedad', estado: 'Estado', siembra: 'Siembra', trasplante: 'Trasplante previsto', bandejas: 'Bandejas', semillasMiles: 'Semillas (miles)', germinacion: 'Germinación (%)', temperatura: 'Temperatura (°C)', humedad: 'Humedad (%)', comentarios: 'Comentarios', pais: 'País', casa: 'Casa comercial' }],
    ['envios', 'Envíos', { guia: 'Guía', transportista: 'Transportista', cliente: 'Cliente', estado: 'Estado', ubicacion: 'Ubicación', eta: 'Llegada estimada', contenido: 'Contenido', semillasMiles: 'Semillas (miles)', detalle: 'Detalle del transportista', rastreado: 'Último rastreo', pais: 'País', casa: 'Casa comercial' }],
    ['pedidos', 'Pedidos', { fecha: 'Fecha', cliente: 'Cliente', variedad: 'Variedad', semillasMiles: 'Semillas (miles)', precioMil: 'Precio por mil', estado: 'Estado', notas: 'Notas', pais: 'País', casa: 'Casa comercial' }],
    ['tareas', 'Tareas', { titulo: 'Tarea', prioridad: 'Prioridad', vence: 'Vence', para: 'Para', creadaPor: 'Creada por', creada: 'Creada', hecha: 'Hecha', hechaPor: 'Hecha por' }],
    ['reuniones', 'Reuniones', { titulo: 'Reunión', inicio: 'Inicio', organizadorNombre: 'Organiza', participantesTexto: 'Participantes', meet: 'Meet', temas: 'Temas', acuerdosTexto: 'Acuerdos' }]
];

const COMUNES = { responsable: 'Registró', cuenta: 'Cuenta', id: 'Id' };
const OCULTOS = (clave) => clave.startsWith('_') || clave === 'clienteId';

// Filas (cabecera + registros) de un módulo
export function filasDe(registros, etiquetas) {
    const conocidas = { ...etiquetas, ...COMUNES };
    const extra = new Set();
    // Object.hasOwn: un campo que se llame como algo de Object ("constructor", "toString") también se exporta
    for (const r of registros) for (const clave of Object.keys(r)) if (!Object.hasOwn(conocidas, clave) && !OCULTOS(clave)) extra.add(clave);
    const claves = [...Object.keys(etiquetas), ...[...extra].sort(), 'responsable', 'cuenta', 'id'];
    const cabecera = claves.map(c => (Object.hasOwn(conocidas, c) ? conocidas[c] : c));
    const filas = registros.map(r => claves.map(c => {
        const v = r[c];
        if (v === undefined || v === null) return '';
        return typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 5000);
    }));
    return [cabecera, ...filas];
}

export function pestanasDe(datos) {
    return PESTANAS.map(([modulo, nombre, etiquetas]) => ({ nombre, filas: filasDe(datos[modulo] || [], etiquetas) }));
}
