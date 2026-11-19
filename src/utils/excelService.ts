import ExcelJS from 'exceljs';
import { CompanyLegalProfile, LineItem, TenderLot, TenderProject } from '../types/btp';
import {
  BTP_TYPO_DICTIONARY,
  classifyAbcRisk,
  classifyTrade,
  computeUnitPriceHT,
  getEffectiveCoefficients,
  montantEnLettresDZD,
  normalizeItemKey,
  runDeterministicAudit,
} from './pricingEngine';
import { lookupReferenceBpu } from '../data/algeriaReference';

/**
 * Import messy .xlsx BQE file into structured Lots + LineItems + Audit Anomalies
 */
export async function importBqeFromExcel(
  file: File,
  tenderId: string,
  wilayaCode: string
): Promise<{ lots: TenderLot[]; lineItems: LineItem[]; anomalies: ReturnType<typeof runDeterministicAudit> }> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Le classeur Excel ne contient aucune feuille valide.');
  }

  const lots: TenderLot[] = [];
  const lineItems: LineItem[] = [];
  let currentLot: TenderLot | null = null;
  let lotOrder = 1;
  let itemIdx = 1;
  let footerNotes = '';

  const ensureLot = (code: string, name: string) => {
    const lot: TenderLot = {
      id: `lot_xlsx_${lotOrder}`,
      tenderId,
      code,
      name,
      orderIndex: lotOrder++,
    };
    lots.push(lot);
    currentLot = lot;
    return lot;
  };

  worksheet.eachRow((row, rowNumber) => {
    const vals = [1, 2, 3, 4, 5, 6].map((c) => {
      const cellVal = row.getCell(c).value;
      if (cellVal && typeof cellVal === 'object' && 'richText' in cellVal) {
        return (cellVal.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
      }
      if (cellVal && typeof cellVal === 'object' && 'result' in cellVal) {
        return String((cellVal as { result: unknown }).result ?? '').trim();
      }
      return String(cellVal ?? '').trim();
    });

    const nonEmpty = vals.filter((v) => v.length > 0);
    if (nonEmpty.length === 0) return;

    const joined = nonEmpty.join(' ');

    if (/(opérationnel|site occupé|cnerib|ctc|sonelgaz|protection civile|travaux de nuit)/i.test(joined) && nonEmpty.length <= 2) {
      footerNotes += ` ${joined}`;
    }

    if (/^(n°|art|article|item)/i.test(vals[0]) && /(désignation|designation|libellé)/i.test(joined)) {
      return;
    }

    if (/^lot\s*[0-9ivx]+/i.test(vals[0]) || (/^lot\s*[0-9ivx]+/i.test(vals[1]) && !vals[3])) {
      const rawLot = vals[0] || vals[1];
      const parts = rawLot.split(/[:\-–]/);
      ensureLot(parts[0].trim().toUpperCase(), (parts.slice(1).join(' ') || vals[1] || rawLot).trim());
      return;
    }

    const articleNo = vals[0] || `${lotOrder}.${itemIdx}`;
    const rawDesignation = vals[1] || vals[0];
    const unit = (vals[2] || 'U').toUpperCase();
    const qtyNum = Number(String(vals[3] || '0').replace(/\s/g, '').replace(',', '.'));
    const quantity = Number.isFinite(qtyNum) ? qtyNum : 0;

    if (!rawDesignation || rawDesignation.length < 4) return;
    if (/^(sous-total|total\s+ht|total\s+ttc|tva)/i.test(rawDesignation)) return;

    if (!currentLot) {
      ensureLot('LOT 01', 'Lot Principal (Import Excel)');
    }

    let cleanedDesignation = rawDesignation;
    for (const typo of BTP_TYPO_DICTIONARY) {
      cleanedDesignation = cleanedDesignation.replace(typo.pattern, typo.correct);
    }

    const trade = classifyTrade(cleanedDesignation, currentLot!.name);
    const refMatch = lookupReferenceBpu(cleanedDesignation, unit, wilayaCode);
    const abcClass = classifyAbcRisk(cleanedDesignation, quantity, refMatch?.debourseSecDa ?? 0);

    const debourseSecDa = abcClass === 'A' ? 0 : refMatch?.debourseSecDa ?? (abcClass === 'C' ? 1200 : 2500);
    const priceSource = abcClass === 'A' ? 'proforma_required' : 'indicative_bpu';

    lineItems.push({
      id: `li_xlsx_${itemIdx++}`,
      tenderId,
      lotId: currentLot!.id,
      articleNo,
      designation: cleanedDesignation,
      rawDesignation,
      unit,
      quantity,
      pageNumber: Math.max(1, Math.ceil(rowNumber / 35)),
      abcClass,
      trade,
      debourseSecDa,
      confidenceRangePct: abcClass === 'A' ? 0 : refMatch?.confidenceRangePct ?? 15,
      priceSource,
      normalizedKey: normalizeItemKey(cleanedDesignation, unit),
      includeInRfq: abcClass === 'A',
    });
  });

  if (lineItems.length === 0) {
    throw new Error('Aucun article BQE détecté. Colonnes attendues : N° | Désignation | Unité | Quantité.');
  }

  const anomalies = runDeterministicAudit(tenderId, lineItems, footerNotes);
  return { lots, lineItems, anomalies };
}

