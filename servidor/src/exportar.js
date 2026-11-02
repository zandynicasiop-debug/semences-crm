/**
 * Exportación del CRM a Google Sheets: una pestaña por módulo, con cabeceras en español.
 * Las columnas conocidas van primero y en orden; los campos nuevos que vaya teniendo la app se añaden
 * al final con su nombre. No se exportan los campos internos (los que empiezan por "_" ni clienteId).
 */
export const PESTANAS = [
    ['clientes', 'Clientes', { nombre: 'Nombre', correo: 'Correo', telefono: 'Teléfono', whatsapp: 'WhatsApp', ubicacion: 'Ubicación', marca: 'Marca', seguimiento: 'Próximo seguimiento' }],
    ['visitas', 'Visitas', { fecha: 'Fecha', cliente: 'Cliente', ubicacion: 'Ubicación', estado: 'Estado del cultivo', comentarios: 'Comentarios' }],
    ['agronomia', 'Procesos agronómicos', { cliente: 'Cliente', lote: 'Lote', variedad: 'Variedad', proceso: 'Fase', fechaInicio: 'Inicio', fechaFin: 'Fin', germinacion: 'Germinación (%)', comentarios: 'Comentarios' }],
    ['rendimiento', 'Rendimiento', { cliente: 'Cliente', lote: 'Lote', fecha: 'Fecha', rendimientoPlanta: 'Rendimiento por planta', canastos: 'Canastos', unidades: 'Unidades', detalles: 'Detalles' }],
    ['tareas', 'Tareas', { titulo: 'Tarea', prioridad: 'Prioridad', vence: 'Vence', para: 'Para', creadaPor: 'Creada por', creada: 'Creada', hecha: 'Hecha', hechaPor: 'Hecha por' }]
];

const COMUNES = { responsable: 'Registró', cuenta: 'Cuenta', id: 'Id' };
const OCULTOS = (clave) => clave.startsWith('_') || clave === 'clienteId';

// Filas (cabecera + registros) de un módulo
export function filasDe(registros, etiquetas) {
    const conocidas = { ...etiquetas, ...COMUNES };
    const extra = new Set();
    for (const r of registros) for (const clave of Object.keys(r)) if (!conocidas[clave] && !OCULTOS(clave)) extra.add(clave);
    const claves = [...Object.keys(etiquetas), ...[...extra].sort(), 'responsable', 'cuenta', 'id'];
    const cabecera = claves.map(c => conocidas[c] || c);
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
