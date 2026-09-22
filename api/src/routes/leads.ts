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
};
