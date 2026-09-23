export interface QualificationInputs {
  serviceNeeded?: string;
  businessProblem?: string;
  decisionAuthority?: 'A' | 'B' | 'C' | 'D' | string;
  investmentReadiness?: 'A' | 'B' | 'C' | 'D' | string;
  commitmentTimeline?: 'A' | 'B' | 'C' | 'D' | string;
}

export interface ScoreResult {
  scoreTotal: number;
  scoreBreakdown: {
    serviceScore: number;
    problemScore: number;
    authorityScore: number;
    investmentScore: number;
    commitmentScore: number;
  };
  gateAuthorityPass: boolean;
  gateInvestmentPass: boolean;
  hardStopFlags: string[];
  recommendedState: 'QUALIFIED' | 'WARM' | 'NURTURE' | 'HUMAN_REVIEW';
  statusReason: string;
}

const HARD_STOP_PATTERNS: Array<{ pattern: RegExp; flag: string; reason: string }> = [
  {
    pattern: /\b(copiar|plagiar|igual a|id[eé]ntico a|clon|replicar la marca)\b/i,
    flag: 'COPYCAT_REQUEST',
    reason: 'Prospecto solicita copiar o replicar otra marca comercial'
  },
  {
    pattern: /\b(gratis|sin costo|canje|a cambio de comisi[oó]n|por porcentaje)\b/i,
    flag: 'UNPAID_REQUEST',
    reason: 'Solicitud de trabajo gratuito, canje o comisión variable'
  },
  {
    pattern: /\b(en 24 horas|para ma[ñn]ana|en dos d[ií]as|urgente para hoy)\b/i,
    flag: 'UNREALISTIC_TIMELINE',
    reason: 'Plazo inviable que vulnera la metodología estratégica'
  }
];

export function detectHardStops(text: string): string[] {
  const flags: string[] = [];
  for (const { pattern, flag } of HARD_STOP_PATTERNS) {
    if (pattern.test(text)) {
      flags.push(flag);
    }
  }
  return flags;
}

export function evaluateQualification(inputs: QualificationInputs): ScoreResult {
  let serviceScore = 0;
  if (inputs.serviceNeeded && inputs.serviceNeeded.trim().length > 2) {
    const s = inputs.serviceNeeded.toLowerCase();
    if (s.includes('rebranding') || s.includes('identidad') || s.includes('cero') || s.includes('arquitectura')) {
      serviceScore = 2;
    } else {
      serviceScore = 1;
    }
  }

  let problemScore = 0;
  if (inputs.businessProblem && inputs.businessProblem.trim().length > 5) {
    problemScore = inputs.businessProblem.trim().length > 25 ? 2 : 1;
  }

  let authorityScore = 0;
  let gateAuthorityPass = true;
  const auth = inputs.decisionAuthority ? inputs.decisionAuthority.toUpperCase() : '';
  if (auth === 'A' || auth.includes('YO') || auth.includes('SOLO')) {
    authorityScore = 2;
  } else if (auth === 'B' || auth.includes('SOCIO')) {
    authorityScore = 2;
  } else if (auth === 'C') {
    authorityScore = 1;
  } else if (auth === 'D') {
    authorityScore = 0;
    gateAuthorityPass = false;
  }

  let investmentScore = 0;
  let gateInvestmentPass = true;
  const inv = inputs.investmentReadiness ? inputs.investmentReadiness.toUpperCase() : '';
  if (
    inv === 'A' ||
    inv.includes('SI') ||
    inv.includes('SÍ') ||
    inv.includes('BIEN') ||
    inv.includes('TOTALMENTE') ||
    inv.includes('CALZA') ||
    inv.includes('TENEMOS') ||
    inv.includes('ACUERDO') ||
    inv.includes('PERFECTO') ||
    inv.includes('DENTRO') ||
    inv.includes('MARGEN') ||
    inv.includes('PRESUPUESTO')
  ) {
    investmentScore = 2;
  } else if (inv === 'B' || inv.includes('AJUSTADO')) {
    investmentScore = 1;
  } else if (inv === 'C') {
    investmentScore = 1;
  } else if (inv === 'D' || inv.includes('NO') || inv.includes('CARO') || inv.includes('MUCHO')) {
    investmentScore = 0;
    gateInvestmentPass = false;
  }

  let commitmentScore = 0;
  const comm = inputs.commitmentTimeline ? inputs.commitmentTimeline.toUpperCase() : '';
  if (
    comm === 'A' ||
    comm.includes('SEMANA') ||
    comm.includes('REUNION') ||
    comm.includes('REUNIÓN') ||
    comm.includes('LLAMADA') ||
    comm.includes('AGENDAR') ||
    comm.includes('COORDINAR') ||
    comm.includes('DUDAS')
  ) {
    commitmentScore = 2;
  } else if (comm === 'B' || comm.includes('DOS SEMANAS') || comm.includes('PRÓXIMAS')) {
    commitmentScore = 1;
  } else {
    commitmentScore = 0;
  }

  const combinedText = `${inputs.serviceNeeded || ''} ${inputs.businessProblem || ''}`;
  const hardStopFlags = detectHardStops(combinedText);

  const scoreTotal = serviceScore + problemScore + authorityScore + investmentScore + commitmentScore;

  let recommendedState: 'QUALIFIED' | 'WARM' | 'NURTURE' | 'HUMAN_REVIEW';
  let statusReason = '';

  if (hardStopFlags.length > 0) {
    recommendedState = 'HUMAN_REVIEW';
    statusReason = `Detección de banderas de detención: ${hardStopFlags.join(', ')}`;
  } else if (!gateAuthorityPass) {
    recommendedState = 'NURTURE';
    statusReason = 'Gate de autoridad no superado (sin decisor claro)';
  } else if (!gateInvestmentPass) {
    recommendedState = 'NURTURE';
    statusReason = 'Gate de inversión no superado (fuera de rango)';
  } else if (scoreTotal >= 5) {
    recommendedState = 'QUALIFIED';
    statusReason = `Calificado exitosamente con score ${scoreTotal}/8`;
  } else if (scoreTotal >= 3) {
    recommendedState = 'WARM';
    statusReason = `Lead tibio (score ${scoreTotal}/8), requiere afinamiento`;
  } else {
    recommendedState = 'NURTURE';
    statusReason = `Score insuficiente (${scoreTotal}/8), derivado a nutrición`;
  }

  return {
    scoreTotal,
    scoreBreakdown: {
      serviceScore,
      problemScore,
      authorityScore,
      investmentScore,
      commitmentScore,
    },
    gateAuthorityPass,
    gateInvestmentPass,
    hardStopFlags,
    recommendedState,
    statusReason,
  };
}
