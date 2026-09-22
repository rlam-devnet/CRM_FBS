-- Test: State Machine Validation & Audit Log Verification
DO $$
DECLARE
    v_lead_id UUID;
    v_transition_count INT;
    v_error_caught BOOLEAN := false;
BEGIN
    RAISE NOTICE '--- INICIANDO TEST DE MAQUINA DE ESTADOS Y AUDITORIA ---';

    -- 1. Insertar lead sintético
    INSERT INTO leads (telegram_id, channel, entry_class, current_state)
    VALUES ('test_telegram_999999', 'telegram', 'LEAD', 'NEW_LEAD')
    RETURNING id INTO v_lead_id;

    -- 2. Verificar trigger de auditoría en INSERT
    SELECT COUNT(*) INTO v_transition_count 
    FROM state_transitions 
    WHERE lead_id = v_lead_id AND to_state = 'NEW_LEAD' AND from_state IS NULL;

    IF v_transition_count <> 1 THEN
        RAISE EXCEPTION 'FALLO: No se registró la auditoría de creación en state_transitions';
    END IF;
    RAISE NOTICE 'PASO 1: Inserción de lead y auditoría inicial correctas.';

    -- 3. Transición válida: NEW_LEAD -> QUALIFYING
    PERFORM set_config('app.current_actor', 'agente_1', true);
    PERFORM set_config('app.current_reason', 'Inicio de conversación P1', true);

    UPDATE leads 
    SET current_state = 'QUALIFYING' 
    WHERE id = v_lead_id;

    SELECT COUNT(*) INTO v_transition_count 
    FROM state_transitions 
    WHERE lead_id = v_lead_id AND from_state = 'NEW_LEAD' AND to_state = 'QUALIFYING';

    IF v_transition_count <> 1 THEN
        RAISE EXCEPTION 'FALLO: No se auditó la transición válida a QUALIFYING';
    END IF;
    RAISE NOTICE 'PASO 2: Transición válida NEW_LEAD -> QUALIFYING aprobada y auditada.';

    -- 4. Transición inválida: QUALIFYING -> PROPOSAL_SENT (debe fallar y lanzar excepción)
    BEGIN
        UPDATE leads 
        SET current_state = 'PROPOSAL_SENT' 
        WHERE id = v_lead_id;
    EXCEPTION WHEN OTHERS THEN
        v_error_caught := true;
        RAISE NOTICE 'PASO 3: Excepción capturada exitosamente ante transición inválida: %', SQLERRM;
    END;

    IF NOT v_error_caught THEN
        RAISE EXCEPTION 'FALLO DE SEGURIDAD: Se permitió una transición ilegal (QUALIFYING -> PROPOSAL_SENT)';
    END IF;

    -- 5. Transición válida: QUALIFYING -> QUALIFIED
    PERFORM set_config('app.current_actor', 'agente_1', true);
    PERFORM set_config('app.current_reason', 'P1-P4 completado con score 7/8', true);

    UPDATE leads 
    SET current_state = 'QUALIFIED' 
    WHERE id = v_lead_id;

    RAISE NOTICE 'PASO 4: Transición válida QUALIFYING -> QUALIFIED ejecutada con éxito.';

    -- Limpieza
    DELETE FROM leads WHERE id = v_lead_id;

    RAISE NOTICE '--- TODOS LOS TESTS DE LA MAQUINA DE ESTADOS PASARON SATISFACTORIAMENTE ---';
END $$;
