import {
  AbcClass,
  AnomalyFlag,
  CostCoefficients,
  LineItem,
  PrivateBpuEntry,
  TenderLot,
  TenderProject,
  TradeCategory,
} from '../types/btp';

/**
 * Algerian BTP OCR & Typo Normalization Dictionary
 */
export const BTP_TYPO_DICTIONARY: Array<{ pattern: RegExp; correct: string; label: string }> = [
  { pattern: /\bflein[\s-]*koot\b/gi, correct: 'Flinkote (émulsion bitumineuse)', label: 'Flein-koot → Flinkote' },
  { pattern: /\balucobande\b/gi, correct: 'Alucobond (panneau composite aluminium)', label: 'Alucobande → Alucobond' },
  { pattern: /\bkut[\s-]*bak\b/gi, correct: 'Cut-back (bitume fluidifié)', label: 'Kut bak → Cut-back' },
  { pattern: /\bschnedir\b/gi, correct: 'Schneider Electric', label: 'SCHNEDIR → Schneider Electric' },
  { pattern: /\blegrnd\b/gi, correct: 'Legrand', label: 'LEGRND → Legrand' },
  { pattern: /\bpax[\s-]*alumin\b/gi, correct: 'Paxalumin', label: 'Pax alumin → Paxalumin' },
  { pattern: /\bgeotextil\b/gi, correct: 'Géotextile', label: 'Geotextil → Géotextile' },
  { pattern: /\betancheite\b/gi, correct: 'Étanchéité', label: 'Etancheite → Étanchéité' },
];

