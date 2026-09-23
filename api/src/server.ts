import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { leadsRoutes } from './routes/leads.js';
import { qualificationRoutes } from './routes/qualification.js';
import { consultationsRoutes } from './routes/consultations.js';
import { configRoutes } from './routes/config.js';
import { query } from './db.js';

dotenv.config();

async function bootstrap() {
  const server = Fastify({
    logger: process.env.NODE_ENV !== 'production' ? { level: 'info' } : false,
  });

  await server.register(cors, { origin: true });

  // HTML Dashboard on GET /
  server.get('/', async (_request, reply) => {
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FBS Studio — CRM & Conversational Pipeline</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0c0e12;
      --card-bg: #14171f;
      --card-border: #222634;
      --text: #f0f2f5;
      --text-muted: #8a92a6;
      --primary: #3b82f6;
      --primary-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
    .container { max-width: 1400px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--card-border); }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo-badge { background: linear-gradient(135deg, #3b82f6, #8b5cf6); width: 42px; height: 42px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 20px; }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .subtitle { color: var(--text-muted); font-size: 13px; }
    .live-status { display: flex; gap: 12px; }
    .status-chip { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; background: var(--card-bg); border: 1px solid var(--card-border); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); }
    
    /* Metrics Grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 20px; position: relative; overflow: hidden; }
    .metric-card::after { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--primary); }
    .metric-title { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .metric-val { font-size: 32px; font-weight: 700; }
    
    /* Table Section */
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .section-title { font-size: 18px; font-weight: 600; }
    .table-container { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 14px 18px; background: rgba(255,255,255,0.02); color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--card-border); }
    td { padding: 16px 18px; border-bottom: 1px solid var(--card-border); font-size: 14px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.015); }
    
    /* Badges */
    .badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
    .badge-NEW_LEAD { background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); }
    .badge-QUALIFYING { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-QUALIFIED { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-CONSULTATION_PENDING { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-PRECALL_FORM_DONE { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid #10b981; }
    .badge-HUMAN_REVIEW { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-NURTURE { background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); }
    
    .score-chip { font-weight: 700; color: var(--text); background: rgba(255,255,255,0.06); padding: 3px 8px; border-radius: 4px; font-size: 12px; }
    .btn-detail { background: var(--primary); color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.2s; }
    .btn-detail:hover { opacity: 0.9; transform: translateY(-1px); }

    /* Modal */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); z-index: 1000; align-items: center; justify-content: center; }
    .modal-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; width: 90%; max-width: 800px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
    .modal-header { padding: 20px 24px; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; }
    .modal-body { padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
    .close-btn { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; }
    .detail-section { background: rgba(255,255,255,0.02); border: 1px solid var(--card-border); border-radius: 10px; padding: 16px; }
    .detail-section h4 { font-size: 14px; margin-bottom: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 0.5px; }
    .q-row { margin-bottom: 10px; font-size: 13px; line-height: 1.5; }
    .q-label { color: var(--text-muted); font-weight: 600; }
    .timeline { list-style: none; padding-left: 10px; border-left: 2px solid var(--card-border); margin-left: 8px; }
    .timeline-item { position: relative; margin-bottom: 12px; padding-left: 14px; font-size: 13px; }
    .timeline-item::before { content: ''; position: absolute; left: -15px; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: var(--primary); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="logo-badge">F</div>
        <div>
          <h1>Fernández Briceño Studio</h1>
          <div class="subtitle">CRM & Pipeline Conversacional Autónomo</div>
        </div>
      </div>
      <div class="live-status">
        <div class="status-chip"><span class="dot"></span> PostgreSQL 16 (Local)</div>
        <div class="status-chip"><span class="dot"></span> n8n Router Activo</div>
        <div class="status-chip"><span class="dot"></span> Telegram Bot (@netops_hub_uc_bot)</div>
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card" style="--primary: #3b82f6;">
        <div class="metric-title">Total Leads</div>
        <div class="metric-val" id="m-total">0</div>
      </div>
      <div class="metric-card" style="--primary: #10b981;">
        <div class="metric-title">Calificados (QUALIFIED)</div>
        <div class="metric-val" id="m-qualified" style="color: #34d399;">0</div>
      </div>
      <div class="metric-card" style="--primary: #f59e0b;">
        <div class="metric-title">En Calificación (P1-P4)</div>
        <div class="metric-val" id="m-qualifying" style="color: #fbbf24;">0</div>
      </div>
      <div class="metric-card" style="--primary: #8b5cf6;">
        <div class="metric-title">Citas Agendadas</div>
        <div class="metric-val" id="m-consultations" style="color: #a78bfa;">0</div>
      </div>
    </div>

    <div class="section-header">
      <div class="section-title">Leads en Pipeline (Tiempo Real)</div>
      <button class="btn-detail" onclick="loadData()">Actualizar Ahora</button>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Nombre / Contacto</th>
            <th>Empresa</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>Estado Actual</th>
            <th>Score</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody id="leads-tbody">
          <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Cargando leads...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Modal Detalle -->
  <div class="modal-overlay" id="detail-modal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 id="modal-title">Detalle del Lead</h3>
        <button class="close-btn" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modal-content">
        <!-- Render dinámico -->
      </div>
    </div>
  </div>

  <script>
    async function loadData() {
      try {
        const res = await fetch('/api/dashboard/leads');
        const data = await res.json();
        
        // Metrics
        const leads = data.leads || [];
        document.getElementById('m-total').innerText = leads.length;
        document.getElementById('m-qualified').innerText = leads.filter(l => l.current_state === 'QUALIFIED').length;
        document.getElementById('m-qualifying').innerText = leads.filter(l => ['NEW_LEAD', 'QUALIFYING', 'WARM', 'PARTIAL'].includes(l.current_state)).length;
        document.getElementById('m-consultations').innerText = leads.filter(l => ['CONSULTATION_PENDING', 'PRECALL_FORM_SENT', 'PRECALL_FORM_DONE'].includes(l.current_state)).length;

        // Table
        const tbody = document.getElementById('leads-tbody');
        if (leads.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">No hay leads registrados aún.</td></tr>';
          return;
        }

        tbody.innerHTML = leads.map(l => {
          const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.telegram_id || 'Prospecto';
          const score = l.score_total !== null ? l.score_total + ' / 8' : '—';
          const emailDisplay = l.email ? '<span style="color:#60a5fa; font-weight:600;">' + l.email + '</span>' : '<span style="color:var(--text-muted);">Pendiente</span>';
          const phoneDisplay = l.phone ? l.phone : '<span style="color:var(--text-muted);">Pendiente</span>';
          return \`
            <tr>
              <td>
                <div style="font-weight: 600;">\${name}</div>
                <div style="font-size: 11px; color: var(--text-muted);">ID: \${l.id.substring(0, 8)}... | Telegram: \${l.telegram_id || '—'}</div>
              </td>
              <td>\${l.company_name || '—'}</td>
              <td>\${emailDisplay}</td>
              <td>\${phoneDisplay}</td>
              <td><span class="badge badge-\${l.current_state}">\${l.current_state}</span></td>
              <td><span class="score-chip">\${score}</span></td>
              <td><button class="btn-detail" onclick="openDetail('\${l.id}')">Ver Detalle</button></td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error cargando leads:', err);
      }
    }

    async function openDetail(id) {
      try {
        const res = await fetch('/leads/' + id);
        const data = await res.json();
        const l = data.lead;
        const q = data.qualification || {};
        const transitions = data.recent_transitions || [];

        const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.telegram_id || 'Prospecto';
        document.getElementById('modal-title').innerText = name + ' (' + l.current_state + ')';

        let html = \`
          <div class="detail-section">
            <h4>Datos de Contacto del Cliente</h4>
            <div class="q-row"><span class="q-label">Empresa / Negocio:</span> \${l.company_name || 'No registrada aún'}</div>
            <div class="q-row"><span class="q-label">Email Corporativo:</span> \${l.email ? '<strong style="color:#60a5fa;">' + l.email + '</strong>' : 'Pendiente de captura'}</div>
            <div class="q-row"><span class="q-label">Teléfono / WhatsApp:</span> \${l.phone || 'Pendiente de captura'}</div>
            <div class="q-row"><span class="q-label">Canal / ID:</span> \${l.channel} (\${l.telegram_id || l.phone || '—'})</div>
          </div>

          <div class="detail-section">
            <h4>Calificación Conversacional (P1 a P4)</h4>
            <div class="q-row"><span class="q-label">P1 Servicio:</span> \${q.service_needed || 'Pendiente'}</div>
            <div class="q-row"><span class="q-label">P2 Problema:</span> \${q.business_problem || 'Pendiente'}</div>
            <div class="q-row"><span class="q-label">P3 Decisor:</span> \${q.decision_authority || 'Pendiente'} (\${q.gate_authority_pass ? '✓ Superado' : '✗ Fallido'})</div>
            <div class="q-row"><span class="q-label">P3 Inversión:</span> \${q.investment_readiness || 'Pendiente'} (\${q.gate_investment_pass ? '✓ Superado' : '✗ Fallido'})</div>
            <div class="q-row"><span class="q-label">P4 Compromiso:</span> \${q.commitment_timeline || 'Pendiente'}</div>
            <div class="q-row"><span class="q-label">Score Total:</span> <strong>\${q.score_total || 0} / 8</strong></div>
          </div>

          <div class="detail-section">
            <h4>Auditoría Inmutable de Estados (PostgreSQL)</h4>
            <ul class="timeline">
              \${transitions.map(t => \`
                <li class="timeline-item">
                  <strong>\${t.from_state || 'INICIO'} → \${t.to_state}</strong>
                  <div style="font-size: 12px; color: var(--text-muted);">
                    Actor: \${t.actor} | \${new Date(t.created_at).toLocaleTimeString('es-CL')}
                    \${t.reason ? ' — Motivo: ' + t.reason : ''}
                  </div>
                </li>
              \`).join('')}
            </ul>
          </div>
        \`;

        document.getElementById('modal-content').innerHTML = html;
        document.getElementById('detail-modal').style.display = 'flex';
      } catch (err) {
        alert('Error al abrir detalle: ' + err.message);
      }
    }

    function closeModal() {
      document.getElementById('detail-modal').style.display = 'none';
    }

    // Polling cada 4 segundos
    loadData();
    setInterval(loadData, 4000);
  </script>
</body>
</html>`;
    return reply.type('text/html').send(html);
  });

  // API endpoint for dashboard leads list
  server.get('/api/dashboard/leads', async (_request, reply) => {
    const leads = await query(
      `SELECT l.id, l.phone, l.email, l.company_name, l.telegram_id, l.first_name, l.last_name, l.channel, 
              l.current_state, l.last_interaction_at, l.created_at,
              q.score_total, q.gate_authority_pass, q.gate_investment_pass
       FROM leads l
       LEFT JOIN lead_qualification q ON l.id = q.lead_id
       ORDER BY l.last_interaction_at DESC LIMIT 50`
    );
    return reply.send({ leads });
  });

  // Health check endpoint
  server.get('/health', async (_request, reply) => {
    try {
      const res = await query('SELECT 1 as healthy');
      return reply.send({
        status: 'ok',
        service: 'fbs-crm-api',
        db: res[0]?.healthy === 1 ? 'connected' : 'error',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ status: 'error', db: msg });
    }
  });

  // Register routes
  await server.register(leadsRoutes);
  await server.register(qualificationRoutes);
  await server.register(consultationsRoutes);
  await server.register(configRoutes);

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const HOST = process.env.HOST || '0.0.0.0';

  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`FBS CRM API & Dashboard running on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap();
