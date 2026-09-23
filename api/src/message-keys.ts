export interface MessageTemplate {
  key: string;
  category: string;
  variants: string[];
}

export const MESSAGE_TEMPLATES: Record<string, string[]> = {
  // Apertura Agente 1 (Nodo 0)
  apertura: [
    "Hola 👋 Soy del equipo de Fernández Briceño Studio. Antes de coordinar una llamada, quiero entender rápido qué necesita tu marca — son solo 4 preguntas.",
    "¡Hola! Acá el equipo de FBS. Para no hacerte perder tiempo, te hago 4 preguntas cortas y vemos si encajamos bien con lo que necesitas."
  ],

  // Banco de acuses breves (para rotar entre turnos)
  acuse: [
    "Ya, tiene sentido.",
    "Perfecto, eso ayuda a entender el panorama.",
    "Ok, anotado.",
    "Entiendo — pasa más de lo que crees.",
    "Buena info, gracias.",
    "Ah, ok, ahora se entiende mejor."
  ],

  // Preguntas Agente 1
  pregunta_p1: [
    "Para partir: ¿qué necesitas trabajar en este momento — marca desde cero, rebranding, identidad visual, arquitectura de marca, brand book, naming, o marca + espacio físico? Si no estás seguro, también vale decirlo."
  ],
  pregunta_p2: [
    "Cuéntame un poco de tu negocio — a qué se dedican y cuál es el problema principal que te gustaría resolver con este proyecto. Puedes escribirlo o mandarlo por audio, como te acomode."
  ],
  pregunta_p3_autoridad: [
    "¿Quién toma la decisión final sobre este proyecto — tú, tú con socios, o alguien más tiene que aprobarlo?"
  ],
  pregunta_p3_inversion: [
    "Para orientarte bien: nuestros proyectos de marca parten desde {PISO_INVERSION}. ¿Ese rango te hace sentido para lo que estás pensando?"
  ],
  pregunta_p4: [
    "Si vemos que hay buen encaje, ¿podrías coordinar una videollamada con el equipo — esta semana, en las próximas dos, o prefieres info y precios primero?"
  ],

  // Salidas y Gates
  gate_sin_decisor: [
    "Gracias por contarme todo esto. Como el proyecto todavía no tiene quién lo apruebe del todo, prefiero que lo retomemos cuando eso esté más claro — así no te hago perder una llamada antes de tiempo. Quedo atento si eso cambia."
  ],
  gate_sin_presupuesto: [
    "Entiendo, gracias por la honestidad. Por ahora el rango que manejamos no calza con lo que tienes contemplado — prefiero decírtelo directo en vez de agendarte algo que no tiene sentido todavía. Si eso cambia más adelante, aquí estamos."
  ],
  hard_stop_rechazo: [
    "Gracias por la claridad. Nuestro proceso siempre parte con estrategia propia, no replicamos marcas de otros — no creo que seamos el estudio indicado para lo que buscas, pero espero que encuentres a alguien que se ajuste a lo que necesitas."
  ],
  nurture_score_bajo: [
    "Gracias por responder todo esto. Por ahora parece que estás en una etapa más de explorar que de decidir, y está bien — vamos a guardar tu info y te escribimos cuando tenga más sentido retomarlo. Si en el camino algo cambia, también puedes escribirnos tú."
  ],
  qualified_resumen: [
    "¡Genial! Con esto ya tenemos toda la información clave para coordinar la videollamada. Te paso de inmediato con el área de coordinación para agendar la fecha."
  ],

  // Reenganche y contingencias
  reenganche_partial: [
    "Hola de nuevo — quedamos a la mitad la última vez. ¿Seguimos donde lo dejamos? Sin apuro si no es buen momento, me avisas."
  ],
  audio_falla_transcripcion: [
    "Me llegó tu audio pero no logré escucharlo bien esta vez — ¿me lo puedes resumir en texto, o lo intentamos de nuevo?"
  ],

  // Agente 2 (Agenda)
  agente_2_apertura: [
    "¡Hola! Vi que ya conversaste con el equipo sobre {servicio_declarado} — vamos a coordinar esa llamada. Te dejo el enlace para que elijas el horario que más te acomode: {link_calendario}"
  ],
  confirmacion_cita_formulario: [
    "Quedamos coordinados entonces. Te dejo este formulario corto (5 min) para que la llamada la aprovechemos hablando de tu proyecto y no de preguntas básicas: {link_formulario}"
  ]
};

export function getMessage(key: string, replacements: Record<string, string> = {}): string {
  const list = MESSAGE_TEMPLATES[key];
  if (!list || list.length === 0) {
    return "";
  }
  const index = Math.floor(Math.random() * list.length);
  let text = list[index];
  for (const [k, v] of Object.entries(replacements)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return text;
}