export function normalizeItemKey(designation: string, unit: string): string {
  const cleaned = designation
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(f\/p|fourniture|et|pose|de|du|des|la|le|les|en|pour|avec|sur|par|type|compris|toutes|sujetions)\b/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  const cleanUnit = unit.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${cleaned || 'article'}_${cleanUnit || 'U'}`;
}

/**
 * Resolve effective Cost-to-Bid coefficients for a given lot (global + per-lot overrides)
 */
export function getEffectiveCoefficients(
  tender: Pick<TenderProject, 'globalTransportPct' | 'globalOccupiedSitePct' | 'globalOverheadPct' | 'globalMarginPct'>,
  lot?: TenderLot | null
): CostCoefficients {
  return {
    transportPct: lot?.overrideTransportPct ?? tender.globalTransportPct,
    occupiedSitePct: lot?.overrideOccupiedSitePct ?? tender.globalOccupiedSitePct,
    overheadPct: lot?.overrideOverheadPct ?? tender.globalOverheadPct,
    marginPct: lot?.overrideMarginPct ?? tender.globalMarginPct,
  };
}

/**
 * Core Cost-to-Bid Formula:
 * Unit Price (DA HT) = Déboursé Sec × (1 + Transport/Wilaya% + Occupied_Site% + Overhead% + Margin%)
 */
export function computeUnitPriceHT(debourseSecDa: number, coeff: CostCoefficients): number {
  if (!debourseSecDa || debourseSecDa <= 0) return 0;
  const multiplier =
    1 +
    (coeff.transportPct + coeff.occupiedSitePct + coeff.overheadPct + coeff.marginPct) / 100;
  return Math.round(debourseSecDa * multiplier * 100) / 100;
}

export function computeLineTotalHT(item: LineItem, coeff: CostCoefficients): number {
  if (item.priceSource === 'proforma_required' && item.debourseSecDa <= 0) return 0;
  const unitPrice = computeUnitPriceHT(item.debourseSecDa, coeff);
  return Math.round(unitPrice * item.quantity * 100) / 100;
}

export function computeTenderFinancials(tender: TenderProject) {
  const lotMap = new Map(tender.lots.map((l) => [l.id, l]));
  const lotTotals: Record<string, { totalHt: number; itemCount: number; verifiedCount: number; blockedCount: number }> = {};

  for (const lot of tender.lots) {
    lotTotals[lot.id] = { totalHt: 0, itemCount: 0, verifiedCount: 0, blockedCount: 0 };
  }

  let totalHt = 0;
  let totalDebourseSec = 0;
  let classATotal = 0;
  let classBTotal = 0;
  let classCTotal = 0;
  let verifiedCount = 0;
  let proformaRequiredCount = 0;
  let estimatedCount = 0;

  for (const item of tender.lineItems) {
    const lot = lotMap.get(item.lotId);
    const coeff = getEffectiveCoefficients(tender, lot);
    const lineTotal = computeLineTotalHT(item, coeff);
    const lineDs = item.debourseSecDa * item.quantity;

    totalHt += lineTotal;
    totalDebourseSec += lineDs;

    if (item.abcClass === 'A') classATotal += lineTotal;
    else if (item.abcClass === 'B') classBTotal += lineTotal;
    else classCTotal += lineTotal;

    if (item.priceSource === 'supplier_verified' || item.priceSource === 'private_bpu') {
      verifiedCount++;
    } else if (item.priceSource === 'proforma_required') {
      proformaRequiredCount++;
    } else {
      estimatedCount++;
    }

    if (lotTotals[item.lotId]) {
      lotTotals[item.lotId].totalHt += lineTotal;
      lotTotals[item.lotId].itemCount += 1;
      if (item.priceSource === 'supplier_verified' || item.priceSource === 'private_bpu') {
        lotTotals[item.lotId].verifiedCount += 1;
      }
      if (item.priceSource === 'proforma_required') {
        lotTotals[item.lotId].blockedCount += 1;
      }
    }
  }

  const tvaAmount = Math.round(totalHt * (tender.tvaRate / 100) * 100) / 100;
  const totalTtc = Math.round((totalHt + tvaAmount) * 100) / 100;
  const openCriticalAnomalies = tender.anomalies.filter((a) => !a.resolved && a.severity === 'critical').length;
  const openAnomalies = tender.anomalies.filter((a) => !a.resolved).length;

  return {
    totalHt,
    totalDebourseSec,
    tvaAmount,
    totalTtc,
    lotTotals,
    classATotal,
    classBTotal,
    classCTotal,
    verifiedCount,
    proformaRequiredCount,
    estimatedCount,
    totalItems: tender.lineItems.length,
    openCriticalAnomalies,
    openAnomalies,
  };
}

/**
 * Deterministic Trade Classifier for Algerian BTP Line Items
 */
export function classifyTrade(designation: string, lotName = ''): TradeCategory {
  const txt = `${designation} ${lotName}`.toLowerCase();
  if (/(groupe|électrogène|electrogene|transformateur|tgbt|onduleur|ups|câble|cable|disjoncteur|schneider|legrand|luminaire|led|prise|tableau|électri|electri)/i.test(txt)) {
    return 'Électricité & Groupe';
  }
  if (/(chaudière|chaudiere|chauffage|radiateur|climatiseur|clim|split|vrf|cta|groupe froid|ventilation|vmc|kcal|btu|cvc)/i.test(txt)) {
    return 'Chauffage & Clim';
  }
  if (/(enrobé|enrobe|tvo|tout venant|bordure|trottoir|voirie|vrd|terrassement|assainissement|regard|buse|pehd|tranchée|cut-back|kut bak)/i.test(txt)) {
    return 'VRD & Voirie';
  }
  if (/(plomberie|ppr|pvc|vanne|robinet|siphon|sanitaire|ria|extincteur|incendie|bâche à eau|surpresseur|pn06|pn10|pn16)/i.test(txt)) {
    return 'Plomberie & Incendie';
  }
  if (/(étanchéité|etancheite|sbs|paxalumin|flinkote|flein-koot|alucobond|alucobande|mur rideau|bardage|façade|facade|polystyrène|forme de pente)/i.test(txt)) {
    return 'Étanchéité & Façade';
  }
  return 'Gros Œuvre & Revêtements';
}

/**
 * Deterministic ABC (80/20) Risk Classifier
 */
export function classifyAbcRisk(designation: string, quantity: number, estimatedUnitDs = 0): AbcClass {
  const txt = designation.toLowerCase();
  // Class A: High-cost imported equipment & major civil works
  if (
    /(groupe électrogène|groupe electrogene|kva|transformateur|tgbt|chaudière|chaudiere|kcal|onduleur|ups|vrf|cta|chiller|ascenseur|mur rideau|alucobond|alucobande|enrobé|enrobe|béton bitumineux|surpresseur|centrale incendie|groupe froid)/i.test(
      txt
    )
  ) {
    return 'A';
  }
  if (estimatedUnitDs * quantity >= 1_200_000) {
    return 'A';
  }
  // Class C: Low-impact fittings & accessories
  if (
    /(siphon|vanne d'arrêt|robinet|butoir|butée|serrure|grille de ventilation|boîte de dérivation|collier|manchon|coude|té |bouchon|accessoire|patère|porte-papier|miroir)/i.test(
      txt
    )
  ) {
    return 'C';
  }
  return 'B';
}

/**
 * Deterministic Anomaly Auditor for BQE rows (works on both Gemini extractions and Excel imports)
 */
export function runDeterministicAudit(
  tenderId: string,
  items: LineItem[],
  footerNotes = ''
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  let idx = 1;

  for (const item of items) {
    const u = item.unit.trim().toUpperCase();
    const d = item.designation.toLowerCase();

    // 1. Truncated / Missing Fragment check
    if (!item.quantity || item.quantity <= 0 || item.designation.trim().length < 12 || /suite\s+page|\.\.\.$|voir\s+ci-contre/i.test(item.designation)) {
      flags.push({
        id: `anom_${tenderId}_${idx++}`,
        tenderId,
        lineItemId: item.id,
        type: 'truncated_fragment',
        severity: 'critical',
        title: `Article ${item.articleNo} tronqué ou quantité manquante`,
        description: `Désignation incomplète ou quantité nulle (Qté = ${item.quantity}) détectée sur la page ${item.pageNumber}. Vérifier la coupure de page dans le BQE original.`,
        pageNumber: item.pageNumber,
        resolved: false,
      });
    }

    // 2. Unit/Quantity Anomaly check (e.g. M3 for cladding/Alucobond/waterproofing/paint/tiles)
    if (
      (u === 'M3' || u === 'M³') &&
      /(alucobond|alucobande|bardage|étanchéité|etancheite|sbs|peinture|carrelage|faïence|faience|dalle de sol|faux plafond|enduit|flinkote|flein-koot)/i.test(d)
    ) {
      flags.push({
        id: `anom_${tenderId}_${idx++}`,
        tenderId,
        lineItemId: item.id,
        type: 'unit_anomaly',
        severity: 'critical',
        title: `Anomalie d'unité (${u} au lieu de M2) — Art. ${item.articleNo}`,
        description: `L'article "${item.designation.slice(0, 80)}..." utilise l'unité ${u} alors que le standard BTP pour le bardage/revêtement/étanchéité est le M2. Risque majeur d'écart financier.`,
        pageNumber: item.pageNumber,
        suggestedUnit: 'M2',
        resolved: false,
      });
    }

    // 3. OCR Typo check
    for (const entry of BTP_TYPO_DICTIONARY) {
      if (entry.pattern.test(item.rawDesignation)) {
        flags.push({
          id: `anom_${tenderId}_${idx++}`,
          tenderId,
          lineItemId: item.id,
          type: 'ocr_typo',
          severity: 'info',
          title: `Artéfact OCR BTP détecté (${entry.label}) — Art. ${item.articleNo}`,
          description: `Terme scanné normalisé pour le matching BPU tout en conservant l'intitulé officiel du BQE pour l'export de soumission.`,
          pageNumber: item.pageNumber,
          suggestedFixText: entry.correct,
          resolved: false,
        });
      }
    }
  }

  // 4. Hidden Cost Clauses in footers/headers
  const combinedText = `${footerNotes} ${items.map((i) => i.rawDesignation).join(' ')}`;
  if (/(opérationnel|operationnel|site occupé|site occupe|locaux.*activité|travaux de nuit|horaires décalés)/i.test(combinedText)) {
    flags.push({
      id: `anom_${tenderId}_${idx++}`,
      tenderId,
      type: 'hidden_cost_clause',
      severity: 'critical',
      title: 'Clause cachée : Travaux en site occupé / locaux opérationnels',
      description: `Clause détectée : "Les locaux resteront opérationnels durant toute la durée des travaux". Impact direct sur la productivité main-d'œuvre, le phasage et le nettoyage quotidien.`,
      pageNumber: 1,
      suggestedMultiplierPct: 8,
      clauseTag: 'Site Occupé (+8%)',
      resolved: false,
    });
  }

  const certs = ['CNERIB', 'CTC', 'Protection Civile', 'Sonelgaz'].filter((c) =>
    new RegExp(c, 'i').test(combinedText)
  );
  if (certs.length > 0) {
    flags.push({
      id: `anom_${tenderId}_${idx++}`,
      tenderId,
      type: 'hidden_cost_clause',
      severity: 'warning',
      title: `Exigences d'agrément & contrôle (${certs.join(', ')})`,
      description: `Le cahier des charges impose des essais, agréments ou validations techniques (${certs.join(' / ')}). Prévoir les frais d'essais laboratoire et dossiers d'homologation dans les frais généraux.`,
      pageNumber: 1,
      suggestedMultiplierPct: 3,
      clauseTag: certs.join(' · '),
      resolved: false,
    });
  }

  return flags;
}

