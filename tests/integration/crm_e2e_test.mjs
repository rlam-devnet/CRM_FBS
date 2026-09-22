// FBS CRM API End-to-End Integration Test
const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function run() {
  console.log(`Starting E2E API verification against ${BASE_URL}...`);

  // 1. Health check
  const health = await request('/health');
  assert(health.status === 200, `Health endpoint returns 200 (got ${health.status})`);
  assert(health.data?.db === 'connected', 'Database connection reported as healthy');

  // 2. Create synthetic lead
  const randomSuffix = Math.floor(Math.random() * 1000000);
  const telegramId = `e2e_user_${randomSuffix}`;

  const create = await request('/leads', {
    method: 'POST',
    body: JSON.stringify({
      telegram_id: telegramId,
      channel: 'telegram',
      first_name: 'Test',
      last_name: 'Lead',
    }),
  });
  assert(create.status === 201, `Lead created with status 201 (got ${create.status})`);
  const leadId = create.data.lead_id;
  assert(create.data.current_state === 'NEW_LEAD', 'Initial state is NEW_LEAD');
  assert(create.data.is_new === true, 'is_new is true');

  // 3. Deduplication check
  const dedupe = await request('/leads', {
    method: 'POST',
    body: JSON.stringify({ telegram_id: telegramId }),
  });
  assert(dedupe.status === 200, 'Deduplication returns status 200');
  assert(dedupe.data.lead_id === leadId, 'Deduplication resolves to original lead_id');
  assert(dedupe.data.is_new === false, 'is_new is false for duplicate');

  // 4. Question P1 (Servicio)
  const p1 = await request(`/leads/${leadId}/qualification/answer`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'P1',
      raw_answer: 'Rebranding completo e identidad visual para clínica',
    }),
  });
  assert(p1.status === 200, `P1 answer processed (status ${p1.status})`);
  assert(p1.data.current_state === 'QUALIFYING', 'Lead transitioned to QUALIFYING');
  assert(p1.data.next_question === 'P2', 'Next question is P2');

  // 5. Question P2 (Problema)
  const p2 = await request(`/leads/${leadId}/qualification/answer`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'P2',
      raw_answer: 'Nuestra marca actual se ve desactualizada y no atrae a los clientes corporativos que buscamos',
    }),
  });
  assert(p2.status === 200, 'P2 answer processed');
  assert(p2.data.next_question === 'P3_AUTHORITY', 'Next question is P3_AUTHORITY');

  // 6. Question P3 Authority (Gate)
  const p3Auth = await request(`/leads/${leadId}/qualification/answer`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'P3_AUTHORITY',
      raw_answer: 'A', // Yo tomo la decisión
    }),
  });
  assert(p3Auth.status === 200, 'P3_AUTHORITY processed');
  assert(p3Auth.data.gate_authority_pass === true, 'Gate authority passed');
  assert(p3Auth.data.next_question === 'P3_INVESTMENT', 'Next question is P3_INVESTMENT');

  // 7. Question P3 Investment (Gate)
  const p3Inv = await request(`/leads/${leadId}/qualification/answer`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'P3_INVESTMENT',
      raw_answer: 'A', // Sí, dentro de rango
    }),
  });
  assert(p3Inv.status === 200, 'P3_INVESTMENT processed');
  assert(p3Inv.data.gate_investment_pass === true, 'Gate investment passed');
  assert(p3Inv.data.next_question === 'P4', 'Next question is P4');

  // 8. Question P4 Commitment & Scoring
  const p4 = await request(`/leads/${leadId}/qualification/answer`, {
    method: 'POST',
    body: JSON.stringify({
      question: 'P4',
      raw_answer: 'A', // Esta semana
    }),
  });
  assert(p4.status === 200, 'P4 processed');
  assert(p4.data.score_total >= 5, `Score is qualifying (score = ${p4.data.score_total}/8)`);
  assert(p4.data.current_state === 'QUALIFIED', `Lead reached state QUALIFIED (got ${p4.data.current_state})`);
  assert(p4.data.next_action === 'HANDOFF_AGENTE_2', 'Next action is HANDOFF_AGENTE_2');

  // 9. Schedule Consultation (Agente 2)
  const consult = await request(`/leads/${leadId}/consultation`, {
    method: 'POST',
    body: JSON.stringify({
      scheduled_at: new Date(Date.now() + 86400000 * 2).toISOString(),
      notes: 'Llamada de estrategia coordinada vía Telegram',
    }),
  });
  assert(consult.status === 201, `Consultation created with status 201 (got ${consult.status})`);
  assert(consult.data.current_state === 'CONSULTATION_PENDING', 'Lead transitioned to CONSULTATION_PENDING');

  // 10. Submit Precall Form
  const form = await request(`/leads/${leadId}/precall-form`, {
    method: 'POST',
    body: JSON.stringify({
      responses: {
        presupuesto_estimado: '$2.000.000',
        objetivo_principal: 'Reposicionamiento institucional',
      },
    }),
  });
  assert(form.status === 201, `Precall form submitted (status ${form.status})`);
  assert(form.data.current_state === 'PRECALL_FORM_DONE', 'Lead transitioned to PRECALL_FORM_DONE');

  // 11. Read Snapshot
  const snap = await request(`/leads/${leadId}`);
  assert(snap.status === 200, 'Snapshot endpoint returned 200');
  assert(snap.data.lead.current_state === 'PRECALL_FORM_DONE', 'Snapshot shows correct current state');
  assert(snap.data.qualification.score_total >= 5, 'Snapshot contains qualification score');
  assert(snap.data.consultations.length >= 1, 'Snapshot contains scheduled consultation');
  assert(snap.data.recent_transitions.length >= 4, `Snapshot contains full audit log (${snap.data.recent_transitions.length} transitions)`);

  // 12. Test Illegal Transition Rejection (Machine State integrity)
  const illegalTransition = await request(`/leads/${leadId}/state`, {
    method: 'PATCH',
    body: JSON.stringify({
      to_state: 'SPAM',
      actor: 'test_attacker',
    }),
  });
  assert(illegalTransition.status === 409, `Illegal transition rejected with 409 Conflict (got ${illegalTransition.status})`);
  assert(illegalTransition.data.error === 'INVALID_TRANSITION', 'Error code is INVALID_TRANSITION');

  // 13. Test Config Variable
  const cfg = await request('/config/PISO_INVERSION');
  assert(cfg.status === 200, 'Config variable returned 200');
  assert(cfg.data.value.includes('1.200.000'), `PISO_INVERSION value is correct (${cfg.data.value})`);

  console.log('\n======================================================');
  console.log('✓ ALL 13 E2E INTEGRATION VERIFICATION TESTS PASSED!');
  console.log('======================================================');
}

run().catch((err) => {
  console.error('\n❌ E2E TEST FAILED:', err.message);
  process.exit(1);
});
