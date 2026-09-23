import { FastifyPluginAsync } from 'fastify';
import { query, getClient } from '../db.js';
import { evaluateQualification, QualificationInputs } from '../scoring.js';
import { getMessage } from '../message-keys.js';

interface AnswerBody {
  question: 'GREETING' | 'P0' | 'P1' | 'P2' | 'P3_AUTHORITY' | 'P3_INVESTMENT' | 'P4';
  raw_answer: string;
  answer_type?: 'text' | 'audio';
  actor?: string;
}

export const qualificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string }; Body: AnswerBody }>(
    '/leads/:id/qualification/answer',
    async (request, reply) => {
      const { id } = request.params;
      const { question, raw_answer, answer_type = 'text', actor = 'agente_1' } = request.body;

      if (!question || raw_answer === undefined) {
        return reply.status(400).send({ error: 'question y raw_answer son requeridos' });
      }

      // 1. Obtener lead actual
      const leadRows = await query('SELECT * FROM leads WHERE id = $1', [id]);
      if (leadRows.length === 0) {
        return reply.status(404).send({ error: 'Lead no encontrado' });
      }
      const lead = leadRows[0];

      // Caso especial: Primer saludo (GREETING o P0)
      if (question === 'GREETING' || question === 'P0') {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
          await client.query("SELECT set_config('app.current_reason', $1, true)", ['Primer contacto del prospecto']);

          if (lead.current_state === 'NEW_LEAD') {
            await client.query(
              "UPDATE leads SET current_state = 'QUALIFYING', updated_at = NOW() WHERE id = $1",
              [id]
            );
          }
          await client.query('COMMIT');

          return reply.send({
            lead_id: id,
            current_state: 'QUALIFYING',
            next_action: 'ASK_QUESTION',
            next_question: 'P1',
            message_text: getMessage('apertura') + '\n\n' + getMessage('pregunta_p1'),
            score_total: 0,
            gate_authority_pass: true,
            gate_investment_pass: true,
            hard_stop_flags: []
          });
        } catch (err: unknown) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }

      // 2. Obtener o crear lead_qualification
      let qualRows = await query('SELECT * FROM lead_qualification WHERE lead_id = $1', [id]);
      if (qualRows.length === 0) {
        await query(
          'INSERT INTO lead_qualification (lead_id, raw_answers) VALUES ($1, $2)',
          [id, JSON.stringify({})]
        );
        qualRows = await query('SELECT * FROM lead_qualification WHERE lead_id = $1', [id]);
      }
      const qualification = qualRows[0];
      const rawAnswers = (qualification.raw_answers || {}) as Record<string, unknown>;
      rawAnswers[question] = { answer: raw_answer, type: answer_type, timestamp: new Date().toISOString() };

      // 3. Procesar pregunta específica
      let nextAction = 'ASK_QUESTION';
      let nextQuestion: string | null = null;
      let messageKey = '';
      let messageText = '';
      let targetState = lead.current_state as string;
      let reason = `Respuesta recibida para ${question}`;

      const inputs: QualificationInputs = {
        serviceNeeded: qualification.service_needed || (question === 'P1' ? raw_answer : undefined),
        businessProblem: qualification.business_problem || (question === 'P2' ? raw_answer : undefined),
        decisionAuthority: qualification.decision_authority || (question === 'P3_AUTHORITY' ? raw_answer : undefined),
        investmentReadiness: qualification.investment_readiness || (question === 'P3_INVESTMENT' ? raw_answer : undefined),
        commitmentTimeline: qualification.commitment_timeline || (question === 'P4' ? raw_answer : undefined),
      };

      if (question === 'P1') {
        inputs.serviceNeeded = raw_answer;
        if (targetState === 'NEW_LEAD') {
          targetState = 'QUALIFYING';
        }
        nextQuestion = 'P2';
        messageKey = 'pregunta_p2';
        messageText = getMessage('pregunta_p2');
      } else if (question === 'P2') {
        inputs.businessProblem = raw_answer;
        const evalRes = evaluateQualification(inputs);
        if (evalRes.hardStopFlags.length > 0) {
          targetState = 'HUMAN_REVIEW';
          nextAction = 'HANDOFF_HUMAN';
          messageKey = 'hard_stop_rechazo';
          messageText = getMessage('hard_stop_rechazo');
          reason = `Hard stop detectado: ${evalRes.hardStopFlags.join(', ')}`;
        } else {
          nextQuestion = 'P3_AUTHORITY';
          messageKey = 'pregunta_p3_autoridad';
          messageText = getMessage('pregunta_p3_autoridad');
        }
      } else if (question === 'P3_AUTHORITY') {
        inputs.decisionAuthority = raw_answer;
        const evalRes = evaluateQualification(inputs);
        if (!evalRes.gateAuthorityPass) {
          targetState = 'NURTURE';
          nextAction = 'TERMINATE_NURTURE';
          messageKey = 'gate_sin_decisor';
          messageText = getMessage('gate_sin_decisor');
          reason = 'Fallo en Gate de autoridad (sin decisor)';
        } else {
          nextQuestion = 'P3_INVESTMENT';
          messageKey = 'pregunta_p3_inversion';
          const configRows = await query("SELECT value FROM config_variables WHERE key = 'PISO_INVERSION'");
          const pisoVal = configRows[0]?.value || '$1.200.000 CLP';
          messageText = getMessage('pregunta_p3_inversion', { PISO_INVERSION: pisoVal });
        }
      } else if (question === 'P3_INVESTMENT') {
        inputs.investmentReadiness = raw_answer;
        const evalRes = evaluateQualification(inputs);
        if (!evalRes.gateInvestmentPass) {
          targetState = 'NURTURE';
          nextAction = 'TERMINATE_NURTURE';
          messageKey = 'gate_sin_presupuesto';
          messageText = getMessage('gate_sin_presupuesto');
          reason = 'Fallo en Gate de inversión (fuera de rango)';
        } else {
          nextQuestion = 'P4';
          messageKey = 'pregunta_p4';
          messageText = getMessage('pregunta_p4');
        }
      } else if (question === 'P4') {
        inputs.commitmentTimeline = raw_answer;
        const finalEval = evaluateQualification(inputs);
        targetState = finalEval.recommendedState;
        reason = finalEval.statusReason;

        if (finalEval.recommendedState === 'QUALIFIED') {
          nextAction = 'HANDOFF_AGENTE_2';
          messageKey = 'qualified_resumen';
          messageText = getMessage('qualified_resumen', {
            servicio: inputs.serviceNeeded || 'marca',
            problema: inputs.businessProblem || 'diseño estratégico'
          });
        } else if (finalEval.recommendedState === 'HUMAN_REVIEW') {
          nextAction = 'HANDOFF_HUMAN';
          messageKey = 'hard_stop_rechazo';
          messageText = getMessage('hard_stop_rechazo');
        } else {
          nextAction = 'TERMINATE_NURTURE';
          messageKey = 'nurture_score_bajo';
          messageText = getMessage('nurture_score_bajo');
        }
      }

      // Evaluar scoring acumulado
      const currentEval = evaluateQualification(inputs);

      // Guardar en DB con transacción
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_actor', $1, true)", [actor]);
        await client.query("SELECT set_config('app.current_reason', $1, true)", [reason]);

        // Actualizar tabla de calificación
        await client.query(
          `UPDATE lead_qualification
           SET service_needed = $1,
               business_problem = $2,
               decision_authority = $3,
               investment_readiness = $4,
               commitment_timeline = $5,
               score_total = $6,
               score_breakdown = $7,
               gate_authority_pass = $8,
               gate_investment_pass = $9,
               hard_stop_flags = $10,
               raw_answers = $11,
               updated_at = NOW()
           WHERE lead_id = $12`,
          [
            inputs.serviceNeeded || null,
            inputs.businessProblem || null,
            inputs.decisionAuthority || null,
            inputs.investmentReadiness || null,
            inputs.commitmentTimeline || null,
            currentEval.scoreTotal,
            JSON.stringify(currentEval.scoreBreakdown),
            currentEval.gateAuthorityPass,
            currentEval.gateInvestmentPass,
            currentEval.hardStopFlags,
            JSON.stringify(rawAnswers),
            id
          ]
        );

        // Si cambia el estado, actualizar leads (disparará triggers)
        if (targetState !== lead.current_state) {
          await client.query(
            'UPDATE leads SET current_state = $1, updated_at = NOW() WHERE id = $2',
            [targetState, id]
          );
        }

        await client.query('COMMIT');

        return reply.send({
          lead_id: id,
          current_state: targetState,
          next_action: nextAction,
          next_question: nextQuestion,
          message_key: messageKey,
          message_text: messageText,
          score_total: currentEval.scoreTotal,
          gate_authority_pass: currentEval.gateAuthorityPass,
          gate_investment_pass: currentEval.gateInvestmentPass,
          hard_stop_flags: currentEval.hardStopFlags,
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
