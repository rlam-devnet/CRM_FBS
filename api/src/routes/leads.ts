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

async function flushBuffer(chatId: string) {
  const buf = activeBuffers.get(chatId);
  if (!buf) return;
  activeBuffers.delete(chatId);

  const combinedText = buf.texts.join('\n').trim();
  if (!combinedText) return;

  console.log(`[DEBOUNCE FLUSH] chatId=${chatId}, combined ${buf.texts.length} messages: "${combinedText}"`);

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

    return reply.send({
      lead: leadRows[0],
      qualification: qualificationRows[0] || null,
      precall_form: precallRows[0] || null,
      consultations: consultationRows,
      recent_transitions: transitionRows,
    });
  });

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

    const DEBOUNCE_MS = 3500;
    buf.timer = setTimeout(() => {
      flushBuffer(cId).catch(console.error);
    }, DEBOUNCE_MS);

    return reply.send({
      status: 'buffered',
      chat_id: cId,
      buffer_count: buf.texts.length,
      wait_ms: DEBOUNCE_MS,
    });
  });
};
