import { FastifyPluginAsync } from 'fastify';
import { query, getClient } from '../db.js';

interface ConsultationBody {
  scheduled_at: string;
  calendar_event_id?: string;
  notes?: string;
  actor?: string;
}

interface PrecallFormBody {
  responses: Record<string, unknown>;
  actor?: string;
}

export const consultationsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /leads/:id/consultation - Agenda cita
  fastify.post<{ Params: { id: string }; Body: ConsultationBody }>(
    '/leads/:id/consultation',
    async (request, reply) => {
      const { id } = request.params;
      const { scheduled_at, calendar_event_id, notes, actor = 'agente_2' } = request.body || {};

      if (!scheduled_at) {
        return reply.status(400).send({ error: 'scheduled_at es obligatorio' });
      }

      const leadRows = await query('SELECT current_state FROM leads WHERE id = $1', [id]);
      if (leadRows.length === 0) {
        return reply.status(404).send({ error: 'Lead no encontrado' });
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
        await client.query("SELECT set_config('app.current_reason', $1, true)", ['Cita agendada']);

        // Insertar consulta
        const insertRes = await client.query(
          `INSERT INTO consultations (lead_id, scheduled_at, calendar_event_id, notes, status, precall_form_status)
           VALUES ($1, $2, $3, $4, 'SCHEDULED', 'PENDING')
           RETURNING id, scheduled_at, status`,
          [id, scheduled_at, calendar_event_id || null, notes || null]
        );

        // Actualizar estado del lead a CONSULTATION_PENDING si es válido
        const fromState = leadRows[0].current_state as string;
        if (fromState === 'QUALIFIED') {
          await client.query(
            "UPDATE leads SET current_state = 'CONSULTATION_PENDING', updated_at = NOW() WHERE id = $1",
            [id]
          );
        }

        await client.query('COMMIT');

        return reply.status(201).send({
          consultation_id: insertRes.rows[0].id,
          lead_id: id,
          scheduled_at: insertRes.rows[0].scheduled_at,
          current_state: fromState === 'QUALIFIED' ? 'CONSULTATION_PENDING' : fromState,
          precall_form_link: `https://fbs.studio/precall/${id}`
        });
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  );

  // POST /leads/:id/precall-form - Formulario previo a la llamada
  fastify.post<{ Params: { id: string }; Body: PrecallFormBody }>(
    '/leads/:id/precall-form',
    async (request, reply) => {
      const { id } = request.params;
      const { responses = {}, actor = 'lead_direct' } = request.body || {};

      const leadRows = await query('SELECT current_state FROM leads WHERE id = $1', [id]);
      if (leadRows.length === 0) {
        return reply.status(404).send({ error: 'Lead no encontrado' });
      }

      // Analizar risk signals automáticos
      const riskSignals: string[] = [];
      const respStr = JSON.stringify(responses).toLowerCase();
      if (respStr.includes('sin estrategia') || respStr.includes('no tenemos plan')) {
        riskSignals.push('ESTRATEGIA_NO_DEFINIDA');
      }
      if (respStr.includes('urgente') || respStr.includes('para ayer')) {
        riskSignals.push('EXPECTATIVA_TIEMPO_CRITICA');
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
        await client.query("SELECT set_config('app.current_reason', $1, true)", ['Formulario pre-llamada enviado']);

        const insertRes = await client.query(
          `INSERT INTO precall_forms (lead_id, responses, risk_signals)
           VALUES ($1, $2, $3)
           RETURNING id, submitted_at`,
          [id, JSON.stringify(responses), riskSignals]
        );

        // Actualizar estado de consulta si existe
        await client.query(
          "UPDATE consultations SET precall_form_status = 'DONE', updated_at = NOW() WHERE lead_id = $1",
          [id]
        );

        // Actualizar lead a PRECALL_FORM_DONE si está en PRECALL_FORM_SENT o CONSULTATION_PENDING
        const fromState = leadRows[0].current_state as string;
        let newState = fromState;
        if (fromState === 'PRECALL_FORM_SENT' || fromState === 'CONSULTATION_PENDING') {
          newState = 'PRECALL_FORM_DONE';
          await client.query(
            "UPDATE leads SET current_state = $1, updated_at = NOW() WHERE id = $2",
            [newState, id]
          );
        }

        await client.query('COMMIT');

        return reply.status(201).send({
          precall_form_id: insertRes.rows[0].id,
          lead_id: id,
          risk_signals: riskSignals,
          current_state: newState
        });
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  );
};
