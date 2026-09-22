-- FBS CRM Initial Seeds
-- Migration: 002_initial_seeds.sql

-- 1. Insert State Machine Transition Rules
INSERT INTO state_transition_rules (from_state, to_state, allowed) VALUES
    ('NEW_LEAD', 'QUALIFYING', true),
    ('NEW_LEAD', 'OUT_OF_SCOPE', true),
    ('NEW_LEAD', 'SPAM', true),

    ('QUALIFYING', 'WARM', true),
    ('QUALIFYING', 'PARTIAL', true),
    ('QUALIFYING', 'QUALIFIED', true),
    ('QUALIFYING', 'NURTURE', true),
    ('QUALIFYING', 'HUMAN_REVIEW', true),

    ('WARM', 'QUALIFYING', true),
    ('WARM', 'QUALIFIED', true),
    ('WARM', 'PARTIAL', true),
    ('WARM', 'NURTURE', true),
    ('WARM', 'HUMAN_REVIEW', true),

    ('PARTIAL', 'QUALIFYING', true),
    ('PARTIAL', 'NURTURE', true),

    ('QUALIFIED', 'CONSULTATION_PENDING', true),
    ('QUALIFIED', 'HUMAN_REVIEW', true),

    ('CONSULTATION_PENDING', 'PRECALL_FORM_SENT', true),
    ('CONSULTATION_PENDING', 'PRECALL_FORM_SKIPPED', true),
    ('CONSULTATION_PENDING', 'HUMAN_REVIEW', true),
    ('CONSULTATION_PENDING', 'PRECALL_FORM_DONE', true),

    ('PRECALL_FORM_SENT', 'PRECALL_FORM_DONE', true),
    ('PRECALL_FORM_SENT', 'PRECALL_FORM_SKIPPED', true),
    ('PRECALL_FORM_SENT', 'HUMAN_REVIEW', true),

    ('PRECALL_FORM_DONE', 'PROPOSAL_SENT', true),
    ('PRECALL_FORM_DONE', 'NURTURE', true),
    ('PRECALL_FORM_DONE', 'HUMAN_REVIEW', true),

    ('PRECALL_FORM_SKIPPED', 'PROPOSAL_SENT', true),
    ('PRECALL_FORM_SKIPPED', 'NURTURE', true),
    ('PRECALL_FORM_SKIPPED', 'HUMAN_REVIEW', true),

    ('PROPOSAL_SENT', 'ACTIVATION_PENDING', true),
    ('PROPOSAL_SENT', 'NURTURE', true),

    ('ACTIVATION_PENDING', 'CLIENT_ACTIVE', true),
    ('ACTIVATION_PENDING', 'NURTURE', true),

    ('HUMAN_REVIEW', 'QUALIFYING', true),
    ('HUMAN_REVIEW', 'QUALIFIED', true),
    ('HUMAN_REVIEW', 'CONSULTATION_PENDING', true),
    ('HUMAN_REVIEW', 'NURTURE', true),
    ('HUMAN_REVIEW', 'OUT_OF_SCOPE', true),

    ('NURTURE', 'QUALIFYING', true)
ON CONFLICT (from_state, to_state) DO NOTHING;

-- 2. Insert Config Variables
INSERT INTO config_variables (key, value, description, status) VALUES
    ('PISO_INVERSION', '$1.200.000 CLP', 'Piso de inversión para proyectos de identidad/rebranding FBS', 'active'),
    ('consultation_mode', 'FREE', 'Modalidad de la llamada exploratoria inicial (30 min)', 'active'),
    ('capacity_max', '3', 'Capacidad máxima de proyectos concurrentes del estudio', 'active'),
    ('stt_provider', 'OpenAI Whisper API', 'Proveedor de Speech to Text para transcripción de notas de voz', 'active'),
    ('crm_platform', 'PostgreSQL Local', 'Base de datos del CRM FBS', 'active'),
    ('calendar_tool', 'Cal.com', 'Herramienta de reservas y agendamiento de llamadas', 'active'),
    ('consent_text', 'Al continuar aceptas la política de privacidad de FBS', 'Texto legal de consentimiento de contacto', 'active'),
    ('handoff_channel', 'Telegram internal / Slack #leads-fbs', 'Canal para alertas y handoff a operadores humanos', 'pending'),
    ('followup_sla', '24h', 'Tiempo máximo antes de disparo de reenganche en leads inactivos', 'pending'),
    ('noshow_policy', '1 rebooking permitted', 'Política ante inasistencia a la consulta agendada', 'pending'),
    ('pricing_terms', '50% anticipo, 50% contra entrega', 'Condiciones de pago estándar para contratos', 'pending')
ON CONFLICT (key) DO UPDATE SET 
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    updated_at = NOW();