/**
 * Official Algerian Public Tender 4-Tab Formula-Driven Excel Export (Loi 23-12 / DP 15-247)
 *  1. BPU (Bordereau des Prix Unitaires — Chiffres + Toutes Lettres)
 *  2. DQE (Devis Quantitatif et Estimatif — Linked formulas to BPU!D{r})
 *  3. Récapitulatif (Linked lot subtotals, %, TVA, TTC, Arrêté en toutes lettres + Cachet)
 *  4. Hypothèses & Audit (Coefficients, Anomalies, Verified Supplier Quotes trail)
 */
export async function exportTenderToExcel(
  tender: TenderProject,
  includeUnitPriceInWords: boolean,
  legal?: CompanyLegalProfile
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = legal?.companyName || 'ChiffrageDZ — BTP Algérie';
  wb.created = new Date();

  const navyFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  const subHeaderFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  const zebraFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  };

  const legalBannerText = legal?.companyName
    ? `Soumissionnaire : ${legal.companyName}${legal.rc ? ` · RC : ${legal.rc}` : ''}${legal.nif ? ` · NIF : ${legal.nif}` : ''}${legal.nis ? ` · NIS : ${legal.nis}` : ''}${legal.ai ? ` · AI : ${legal.ai}` : ''}${legal.qualification ? ` · Qualif. : ${legal.qualification}` : ''}`
    : `Wilaya : ${tender.wilayaName} (${tender.wilayaCode}) · Maître d'Ouvrage : ${tender.clientName}`;

  // =========================================================================
  // SHEET 1: BPU (BORDEREAU DES PRIX UNITAIRES — Chiffres & Toutes Lettres)
  // =========================================================================
  const wsBpu = wb.addWorksheet('BPU', { views: [{ state: 'frozen', ySplit: 5 }] });
  wsBpu.mergeCells('A1:E1');
  wsBpu.getCell('A1').value = `BORDEREAU DES PRIX UNITAIRES (BPU) — ${tender.reference}`;
  wsBpu.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  wsBpu.getCell('A1').fill = navyFill;
  wsBpu.getRow(1).height = 28;

  wsBpu.mergeCells('A2:E2');
  wsBpu.getCell('A2').value = `Objet : ${tender.title}`;
  wsBpu.getCell('A2').font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };

  wsBpu.mergeCells('A3:E3');
  wsBpu.getCell('A3').value = legalBannerText;
  wsBpu.getCell('A3').font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF475569' } };

  const bpuHeader = wsBpu.getRow(5);
  bpuHeader.values = [
    'N° Art.',
    'Désignation des Ouvrages (Officiel BQE)',
    'Unité',
    'Prix Unitaire HT (En Chiffres DA)',
    'Prix Unitaire HT (En Toutes Lettres)',
  ];
  bpuHeader.height = 24;
  bpuHeader.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = navyFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });

  wsBpu.columns = [
    { width: 11 },
    { width: 54 },
    { width: 9 },
    { width: 22 },
    { width: 52 },
  ];

  // Track exact BPU row number per LineItem so DQE can reference =BPU!D{row}
  const bpuRowByItemId = new Map<string, number>();
  let bpuRowIdx = 6;

  for (const lot of tender.lots) {
    const lotItems = tender.lineItems.filter((li) => li.lotId === lot.id);
    const coeff = getEffectiveCoefficients(tender, lot);

    wsBpu.mergeCells(bpuRowIdx, 1, bpuRowIdx, 5);
    const lRow = wsBpu.getRow(bpuRowIdx);
    lRow.getCell(1).value = `${lot.code} — ${lot.name}`;
    lRow.getCell(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
    lRow.getCell(1).fill = subHeaderFill;
    lRow.height = 22;
    bpuRowIdx++;

    lotItems.forEach((item, i) => {
      const puHt =
        item.priceSource === 'proforma_required' && item.debourseSecDa <= 0
          ? 0
          : computeUnitPriceHT(item.debourseSecDa, coeff);

      const r = wsBpu.getRow(bpuRowIdx);
      r.values = [
        item.articleNo,
        item.rawDesignation,
        item.unit,
        puHt,
        puHt > 0 ? montantEnLettresDZD(puHt) : 'À compléter (Proforma requis)',
      ];
      r.height = 30;
      r.eachCell((cell, col) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = thinBorder;
        if (i % 2 === 1) cell.fill = zebraFill;
        if (col === 1 || col === 3) cell.alignment = { vertical: 'middle', horizontal: 'center' };
        else if (col === 4) cell.alignment = { vertical: 'middle', horizontal: 'right' };
        else cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      });
      r.getCell(4).numFmt = '#,##0.00 "DA"';
      bpuRowByItemId.set(item.id, bpuRowIdx);
      bpuRowIdx++;
    });

    bpuRowIdx++;
  }

  // =========================================================================
  // SHEET 2: DQE (DEVIS QUANTITATIF ET ESTIMATIF — Linked to BPU!)
  // =========================================================================
  const wsDqe = wb.addWorksheet('DQE', { views: [{ state: 'frozen', ySplit: 5 }] });
  const totalCols = includeUnitPriceInWords ? 8 : 7;

  wsDqe.mergeCells(1, 1, 1, totalCols);
  wsDqe.getCell(1, 1).value = `DEVIS QUANTITATIF ET ESTIMATIF (DQE) — ${tender.reference}`;
  wsDqe.getCell(1, 1).font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  wsDqe.getCell(1, 1).fill = navyFill;
  wsDqe.getRow(1).height = 28;

  wsDqe.mergeCells(2, 1, 2, totalCols);
  wsDqe.getCell(2, 1).value = `Objet : ${tender.title}  |  Maître d'Ouvrage : ${tender.clientName}`;
  wsDqe.getCell(2, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };

  wsDqe.mergeCells(3, 1, 3, totalCols);
  wsDqe.getCell(3, 1).value = legalBannerText;
  wsDqe.getCell(3, 1).font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF475569' } };

  const headers = includeUnitPriceInWords
    ? ['N° Art.', 'Désignation des Ouvrages (BQE Officiel)', 'Unité', 'Quantité', 'PU HT (DA)', 'Prix Unitaire en Toutes Lettres', 'Montant Total (DA HT)', 'Source / Statut']
    : ['N° Art.', 'Désignation des Ouvrages (BQE Officiel)', 'Unité', 'Quantité', 'PU HT (DA)', 'Montant Total (DA HT)', 'Source / Statut'];

  const headerRow = wsDqe.getRow(5);
  headerRow.values = headers;
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = navyFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });

  wsDqe.columns = includeUnitPriceInWords
    ? [
        { width: 11 },
        { width: 52 },
        { width: 9 },
        { width: 12 },
        { width: 19 },
        { width: 42 },
        { width: 22 },
        { width: 18 },
      ]
    : [
        { width: 11 },
        { width: 56 },
        { width: 9 },
        { width: 12 },
        { width: 19 },
        { width: 22 },
        { width: 18 },
      ];

  const amountColLetter = includeUnitPriceInWords ? 'G' : 'F';
  const lotSubtotalRows: Array<{ lot: TenderLot; rowNumber: number }> = [];
  let rowIdx = 6;

  for (const lot of tender.lots) {
    const lotItems = tender.lineItems.filter((li) => li.lotId === lot.id);

    wsDqe.mergeCells(rowIdx, 1, rowIdx, totalCols);
    const lotRow = wsDqe.getRow(rowIdx);
    lotRow.getCell(1).value = `${lot.code} — ${lot.name}`;
    lotRow.getCell(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
    lotRow.getCell(1).fill = subHeaderFill;
    lotRow.height = 22;
    rowIdx++;

    const firstItemRow = rowIdx;

    for (let i = 0; i < lotItems.length; i++) {
      const item = lotItems[i];
      const bpuRefRow = bpuRowByItemId.get(item.id);

      const sourceLabel =
        item.priceSource === 'supplier_verified'
          ? 'Devis Vérifié'
          : item.priceSource === 'private_bpu'
          ? 'BPU Privé'
          : item.priceSource === 'proforma_required'
          ? 'Proforma Requis'
          : 'Estimé';

      const r = wsDqe.getRow(rowIdx);
      const puFormula = bpuRefRow ? { formula: `BPU!D${bpuRefRow}` } : 0;
      const wordsFormula = bpuRefRow ? { formula: `BPU!E${bpuRefRow}` } : '';

      if (includeUnitPriceInWords) {
        r.values = [
          item.articleNo,
          item.rawDesignation,
          item.unit,
          item.quantity,
          puFormula,
          wordsFormula,
          { formula: `D${rowIdx}*E${rowIdx}` },
          sourceLabel,
        ];
      } else {
        r.values = [
          item.articleNo,
          item.rawDesignation,
          item.unit,
          item.quantity,
          puFormula,
          { formula: `D${rowIdx}*E${rowIdx}` },
          sourceLabel,
        ];
      }

      r.height = 28;
      r.eachCell((cell, colNum) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = thinBorder;
        if (i % 2 === 1) cell.fill = zebraFill;
        if (colNum === 1 || colNum === 3 || colNum === totalCols) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNum === 2 || (includeUnitPriceInWords && colNum === 6)) {
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
        }
      });

      r.getCell(4).numFmt = '#,##0.00';
      r.getCell(5).numFmt = '#,##0.00 "DA"';
      r.getCell(includeUnitPriceInWords ? 7 : 6).numFmt = '#,##0.00 "DA"';
      rowIdx++;
    }

    const lastItemRow = rowIdx - 1;
    const subRow = wsDqe.getRow(rowIdx);
    const amountColIdx = includeUnitPriceInWords ? 7 : 6;
    wsDqe.mergeCells(rowIdx, 1, rowIdx, amountColIdx - 1);
    subRow.getCell(1).value = `SOUS-TOTAL ${lot.code} (DA HT)`;
    subRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    subRow.getCell(amountColIdx).value =
      lastItemRow >= firstItemRow
        ? { formula: `SUM(${amountColLetter}${firstItemRow}:${amountColLetter}${lastItemRow})` }
        : 0;
    subRow.getCell(amountColIdx).numFmt = '#,##0.00 "DA"';
    subRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.border = thinBorder;
    });
    subRow.height = 22;

    lotSubtotalRows.push({ lot, rowNumber: rowIdx });
    rowIdx += 2;
  }

  // =========================================================================
  // SHEET 3: RÉCAPITULATIF GÉNÉRAL (Linked Formulas + Legal Signature Block)
  // =========================================================================
  const wsRecap = wb.addWorksheet('Récapitulatif');
  wsRecap.mergeCells('A1:D1');
  wsRecap.getCell('A1').value = `RÉCAPITULATIF FINANCIER — ${tender.reference}`;
  wsRecap.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  wsRecap.getCell('A1').fill = navyFill;
  wsRecap.getRow(1).height = 28;

  wsRecap.mergeCells('A2:D2');
  wsRecap.getCell('A2').value = legalBannerText;
  wsRecap.getCell('A2').font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF475569' } };

  wsRecap.getRow(4).values = ['Code Lot', 'Désignation du Lot', 'Montant (DA HT)', '% du Total HT'];
  wsRecap.getRow(4).height = 24;
  wsRecap.getRow(4).eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = navyFill;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });

  wsRecap.columns = [
    { width: 14 },
    { width: 52 },
    { width: 24 },
    { width: 16 },
  ];

  const recapStart = 5;
  const totalHtRowNum = recapStart + lotSubtotalRows.length;

  lotSubtotalRows.forEach((entry, idx) => {
    const rNum = recapStart + idx;
    const r = wsRecap.getRow(rNum);
    r.values = [
      entry.lot.code,
      entry.lot.name,
      { formula: `DQE!${amountColLetter}${entry.rowNumber}` },
      { formula: `IF($C$${totalHtRowNum}>0, C${rNum}/$C$${totalHtRowNum}, 0)` },
    ];
    r.height = 22;
    r.eachCell((cell, col) => {
      cell.border = thinBorder;
      cell.font = { name: 'Calibri', size: 10 };
      if (col === 3) cell.numFmt = '#,##0.00 "DA"';
      if (col === 4) cell.numFmt = '0.0%';
    });
  });

  const rHt = wsRecap.getRow(totalHtRowNum);
  rHt.values = ['', 'TOTAL GÉNÉRAL EN HORS TAXES (DA HT)', { formula: `SUM(C${recapStart}:C${totalHtRowNum - 1})` }, 1];
  rHt.getCell(3).numFmt = '#,##0.00 "DA"';
  rHt.getCell(4).numFmt = '0.0%';
  rHt.eachCell((c) => {
    c.font = { name: 'Calibri', size: 11, bold: true };
    c.fill = subHeaderFill;
    c.border = thinBorder;
  });
  rHt.height = 24;

  const tvaRowNum = totalHtRowNum + 1;
  const rTva = wsRecap.getRow(tvaRowNum);
  rTva.values = ['', `TVA (${tender.tvaRate}%)`, { formula: `C${totalHtRowNum}*${tender.tvaRate / 100}` }, ''];
  rTva.getCell(3).numFmt = '#,##0.00 "DA"';
  rTva.eachCell((c) => {
    c.font = { name: 'Calibri', size: 10, bold: true };
    c.border = thinBorder;
  });
  rTva.height = 22;

  const ttcRowNum = totalHtRowNum + 2;
  const rTtc = wsRecap.getRow(ttcRowNum);
  rTtc.values = ['', 'MONTANT TOTAL TOUTES TAXES COMPRISES (DA TTC)', { formula: `C${totalHtRowNum}+C${tvaRowNum}` }, ''];
  rTtc.getCell(3).numFmt = '#,##0.00 "DA"';
  rTtc.eachCell((c) => {
    c.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = navyFill;
    c.border = thinBorder;
  });
  rTtc.height = 26;

  let computedHt = 0;
  for (const lot of tender.lots) {
    const coeff = getEffectiveCoefficients(tender, lot);
    for (const item of tender.lineItems.filter((li) => li.lotId === lot.id)) {
      if (item.priceSource === 'proforma_required' && item.debourseSecDa <= 0) continue;
      computedHt += computeUnitPriceHT(item.debourseSecDa, coeff) * item.quantity;
    }
  }
  const computedTtc = Math.round(computedHt * (1 + tender.tvaRate / 100) * 100) / 100;

  const wordsRowNum = ttcRowNum + 2;
  wsRecap.mergeCells(`A${wordsRowNum}:D${wordsRowNum}`);
  wsRecap.getCell(`A${wordsRowNum}`).value = `Arrêté le présent devis quantitatif et estimatif à la somme en TTC de : ${montantEnLettresDZD(computedTtc)}.`;
  wsRecap.getCell(`A${wordsRowNum}`).font = { name: 'Calibri', size: 11, bold: true, italic: true, color: { argb: 'FF0F172A' } };
  wsRecap.getCell(`A${wordsRowNum}`).alignment = { wrapText: true, vertical: 'middle' };
  wsRecap.getRow(wordsRowNum).height = 36;

  const sigRow = wordsRowNum + 2;
  wsRecap.mergeCells(`C${sigRow}:D${sigRow}`);
  wsRecap.getCell(`C${sigRow}`).value = `Fait à ${tender.wilayaName}, le ${new Date().toLocaleDateString('fr-DZ')}`;
  wsRecap.getCell(`C${sigRow}`).alignment = { horizontal: 'center' };
  wsRecap.mergeCells(`C${sigRow + 1}:D${sigRow + 1}`);
  wsRecap.getCell(`C${sigRow + 1}`).value = `Le Soumissionnaire (Nom, Prénom, Qualité, Cachet et Signature)`;
  wsRecap.getCell(`C${sigRow + 1}`).font = { bold: true, size: 10 };
  wsRecap.getCell(`C${sigRow + 1}`).alignment = { horizontal: 'center' };

  // =========================================================================
  // SHEET 4: HYPOTHÈSES & AUDIT
  // =========================================================================
  const wsAudit = wb.addWorksheet('Hypothèses & Audit');
  wsAudit.mergeCells('A1:E1');
  wsAudit.getCell('A1').value = `HYPOTHÈSES DE CHIFFRAGE & JOURNAL D'AUDIT — ${tender.reference}`;
  wsAudit.getCell('A1').font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  wsAudit.getCell('A1').fill = navyFill;
  wsAudit.getRow(1).height = 26;

  wsAudit.columns = [{ width: 24 }, { width: 34 }, { width: 16 }, { width: 16 }, { width: 44 }];
  wsAudit.getRow(3).values = ['Paramètre Global', 'Valeur', 'Formule', '', 'Notes'];
  wsAudit.getRow(3).font = { bold: true };
  wsAudit.getRow(4).values = ['Wilaya du chantier', `${tender.wilayaName} (${tender.wilayaCode})`, '', '', 'Indexation transport & main-d\'œuvre'];
  wsAudit.getRow(5).values = ['Transport / Wilaya (%)', `${tender.globalTransportPct}%`, '', '', 'Coefficient global'];
  wsAudit.getRow(6).values = ['Site Occupé (%)', `${tender.globalOccupiedSitePct}%`, '', '', 'Clause opérationnelle pied de page'];
  wsAudit.getRow(7).values = ['Frais Généraux (%)', `${tender.globalOverheadPct}%`, '', '', 'Encadrement, essais CTC/CNERIB'];
  wsAudit.getRow(8).values = ['Marge / Bénéfice (%)', `${tender.globalMarginPct}%`, 'PU HT = DS × (1 + Σ%)', '', 'Bénéfice net cible'];
  wsAudit.getRow(9).values = ['Identification Fiscale', legalBannerText, '', '', 'En-tête officiel soumission'];

  wsAudit.getRow(11).values = ['Type Anomalie', 'Titre', 'Sévérité', 'Statut', 'Description'];
  wsAudit.getRow(11).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = navyFill;
  });

  tender.anomalies.forEach((a, i) => {
    const r = wsAudit.getRow(12 + i);
    r.values = [a.type, a.title, a.severity.toUpperCase(), a.resolved ? 'RÉSOLU' : 'OUVERT', a.description];
    r.eachCell((c) => {
      c.border = thinBorder;
      c.alignment = { wrapText: true, vertical: 'top' };
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `Soumission_BPU_DQE_${tender.reference.replace(/[^a-zA-Z0-9_-]/g, '_')}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
