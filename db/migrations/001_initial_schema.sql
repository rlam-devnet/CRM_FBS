-- FBS CRM Database Initialization
-- Migration: 001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table: leads
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(50) UNIQUE,
    email VARCHAR(150),
    company_name VARCHAR(150),
    telegram_id VARCHAR(50) UNIQUE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    channel VARCHAR(30) NOT NULL DEFAULT 'telegram',
    entry_class VARCHAR(30) DEFAULT 'LEAD',
    current_state VARCHAR(50) NOT NULL DEFAULT 'NEW_LEAD',
    dedupe_master_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    utm_source_ref VARCHAR(100),
    last_interaction_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_telegram ON leads(telegram_id);
CREATE INDEX IF NOT EXISTS idx_leads_state ON leads(current_state);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

-- 2. Table: state_transition_rules (Defined state machine constraints)
CREATE TABLE IF NOT EXISTS state_transition_rules (
    id SERIAL PRIMARY KEY,
    from_state VARCHAR(50) NOT NULL,
    to_state VARCHAR(50) NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_state_transition UNIQUE (from_state, to_state)
);

-- 3. Table: state_transitions (Immutable event log)
CREATE TABLE IF NOT EXISTS state_transitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    from_state VARCHAR(50),
    to_state VARCHAR(50) NOT NULL,
    actor VARCHAR(50) NOT NULL,
    reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transitions_lead ON state_transitions(lead_id);
CREATE INDEX IF NOT EXISTS idx_transitions_created ON state_transitions(created_at);

-- 4. Table: lead_qualification (P1-P4 answers and scoring)
CREATE TABLE IF NOT EXISTS lead_qualification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    service_needed TEXT,
    business_problem TEXT,
    decision_authority TEXT,
    investment_readiness TEXT,
    commitment_timeline TEXT,
    score_total INTEGER DEFAULT 0,
    score_breakdown JSONB DEFAULT '{}'::jsonb,
    gate_authority_pass BOOLEAN DEFAULT true,
    gate_investment_pass BOOLEAN DEFAULT true,
    hard_stop_flags TEXT[] DEFAULT ARRAY[]::TEXT[],
    raw_answers JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Table: consultations (Scheduling)
CREATE TABLE IF NOT EXISTS consultations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    calendar_event_id VARCHAR(100),
    status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED',
    precall_form_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Table: precall_forms (Pre-call questionnaire responses)
CREATE TABLE IF NOT EXISTS precall_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    responses JSONB NOT NULL DEFAULT '{}'::jsonb,
    risk_signals TEXT[] DEFAULT ARRAY[]::TEXT[],
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Table: config_variables (Centralized business configuration)
CREATE TABLE IF NOT EXISTS config_variables (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Table: webhook_events (Deduplication and audit for incoming messages)
CREATE TABLE IF NOT EXISTS webhook_events (
    message_id VARCHAR(100) PRIMARY KEY,
    channel VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'processed',
    error_message TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Table: clients (Post-sale entity)
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Table: proposals_contracts
CREATE TABLE IF NOT EXISTS proposals_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
    price_ref VARCHAR(100),
    amount NUMERIC(15,2),
    currency VARCHAR(10) DEFAULT 'CLP',
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Table: audio_transcriptions
CREATE TABLE IF NOT EXISTS audio_transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    audio_url TEXT,
    transcription_text TEXT,
    evidence_type VARCHAR(50) DEFAULT 'DECLARACIÓN',
    transcription_status VARCHAR(30) DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Table: commercial_gate_evaluations
CREATE TABLE IF NOT EXISTS commercial_gate_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
    gate_passed BOOLEAN NOT NULL DEFAULT false,
    evaluated_by VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Table: chat_messages (Persistent conversational memory)
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    chat_id VARCHAR(50) NOT NULL,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_lead ON chat_messages(lead_id);

-- TRIGGERS & FUNCTIONS

-- Function to validate state transition against state_transition_rules
CREATE OR REPLACE FUNCTION fn_validate_state_transition()
RETURNS TRIGGER AS $$
DECLARE
    is_valid BOOLEAN := false;
BEGIN
    IF OLD.current_state IS DISTINCT FROM NEW.current_state THEN
        SELECT allowed INTO is_valid
        FROM state_transition_rules
        WHERE from_state = OLD.current_state AND to_state = NEW.current_state;

        IF is_valid IS NOT TRUE THEN
            RAISE EXCEPTION 'INVALID_TRANSITION: Transicion no permitida de % a %', 
                OLD.current_state, NEW.current_state 
                USING ERRCODE = 'check_violation';
        END IF;

        NEW.updated_at := NOW();
        NEW.last_interaction_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_validate_state_transition
BEFORE UPDATE OF current_state ON leads
FOR EACH ROW
EXECUTE FUNCTION fn_validate_state_transition();

-- Function to log state transitions automatically to state_transitions
CREATE OR REPLACE FUNCTION fn_audit_state_transition()
RETURNS TRIGGER AS $$
DECLARE
    actor_val VARCHAR(50);
    reason_val TEXT;
BEGIN
    actor_val := NULLIF(current_setting('app.current_actor', true), '');
    IF actor_val IS NULL THEN
        actor_val := 'system';
    END IF;

    reason_val := current_setting('app.current_reason', true);

    IF (TG_OP = 'INSERT') THEN
        INSERT INTO state_transitions (lead_id, from_state, to_state, actor, reason)
        VALUES (NEW.id, NULL, NEW.current_state, actor_val, COALESCE(reason_val, 'Creación de nuevo lead'));
    ELSIF (TG_OP = 'UPDATE' AND OLD.current_state IS DISTINCT FROM NEW.current_state) THEN
        INSERT INTO state_transitions (lead_id, from_state, to_state, actor, reason)
        VALUES (NEW.id, OLD.current_state, NEW.current_state, actor_val, reason_val);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_audit_state_transition_update
AFTER UPDATE OF current_state ON leads
FOR EACH ROW
EXECUTE FUNCTION fn_audit_state_transition();

CREATE OR REPLACE TRIGGER trg_audit_state_transition_insert
AFTER INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION fn_audit_state_transition();
