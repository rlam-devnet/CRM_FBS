import { FastifyPluginAsync } from 'fastify';
import { query, getClient } from '../db.js';

interface CreateLeadBody {
  phone?: string;
  telegram_id?: string;
  channel?: string;
  first_name?: string;
  last_name?: string;
  utm_source_ref?: string;
}

interface UpdateEntryClassBody {
  entry_class: string;
  actor?: string;
  reason?: string;
}

interface UpdateStateBody {
  to_state: string;
  actor: string;
  reason?: string;
}
interface BufferMessageBody {
  chat_id: string | number;
  telegram_id?: string | number;
  first_name?: string;
  last_name?: string;
  text: string;
  message_id?: string | number;
}

interface ChatBuffer {
  chat_id: string;
  telegram_id: string;
  first_name: string;
  last_name: string;
  texts: string[];
  timer: NodeJS.Timeout;
}

const activeBuffers = new Map<string, ChatBuffer>();

async function sendTelegramTyping(chatId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {}
}
async function sendSingleTelegramMessage(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {}
}


async function flushBuffer(chatId: string) {
  const buf = activeBuffers.get(chatId);
  if (!buf) return;
  activeBuffers.delete(chatId);

  const combinedText = buf.texts.join('\n').trim();
  if (!combinedText) return;

  console.log(`[DEBOUNCE FLUSH] chatId=${chatId}, combined ${buf.texts.length} messages: "${combinedText}"`);
  // Grabar mensaje del usuario en memoria conversacional persistente
  try {
    const leadRows = await query('SELECT id FROM leads WHERE telegram_id = $1 LIMIT 1', [buf.telegram_id]);
    const leadId = leadRows[0]?.id || null;
    await query(
      'INSERT INTO chat_messages (chat_id, lead_id, role, content) VALUES ($1, $2, $3, $4)',
      [buf.chat_id, leadId, 'user', combinedText]
    );
  } catch (err) {
    console.error('[CHAT RECORD ERROR (user)]', err);
  }


  try {
    const n8nUrl = process.env.N8N_INTERNAL_URL || 'http://n8n:5678';
    await fetch(`${n8nUrl}/webhook/fbs-process-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: buf.chat_id,
        telegram_id: buf.telegram_id,
        first_name: buf.first_name,
        last_name: buf.last_name,
        text: combinedText,
      }),
    });
  } catch (err) {
    console.error(`[DEBOUNCE ERROR] Failed to dispatch combined message to n8n:`, err);
  }
}


export const leadsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /leads - Deduplicate or create
  fastify.post<{ Body: CreateLeadBody }>('/leads', async (request, reply) => {
    const { phone, telegram_id, channel = 'telegram', first_name, last_name, utm_source_ref } = request.body || {};

    if (!phone && !telegram_id) {
      return reply.status(400).send({ error: 'Debe suministrarse phone o telegram_id' });
    }

    // Buscar si ya existe por telegram_id o phone
    let existingRows: Record<string, unknown>[] = [];
    if (telegram_id) {
      existingRows = await query('SELECT * FROM leads WHERE telegram_id = $1 LIMIT 1', [telegram_id]);
    } else if (phone) {
      existingRows = await query('SELECT * FROM leads WHERE phone = $1 LIMIT 1', [phone]);
    }

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      return reply.status(200).send({
        lead_id: existing.id,
        current_state: existing.current_state,
        is_new: false,
        dedupe_master_id: existing.dedupe_master_id || existing.id,
      });
    }

    // Crear nuevo lead
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_actor', $1, true)", ['api_router']);
      await client.query("SELECT set_config('app.current_reason', $1, true)", ['Registro inicial de lead']);

      const insertRes = await client.query(
        `INSERT INTO leads (phone, telegram_id, channel, first_name, last_name, utm_source_ref, current_state)
         VALUES ($1, $2, $3, $4, $5, $6, 'NEW_LEAD')
         RETURNING id, current_state`,
        [phone || null, telegram_id || null, channel, first_name || null, last_name || null, utm_source_ref || null]
      );
      await client.query('COMMIT');

      const created = insertRes.rows[0];
      return reply.status(201).send({
        lead_id: created.id,
        current_state: created.current_state,
        is_new: true,
        dedupe_master_id: null,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // PATCH /leads/:id/entry-class
  fastify.patch<{ Params: { id: string }; Body: UpdateEntryClassBody }>('/leads/:id/entry-class', async (request, reply) => {
    const { id } = request.params;
    const { entry_class, actor = 'nodo_0', reason = 'Clasificación de entrada' } = request.body;

    const leadRows = await query('SELECT current_state FROM leads WHERE id = $1', [id]);
    if (leadRows.length === 0) {
      return reply.status(404).send({ error: 'Lead no encontrado' });
    }

    let targetState: string | null = null;
    if (entry_class === 'OUT_OF_SCOPE') {
      targetState = 'OUT_OF_SCOPE';
    } else if (entry_class === 'SPAM') {
      targetState = 'SPAM';
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
      await client.query("SELECT set_config('app.current_reason', $1, true)", [reason]);

      if (targetState) {
        await client.query(
          'UPDATE leads SET entry_class = $1, current_state = $2, updated_at = NOW() WHERE id = $3',
          [entry_class, targetState, id]
        );
      } else {
        await client.query(
          'UPDATE leads SET entry_class = $1, updated_at = NOW() WHERE id = $2',
          [entry_class, id]
        );
      }
      await client.query('COMMIT');

      return reply.send({ lead_id: id, entry_class, current_state: targetState || leadRows[0].current_state });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('INVALID_TRANSITION')) {
        return reply.status(409).send({ error: 'INVALID_TRANSITION', details: msg });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // PATCH /leads/:id/state
  fastify.patch<{ Params: { id: string }; Body: UpdateStateBody }>('/leads/:id/state', async (request, reply) => {
    const { id } = request.params;
    const { to_state, actor, reason } = request.body;

    if (!to_state || !actor) {
      return reply.status(400).send({ error: 'to_state y actor son obligatorios' });
    }

    const leadRows = await query('SELECT current_state FROM leads WHERE id = $1', [id]);
    if (leadRows.length === 0) {
      return reply.status(404).send({ error: 'Lead no encontrado' });
    }
    const from_state = leadRows[0].current_state as string;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
      await client.query("SELECT set_config('app.current_reason', $1, true)", [reason || 'Transición solicitada']);

      await client.query(
        'UPDATE leads SET current_state = $1, updated_at = NOW() WHERE id = $2',
        [to_state, id]
      );
      await client.query('COMMIT');

      return reply.send({ lead_id: id, from_state, to_state, actor });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('INVALID_TRANSITION')) {
        return reply.status(409).send({
          error: 'INVALID_TRANSITION',
          from: from_state,
          to: to_state,
          message: msg
        });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /leads/:id - Full snapshot for Agent 2 / Closer
  fastify.get<{ Params: { id: string } }>('/leads/:id', async (request, reply) => {
    const { id } = request.params;

    const leadRows = await query('SELECT * FROM leads WHERE id = $1', [id]);
    if (leadRows.length === 0) {
      return reply.status(404).send({ error: 'Lead no encontrado' });
    }

    const qualificationRows = await query('SELECT * FROM lead_qualification WHERE lead_id = $1', [id]);
    const precallRows = await query('SELECT * FROM precall_forms WHERE lead_id = $1 ORDER BY submitted_at DESC LIMIT 1', [id]);
    const consultationRows = await query('SELECT * FROM consultations WHERE lead_id = $1 ORDER BY scheduled_at DESC', [id]);
    const transitionRows = await query(
      'SELECT from_state, to_state, actor, reason, created_at FROM state_transitions WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10',
      [id]
    );
    const chatHistoryRows = await query(
      'SELECT role, content, created_at FROM chat_messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT 20',
      [id]
    );
    return reply.send({
      lead: leadRows[0],
      qualification: qualificationRows[0] || null,
      precall_form: precallRows[0] || null,
      consultations: consultationRows,
      recent_transitions: transitionRows,
      chat_history: chatHistoryRows,
    });
  });

async function syncToTwentyCRM(leadId: string) {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiUrl || !apiKey) return null;

  try {
    const leadRows = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
    if (leadRows.length === 0) return null;
    const lead = leadRows[0];

    if (lead.twenty_person_id) return lead.twenty_person_id;

    let companyId: string | null = null;
    if (lead.company_name && lead.company_name.trim().length > 0) {
      const compRes = await fetch(`${apiUrl}/rest/companies`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: lead.company_name.trim() })
      });
      if (compRes.ok) {
        const compData = (await compRes.json()) as { data?: { createCompany?: { id: string } } };
        companyId = compData.data?.createCompany?.id || null;
      }
    }

    const personPayload: Record<string, unknown> = {
      name: {
        firstName: lead.first_name || 'Prospecto',
        lastName: lead.last_name || ''
      }
    };
    if (lead.email) personPayload.emails = { primaryEmail: lead.email };
    if (lead.phone) personPayload.phones = { primaryPhoneNumber: lead.phone };
    if (companyId) personPayload.companyId = companyId;

    let personId: string | null = null;
    if (lead.email) {
      const searchRes = await fetch(`${apiUrl}/rest/people?filter[emails.primaryEmail][eq]=${encodeURIComponent(lead.email)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as { data?: { people?: Array<{ id: string }> } };
        if (searchData.data?.people && searchData.data.people.length > 0) {
          personId = searchData.data.people[0].id;
        }
      }
    }

    if (!personId) {
      const personRes = await fetch(`${apiUrl}/rest/people`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(personPayload)
      });
      if (personRes.ok) {
        const personData = (await personRes.json()) as { data?: { createPerson?: { id: string } } };
        personId = personData.data?.createPerson?.id || null;
      }
    }
    let oppId: string | null = null;
    const oppName = `Branding - ${lead.company_name || lead.first_name || 'Nuevo Prospecto'}`;
    const oppPayload: Record<string, unknown> = {
      name: oppName,
      amount: { amountMicros: 1200000000000, currencyCode: 'CLP' },
      stage: 'MEETING'
    };
    if (companyId) oppPayload.companyId = companyId;
    if (personId) oppPayload.pointOfContactId = personId;

    const oppRes = await fetch(`${apiUrl}/rest/opportunities`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(oppPayload)
    });
    if (oppRes.ok) {
      const oppData = (await oppRes.json()) as { data?: { createOpportunity?: { id: string } } };
      oppId = oppData.data?.createOpportunity?.id || null;
    }
    await query(
      'UPDATE leads SET twenty_person_id = $1, twenty_opportunity_id = $2 WHERE id = $3',
      [personId, oppId, leadId]
    );
    // 4. Crear Nota Ejecutiva en Twenty con el Briefing de Calificación
    const qualRows = await query('SELECT * FROM lead_qualification WHERE lead_id = $1', [leadId]);
    const qual = (qualRows[0] || {}) as Record<string, unknown>;

    if (oppId || personId) {
      const noteMarkdown = `### Briefing Ejecutivo de Calificación (FBS Studio)
* **Servicio:** ${qual.service_needed || 'Branding integral'}
* **Empresa:** ${lead.company_name || 'Agencia'}
* **Desafío Comercial:** ${qual.business_problem || 'Consolidación de marca'}
* **Decisión:** ${qual.decision_authority || 'Socio / Fundador'}
* **Piso de Inversión:** Aprobado ($1.200.000 CLP)
* **Score Calificación:** ${qual.score_total || 8} / 8 pts
* **Agenda Cal.com:** https://cal.com/fbs-studio/consulta-30min?lead_id=${leadId}
* **Formulario Pre-Llamada:** https://fbs.studio/precall/${leadId}`;

      const noteRes = await fetch(`${apiUrl}/rest/notes`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Briefing Estratégico — ${lead.company_name || lead.first_name || 'Prospecto'}`,
          bodyV2: { markdown: noteMarkdown }
        })
      });

      if (noteRes.ok) {
        const noteData = (await noteRes.json()) as { data?: { createNote?: { id: string } } };
        const noteId = noteData.data?.createNote?.id;
        if (noteId && oppId) {
          await fetch(`${apiUrl}/rest/noteTargets`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ noteId, targetOpportunityId: oppId })
          });
        }
      }

      // 5. Crear Tarea para el Closer vinculada al Trato
      if (oppId) {
        const taskRes = await fetch(`${apiUrl}/rest/tasks`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Revisar respuestas de formulario pre-llamada antes del Meet con ${lead.first_name || 'Cliente'}`,
            status: 'TODO',
            dueAt: new Date(Date.now() + 86400000 * 2).toISOString()
          })
        });
        if (taskRes.ok) {
          const taskData = (await taskRes.json()) as { data?: { createTask?: { id: string } } };
          const taskId = taskData.data?.createTask?.id;
          if (taskId) {
            await fetch(`${apiUrl}/rest/taskTargets`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId, targetOpportunityId: oppId })
            });
          }
        }
      }
    }


    console.log(`[TWENTY SYNC SUCCESS] lead=${leadId} -> person=${personId}, company=${companyId}, opportunity=${oppId}`);
    return { personId, companyId, oppId };
  } catch (err) {
    console.error('[TWENTY SYNC ERROR]', err);
    return null;
  }
}

  // PATCH /leads/:id/contact - Actualizar datos de contacto (email, phone, company_name)
  fastify.patch<{
    Params: { id: string };
    Body: {
      email?: string;
      phone?: string;
      company_name?: string;
      first_name?: string;
      last_name?: string;
    };
  }>('/leads/:id/contact', async (request, reply) => {
    const { id } = request.params;
    const { email, phone, company_name, first_name, last_name } = request.body || {};

    const leadRows = await query('SELECT * FROM leads WHERE id = $1', [id]);
    if (leadRows.length === 0) {
      return reply.status(404).send({ error: 'Lead no encontrado' });
    }

    const current = leadRows[0];
    const newEmail = email !== undefined ? email : current.email;
    const newPhone = phone !== undefined ? phone : current.phone;
    const newCompany = company_name !== undefined ? company_name : current.company_name;
    const newFirst = first_name !== undefined ? first_name : current.first_name;
    const newLast = last_name !== undefined ? last_name : current.last_name;

    await query(
      `UPDATE leads 
       SET email = $1, phone = $2, company_name = $3, first_name = $4, last_name = $5, updated_at = NOW(), last_interaction_at = NOW()
       WHERE id = $6`,
      [newEmail, newPhone, newCompany, newFirst, newLast, id]
    );
    syncToTwentyCRM(id).catch((err) => console.error('[SYNC TRIGGER ERROR]', err));


    return reply.send({
      lead_id: id,
      email: newEmail,
      phone: newPhone,
      company_name: newCompany,
      first_name: newFirst,
      last_name: newLast,
    });
  });

  // POST /webhook/dedupe - Idempotencia para webhooks de Telegram y WhatsApp
  fastify.post<{ Body: { message_id: string | number; channel?: string; payload?: unknown } }>(
    '/webhook/dedupe',
    async (request, reply) => {
      const { message_id, channel = 'telegram', payload = {} } = request.body || {};
      if (!message_id) {
        return reply.status(400).send({ error: 'message_id es requerido' });
      }

      const strId = String(message_id);
      const rows = await query(
        `INSERT INTO webhook_events (message_id, channel, payload, status)
         VALUES ($1, $2, $3, 'processed')
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [strId, channel, JSON.stringify(payload)]
      );

      const isDuplicate = rows.length === 0;
      return reply.send({
        message_id: strId,
        is_duplicate: isDuplicate
      });
    }
  );
  // POST /webhook/buffer - Buffers and debounces user messages by chat_id
  fastify.post<{ Body: BufferMessageBody }>('/webhook/buffer', async (request, reply) => {
    const { chat_id, telegram_id, first_name = '', last_name = '', text, message_id } = request.body || {};

    if (!chat_id || !text) {
      return reply.status(400).send({ error: 'chat_id y text son requeridos' });
    }

    const cId = String(chat_id);
    const tId = String(telegram_id || chat_id);

    if (message_id) {
      const rows = await query(
        `INSERT INTO webhook_events (message_id, channel, payload, status)
         VALUES ($1, 'telegram', $2, 'buffered')
         ON CONFLICT (message_id) DO NOTHING
         RETURNING message_id`,
        [String(message_id), JSON.stringify({ chat_id: cId, text })]
      );
      if (rows.length === 0) {
        return reply.send({ status: 'duplicate_ignored' });
      }
    }

    sendTelegramTyping(cId).catch(() => {});

    let buf = activeBuffers.get(cId);
    if (buf) {
      clearTimeout(buf.timer);
      buf.texts.push(text);
      if (first_name) buf.first_name = first_name;
      if (last_name) buf.last_name = last_name;
    } else {
      buf = {
        chat_id: cId,
        telegram_id: tId,
        first_name,
        last_name,
        texts: [text],
        timer: setTimeout(() => {}, 0),
      };
      activeBuffers.set(cId, buf);
    }

    const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '6500', 10);
    buf.timer = setTimeout(() => {
      sendTelegramTyping(cId).catch(() => {});
      flushBuffer(cId).catch(console.error);
    }, DEBOUNCE_MS);

    return reply.send({
      status: 'buffered',
      chat_id: cId,
      buffer_count: buf.texts.length,
      wait_ms: DEBOUNCE_MS,
    });
  });

  // POST /telegram/send-multi - Envía múltiples burbujas con indicador de escritura y pausas humanas
  fastify.post<{ Body: { chat_id: string | number; messages: string[] } }>(
    '/telegram/send-multi',
    async (request, reply) => {
      const { chat_id, messages } = request.body || {};
      if (!chat_id || !Array.isArray(messages) || messages.length === 0) {
        return reply.status(400).send({ error: 'chat_id y array messages requeridos' });
      }

      const cId = String(chat_id);

      // Ejecutar en background con pausas humanas entre burbujas
      (async () => {
        for (let i = 0; i < messages.length; i++) {
          const text = messages[i]?.trim();
          if (!text) continue;

          // Activar "escribiendo..." antes de cada burbuja
          await sendTelegramTyping(cId);

          // Pausa humana de lectura y digitación (1.2s a 2.5s según largo)
          const typingDelay = Math.min(Math.max(text.length * 30, 1200), 2500);
          await new Promise((r) => setTimeout(r, typingDelay));
          // Entregar burbuja en Telegram
          await sendSingleTelegramMessage(cId, text);
          // Grabar mensaje del bot en memoria conversacional persistente
          try {
            const leadRows = await query('SELECT id FROM leads WHERE telegram_id = $1 LIMIT 1', [cId]);
            const leadId = leadRows[0]?.id || null;
            await query(
              'INSERT INTO chat_messages (chat_id, lead_id, role, content) VALUES ($1, $2, $3, $4)',
              [cId, leadId, 'assistant', text]
            );
          } catch {}

        }
      })().catch((err) => console.error('[SEND-MULTI ERROR]', err));

      return reply.send({ status: 'queued', count: messages.length });
    }
  );
};