/**
 * Match a LineItem against Contractor Private BPU entries
 */
export function matchPrivateBpu(
  item: LineItem,
  bpuEntries: PrivateBpuEntry[],
  wilayaCode: string
): PrivateBpuEntry | null {
  if (!bpuEntries.length) return null;
  const itemTokens = new Set(item.normalizedKey.split('_').filter((t) => t.length >= 3));
  let best: { entry: PrivateBpuEntry; score: number } | null = null;

  for (const entry of bpuEntries) {
    if (entry.unit.toUpperCase() !== item.unit.toUpperCase()) continue;
    const entryTokens = entry.normalizedItemKey.split('_').filter((t) => t.length >= 3);
    if (!entryTokens.length) continue;

    let overlap = 0;
    for (const tok of entryTokens) {
      if (itemTokens.has(tok)) overlap++;
    }
    const jaccard = overlap / Math.max(1, new Set([...itemTokens, ...entryTokens]).size);
    const wilayaBonus = entry.wilayaCode === wilayaCode ? 0.15 : 0;
    const score = jaccard + wilayaBonus;
    if (score >= 0.45 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best ? best.entry : null;
}

/**
 * Format DA currency cleanly with tabular precision
 */
export function formatDZD(amount: number, decimals = 2): string {
  return new Intl.NumberFormat('fr-DZ', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/**
 * Convert numeric amount (DZD) into official French legal text ("en toutes lettres")
 * Example: 2 450 320,50 -> "Deux millions quatre cent cinquante mille trois cent vingt dinars algériens et cinquante centimes"
 */
export function montantEnLettresDZD(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return 'Zéro dinar algérien';

  const rounded = Math.round(amount * 100);
  const dinars = Math.floor(rounded / 100);
  const centimes = rounded % 100;

  const units = [
    '', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
    'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
    'dix-sept', 'dix-huit', 'dix-neuf',
  ];
  const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

  function under100(n: number): string {
    if (n < 20) return units[n];
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (t === 7 || t === 9) {
      const rem = 10 + u;
      if (t === 7 && u === 1) return 'soixante et onze';
      return `${tens[t]}-${units[rem]}`;
    }
    if (u === 0) {
      return t === 8 ? 'quatre-vingts' : tens[t];
    }
    if (u === 1 && t !== 8) {
      return `${tens[t]} et un`;
    }
    return `${tens[t]}-${units[u]}`;
  }

  function under1000(n: number): string {
    if (n === 0) return '';
    const h = Math.floor(n / 100);
    const rem = n % 100;
    let res = '';
    if (h === 1) {
      res = 'cent';
    } else if (h > 1) {
      res = `${units[h]} cent${rem === 0 ? 's' : ''}`;
    }
    if (rem > 0) {
      res = res ? `${res} ${under100(rem)}` : under100(rem);
    }
    return res;
  }

  function intToFrench(n: number): string {
    if (n === 0) return 'zéro';
    const parts: string[] = [];

    const milliards = Math.floor(n / 1_000_000_000);
    if (milliards > 0) {
      parts.push(`${under1000(milliards)} milliard${milliards > 1 ? 's' : ''}`);
      n %= 1_000_000_000;
    }

    const millions = Math.floor(n / 1_000_000);
    if (millions > 0) {
      parts.push(`${under1000(millions)} million${millions > 1 ? 's' : ''}`);
      n %= 1_000_000;
    }

    const milliers = Math.floor(n / 1000);
    if (milliers > 0) {
      parts.push(milliers === 1 ? 'mille' : `${under1000(milliers)} mille`);
      n %= 1000;
    }

    if (n > 0) {
      parts.push(under1000(n));
    }

    return parts.join(' ');
  }

  const dinarWords = intToFrench(dinars);
  const dinarUnit = dinars <= 1 ? 'dinar algérien' : 'dinars algériens';
  let result = `${dinarWords} ${dinarUnit}`;

  if (centimes > 0) {
    result += ` et ${intToFrench(centimes)} centime${centimes > 1 ? 's' : ''}`;
  }

  return result.charAt(0).toUpperCase() + result.slice(1);
}
