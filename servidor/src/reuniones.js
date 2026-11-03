/**
 * Reuniones del equipo (módulo "reuniones" del CRM, visible para todo el equipo como las tareas).
 *
 * - Crear: evento en el Google Calendar de quien la organiza, con Meet e invitación por correo a los
 *   participantes (personas del equipo). Se guarda en el CRM y a cada participante le llega el aviso
 *   (campana, push y WhatsApp) con el enlace de Meet. Sale en la agenda de la app.
 * - Acta: temas tratados y acuerdos; cada acuerdo con responsable se convierte en una tarea a su
 *   nombre (con fecha si la tiene) y se le avisa. La escribe quien organiza, un participante o un Master.
 */
import crypto from 'node:crypto';
import * as db from './db.js';
import { conGoogle } from './llamadasGoogle.js';
import { quienDe } from './auditoria.js';

const textoParticipantes = (lista) => lista.map(p => p.nombre || p.email).join(', ');

export async function accionReunion(datos, contexto, { errorApp, enviarDirecto, personaDelEquipo, horaLocal }) {
    const { pool, config, usuario, ambito } = contexto;
    const yo = usuario.nombre || usuario.email;

    if (datos.operacion === 'crear') {
        const titulo = String(datos.titulo || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!titulo) throw errorApp('Escribe el motivo de la reunión');
        const inicio = new Date(datos.inicio);
        const fin = datos.fin ? new Date(datos.fin) : new Date(inicio.getTime() + config.minutosReunion * 60000);
        if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || fin <= inicio) throw errorApp('Revisa la fecha y la hora de la reunión');
        const correos = [...new Set([].concat(datos.participantes || []).map(c => String(c).trim().toLowerCase()).filter(c => c && c !== usuario.email))].slice(0, 30);
        if (!correos.length) throw errorApp('Elige al menos una persona del equipo');
        const personas = [];
        for (const correo of correos) personas.push(await personaDelEquipo(contexto, correo));
        const descripcion = String(datos.descripcion || '').trim().slice(0, 2000);
        const evento = await conGoogle(contexto, (token, alRenovar) => contexto.google.crearEvento(token, alRenovar, {
            summary: `${titulo} · Semences del Caribe`,
            description: descripcion,
            start: { dateTime: inicio.toISOString(), timeZone: config.zonaHoraria },
            end: { dateTime: fin.toISOString(), timeZone: config.zonaHoraria },
            attendees: personas.map(p => ({ email: p.email })),
            conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        }, true));
        const participantes = personas.map(p => ({ email: p.email, nombre: p.nombre || p.email }));
        const registro = {
            id: `re-${crypto.randomUUID()}`, titulo, descripcion,
            inicio: inicio.toISOString(), fin: fin.toISOString(),
            organizador: usuario.email, organizadorNombre: yo,
            participantes, participantesTexto: textoParticipantes(participantes),
            meet: evento.meet || '', enlace: evento.enlace || '', eventoId: evento.id || '',
            temas: '', acuerdos: [], acuerdosTexto: '', acta: false,
            creado: new Date().toISOString(), responsable: yo, cuenta: usuario.email, creadoPor: usuario.email
        };
        await db.guardarRegistro(pool, 'reuniones', registro, usuario.id, quienDe(contexto));
        for (const p of personas) {
            await enviarDirecto(contexto, p, 'reunion', `Te invita a la reunión "${titulo}" el ${horaLocal(inicio, config)}`, registro.meet);
        }
        return { ok: true, reunion: registro };
    }

    if (datos.operacion === 'acta') {
        const reunion = await db.leerRegistro(pool, 'reuniones', String(datos.id || ''));
        if (!reunion) throw errorApp('Esa reunión no existe', 404);
        const participa = reunion.organizador === usuario.email || (reunion.participantes || []).some(p => p.email === usuario.email);
        if (!participa && !ambito.master) throw errorApp('El acta la escribe quien organiza la reunión o quien participa en ella', 403, 'permiso');
        const temas = String(datos.temas || '').trim().slice(0, 4000);
        const lista = Array.isArray(datos.acuerdos) ? datos.acuerdos.slice(0, 40) : [];
        if (!temas && !lista.length) throw errorApp('Escribe los temas tratados o al menos un acuerdo');
        const ahora = new Date().toISOString();
        const acuerdos = [];
        for (const a of lista) {
            const texto = String(a.texto || '').trim().replace(/\s+/g, ' ').slice(0, 300);
            if (!texto) continue;
            const vence = /^\d{4}-\d{2}-\d{2}$/.test(String(a.vence || '')) ? a.vence : '';
            const acuerdo = { texto, vence, responsable: '', responsableNombre: '', tareaId: '' };
            if (a.responsable) {
                const persona = String(a.responsable).toLowerCase() === usuario.email ? usuario : await personaDelEquipo(contexto, a.responsable);
                acuerdo.responsable = persona.email;
                acuerdo.responsableNombre = persona.nombre || persona.email;
                // Ya era una tarea (acta corregida): se actualiza la misma, no se duplica
                const anterior = (reunion.acuerdos || []).find(x => x.texto === texto && x.responsable === persona.email && x.tareaId);
                const existente = anterior ? await db.leerRegistro(pool, 'tareas', anterior.tareaId) : null;
                const tarea = existente || {
                    id: `ra-${crypto.randomUUID()}`, prioridad: 'Media', creada: ahora, hecha: '', hechaPor: '',
                    creadaPor: yo, reunionId: reunion.id, creadoPor: usuario.email
                };
                Object.assign(tarea, { titulo: texto, vence, para: acuerdo.responsableNombre, cuenta: usuario.email });
                await db.guardarRegistro(pool, 'tareas', tarea, usuario.id, quienDe(contexto));
                acuerdo.tareaId = tarea.id;
                if (!existente && persona.id !== usuario.id) {
                    await enviarDirecto(contexto, persona, 'tarea', `Acuerdo de la reunión "${reunion.titulo}": ${texto}${vence ? ` (para el ${vence})` : ''}`, '');
                }
            }
            acuerdos.push(acuerdo);
        }
        const actualizada = {
            ...reunion, temas, acuerdos, acta: true, actaPor: yo, actaEn: ahora, cuenta: usuario.email,
            acuerdosTexto: acuerdos.map(a => `${a.texto}${a.responsableNombre ? ` (${a.responsableNombre}${a.vence ? `, ${a.vence}` : ''})` : ''}`).join(' · ')
        };
        await db.guardarRegistro(pool, 'reuniones', actualizada, usuario.id, quienDe(contexto));
        return { ok: true, reunion: actualizada };
    }

    throw errorApp('Operación desconocida de reuniones');
}
