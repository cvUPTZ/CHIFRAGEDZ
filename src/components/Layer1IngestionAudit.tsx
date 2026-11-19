import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FileUp,
  Info,
  Loader2,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  AnomalyFlag,
  AppLang,
  LineItem,
  PrivateBpuEntry,
  TenderLot,
  TenderProject,
  TradeCategory,
} from '../types/btp';
import { UI_COPY } from '../data/i18n';
import { importBqeFromExcel } from '../utils/excelService';
import {
  classifyAbcRisk,
  classifyTrade,
  matchPrivateBpu,
  normalizeItemKey,
  runDeterministicAudit,
} from '../utils/pricingEngine';

interface Props {
  tender: TenderProject;
  privateBpu: PrivateBpuEntry[];
  lang: AppLang;
  isLocked?: boolean;
  getAuthToken: () => Promise<string | null>;
  onReplaceExtractedData: (payload: {
    title?: string;
    reference?: string;
    clientName?: string;
    lots: TenderLot[];
    lineItems: LineItem[];
    anomalies: AnomalyFlag[];
  }) => Promise<void> | void;
  onResolveAnomaly: (anomalyId: string) => void;
  onFixItemUnit: (lineItemId: string, newUnit: string, anomalyId: string) => void;
  onFixItemQuantity: (lineItemId: string, newQty: number, anomalyId: string) => void;
  onApplySiteMultiplier: (multiplierPct: number, anomalyId: string, isOverhead?: boolean) => void;
  onGoToPricing: () => void;
}

interface QueuedFile {
  id: string;
  file: File;
  name: string;
  type: 'pdf_image' | 'excel';
  sizeKb: number;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Impossible de lire le fichier.'));
    reader.readAsDataURL(file);
  });
}

export const Layer1IngestionAudit: React.FC<Props> = ({
  tender,
  privateBpu,
  lang,
  isLocked = false,
  getAuthToken,
  onReplaceExtractedData,
  onResolveAnomaly,
  onFixItemUnit,
  onFixItemQuantity,
  onApplySiteMultiplier,
  onGoToPricing,
}) => {
  const t = UI_COPY[lang];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
  const [reverseOrder, setReverseOrder] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [chunkProgress, setChunkProgress] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractBanner, setExtractBanner] = useState<string | null>(null);
  const [anomalyFilter, setAnomalyFilter] = useState<'all' | 'open' | 'critical'>('open');
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || isLocked) return;
    setExtractError(null);
    const next: QueuedFile[] = [];
    Array.from(fileList).forEach((f, idx) => {
      const isExcel = /\.(xlsx|xls)$/i.test(f.name);
      next.push({
        id: `qf_${Date.now()}_${idx}`,
        file: f,
        name: f.name,
        type: isExcel ? 'excel' : 'pdf_image',
        sizeKb: Math.max(1, Math.round(f.size / 1024)),
      });
    });
    setQueuedFiles((prev) => [...prev, ...next]);
  };

  const removeQueuedFile = (id: string) => {
    setQueuedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleRunExtraction = async () => {
    if (queuedFiles.length === 0 || isLocked) return;
    setIsExtracting(true);
    setExtractError(null);
    setExtractBanner(null);
    setChunkProgress(null);

    try {
      const excelFile = queuedFiles.find((q) => q.type === 'excel');
      if (excelFile) {
        const result = await importBqeFromExcel(
          excelFile.file,
          tender.id,
          tender.wilayaCode,
          privateBpu
        );
        await onReplaceExtractedData({
          lots: result.lots,
          lineItems: result.lineItems,
          anomalies: result.anomalies,
        });
        setExtractBanner(
          lang === 'ar'
            ? `تم استيراد ${result.lineItems.length} بنداً من ملف Excel وكشف ${result.anomalies.length} ملاحظات تدقيق.`
            : `${result.lineItems.length} articles extraits depuis ${excelFile.name} avec ${result.anomalies.length} points d'audit détectés.`
        );
        setQueuedFiles([]);
        return;
      }

      // Chunk multi-page CamScanner packs into batches of 4 files to prevent timeout & payload limits
      const orderedQueue = reverseOrder ? [...queuedFiles].reverse() : [...queuedFiles];
      const CHUNK_SIZE = 4;
      const totalChunks = Math.ceil(orderedQueue.length / CHUNK_SIZE);
      const idToken = await getAuthToken();

      const lotsByCode = new Map<string, TenderLot>();
      const lots: TenderLot[] = [];
      const lineItems: LineItem[] = [];
      const aiAnomaliesRaw: Array<{
        type: string;
        severity: string;
        title: string;
        description: string;
        articleNo?: string;
        pageNumber?: number;
        suggestedMultiplierPct?: number;
        suggestedUnit?: string;
        clauseTag?: string;
      }> = [];
      let detectedTitle = '';
      let detectedRef = '';
      let detectedClient = '';
      let footerNotesAll = '';
      let itemCounter = 1;

      for (let c = 0; c < totalChunks; c++) {
        const slice = orderedQueue.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        setChunkProgress(
          lang === 'ar'
            ? `معالجة الحزمة ${c + 1}/${totalChunks} (${slice.length} ملف)...`
            : `Lot ${c + 1}/${totalChunks} · Analyse Gemini Vision (${c * CHUNK_SIZE + 1}–${c * CHUNK_SIZE + slice.length} / ${orderedQueue.length})...`
        );

        const payloadFiles = await Promise.all(
          slice.map(async (qf) => ({
            name: qf.name,
            mimeType: qf.file.type || (qf.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
            base64: await fileToBase64(qf.file),
          }))
        );

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (idToken) headers.Authorization = `Bearer ${idToken}`;

        const response = await fetch('/api/extract-bqe', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            files: payloadFiles,
            reverseOrder: false, // already reversed before chunking
            wilayaName: tender.wilayaName,
            pageOffset: c * CHUNK_SIZE,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Échec de l’extraction Gemini Vision.');
        }

        if (!detectedTitle && data.tenderTitle) detectedTitle = data.tenderTitle;
        if (!detectedRef && data.tenderReference) detectedRef = data.tenderReference;
        if (!detectedClient && data.clientName) detectedClient = data.clientName;
        if (data.detectedFooterClauses) footerNotesAll += ` ${data.detectedFooterClauses}`;
        if (Array.isArray(data.anomalies)) aiAnomaliesRaw.push(...data.anomalies);

        (data.lots || []).forEach(
          (
            rawLot: {
              code: string;
              name: string;
              items: Array<{
                articleNo: string;
                rawDesignation: string;
                designation: string;
                unit: string;
                quantity: number;
                pageNumber: number;
                abcClass: string;
                trade: string;
              }>;
            },
            lIdx: number
          ) => {
            const lotCode = (rawLot.code || `LOT 0${lots.length + 1}`).trim().toUpperCase();
            let lotObj = lotsByCode.get(lotCode);
            if (!lotObj) {
              lotObj = {
                id: `lot_ai_${lots.length + 1}`,
                tenderId: tender.id,
                code: lotCode,
                name: rawLot.name || `Lot ${lots.length + 1}`,
                orderIndex: lots.length + 1,
              };
              lotsByCode.set(lotCode, lotObj);
              lots.push(lotObj);
            }

            (rawLot.items || []).forEach((it) => {
              const unit = (it.unit || 'U').toUpperCase();
              const cleanDesig = it.designation || it.rawDesignation;
              const trade = (it.trade as TradeCategory) || classifyTrade(cleanDesig, lotObj!.name);
              const normalizedKey = normalizeItemKey(cleanDesig, unit);
              const provisional: LineItem = {
                id: `li_ai_${itemCounter++}`,
                tenderId: tender.id,
                lotId: lotObj!.id,
                articleNo: it.articleNo || `${lIdx + 1}.${itemCounter}`,
                designation: cleanDesig,
                rawDesignation: it.rawDesignation || cleanDesig,
                unit,
                quantity: Number(it.quantity) || 0,
                pageNumber: Number(it.pageNumber) || c * CHUNK_SIZE + 1,
                abcClass: 'B',
                trade,
                debourseSecDa: 0,
                confidenceRangePct: 0,
                priceSource: 'indicative_bpu',
                normalizedKey,
                includeInRfq: false,
              };

              const dbMatch = matchPrivateBpu(provisional, privateBpu, tender.wilayaCode);
              const abcClass =
                it.abcClass === 'A' || it.abcClass === 'B' || it.abcClass === 'C'
                  ? it.abcClass
                  : classifyAbcRisk(cleanDesig, provisional.quantity, dbMatch?.debourseSecDa ?? 0);

              const isClassA = abcClass === 'A';
              provisional.abcClass = abcClass;
              provisional.includeInRfq = isClassA;

              if (isClassA) {
                provisional.debourseSecDa = 0;
                provisional.priceSource = 'proforma_required';
                provisional.confidenceRangePct = 0;
              } else if (dbMatch) {
                provisional.debourseSecDa = dbMatch.debourseSecDa;
                provisional.priceSource = 'private_bpu';
                provisional.selectedSupplierName = `${dbMatch.supplierName} (BPU Privé)`;
                provisional.brand = dbMatch.brand;
                provisional.confidenceRangePct = 5;
              } else {
                provisional.debourseSecDa = 0;
                provisional.priceSource = 'indicative_bpu';
                provisional.confidenceRangePct = 0;
              }

              lineItems.push(provisional);
            });
          }
        );
      }

      if (lineItems.length === 0) {
        throw new Error('Aucun article BQE détecté dans les pages scannées. Vérifiez la netteté du document.');
      }

      const aiAnomalies: AnomalyFlag[] = aiAnomaliesRaw.map((a, idx) => {
        const matchedItem = a.articleNo
          ? lineItems.find((li) => li.articleNo === a.articleNo)
          : undefined;
        return {
          id: `anom_ai_${idx + 1}`,
          tenderId: tender.id,
          lineItemId: matchedItem?.id ?? null,
          type:
            a.type === 'truncated_fragment' ||
            a.type === 'unit_anomaly' ||
            a.type === 'hidden_cost_clause' ||
            a.type === 'ocr_typo'
              ? a.type
              : 'hidden_cost_clause',
          severity:
            a.severity === 'critical' || a.severity === 'warning' || a.severity === 'info'
              ? a.severity
              : 'warning',
          title: a.title,
          description: a.description,
          pageNumber: Number(a.pageNumber) || 1,
          suggestedMultiplierPct: a.suggestedMultiplierPct ?? null,
          suggestedUnit: a.suggestedUnit ?? null,
          clauseTag: a.clauseTag ?? null,
          resolved: false,
        };
      });

      const deterministicFlags = runDeterministicAudit(
        tender.id,
        lineItems,
        footerNotesAll
      );

      const mergedAnomalies: AnomalyFlag[] = [...aiAnomalies];
      for (const df of deterministicFlags) {
        const exists = mergedAnomalies.some(
          (existing) => existing.type === df.type && existing.lineItemId === df.lineItemId
        );
        if (!exists) mergedAnomalies.push(df);
      }

      await onReplaceExtractedData({
        title: detectedTitle || tender.title,
        reference: detectedRef || tender.reference,
        clientName: detectedClient || tender.clientName,
        lots,
        lineItems,
        anomalies: mergedAnomalies,
      });

      setExtractBanner(
        lang === 'ar'
          ? `تم استخراج ${lineItems.length} بنداً عبر ${lots.length} حصص (${totalChunks} دفعات) وكشف ${mergedAnomalies.length} نقطة تدقيق.`
          : `Extraction réussie (${totalChunks} lot(s) d'analyse) : ${lineItems.length} articles répartis en ${lots.length} lots et ${mergedAnomalies.length} alertes d'audit.`
      );
      setQueuedFiles([]);
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'Erreur lors de l’extraction.');
    } finally {
      setIsExtracting(false);
      setChunkProgress(null);
    }
  };

  const filteredAnomalies = tender.anomalies.filter((a) => {
    if (anomalyFilter === 'open') return !a.resolved;
    if (anomalyFilter === 'critical') return !a.resolved && a.severity === 'critical';
    return true;
  });

  const openCriticalCount = tender.anomalies.filter((a) => !a.resolved && a.severity === 'critical').length;
  const openCount = tender.anomalies.filter((a) => !a.resolved).length;

  return (
    <div className="space-y-8">
      {/* Top Ingestion Zone */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{t.uploadTitle}</h2>
              <p className="mt-1 text-sm text-slate-600 leading-relaxed">{t.uploadSubtitle}</p>
            </div>

            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFilesSelected(e.dataTransfer.files);
              }}
              className="mt-5 border border-dashed border-slate-300 hover:border-slate-500 bg-slate-50/70 hover:bg-slate-50 rounded-lg p-6 text-center cursor-pointer transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls"
                onChange={(e) => handleFilesSelected(e.target.files)}
                className="hidden"
              />
              <FileUp className="w-7 h-7 text-slate-500 mx-auto" />
              <p className="mt-2 text-sm font-medium text-slate-800">
                {lang === 'ar'
                  ? 'اسحب ملفات PDF / صور CamScanner أو ملف Excel (.xlsx) هنا'
                  : 'Glissez-déposez vos scans CamScanner (PDF / JPG / PNG) ou BQE Excel (.xlsx)'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {lang === 'ar'
                  ? 'دعم كامل للمصطلحات الجزائرية: F/P · ENS · ML · TVO · TGBT · SBS · PN06 · PEHD'
                  : 'Reconnaissance native BTP Algérie : F/P · ENS · ML · TVO · TGBT · SBS · PN06 · PEHD'}
              </p>
            </div>

            {queuedFiles.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {queuedFiles.length} {lang === 'ar' ? 'ملف(ات) في الانتظار' : 'fichier(s) en file'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQueuedFiles((prev) => [...prev].reverse())}
                    className="inline-flex items-center gap-1 text-slate-700 hover:text-slate-900 font-medium"
                  >
                    <ArrowDownUp className="w-3.5 h-3.5" />
                    {lang === 'ar' ? 'عكس الترتيب الآن' : 'Inverser ordre'}
                  </button>
                </div>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-white max-h-40 overflow-y-auto">
                  {queuedFiles.map((qf, idx) => (
                    <div key={qf.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-tabular text-slate-400">#{idx + 1}</span>
                        {qf.type === 'excel' ? (
                          <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-sky-700 shrink-0" />
                        )}
                        <span className="truncate font-medium text-slate-800 ltr-preserve">{qf.name}</span>
                        <span className="text-slate-400 font-tabular shrink-0">{qf.sizeKb} KB</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeQueuedFile(qf.id)}
                        className="p-1 text-slate-400 hover:text-red-600"
                        aria-label="Supprimer fichier"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={reverseOrder}
                onChange={(e) => setReverseOrder(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              {t.reverseOrderLabel}
            </label>

            <button
              type="button"
              disabled={queuedFiles.length === 0 || isExtracting}
              onClick={handleRunExtraction}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0F172A] hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t.extracting}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  {t.extractBtn}
                </>
              )}
            </button>
          </div>

          {chunkProgress && (
            <div className="mt-3 p-3 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700">
              {chunkProgress}
            </div>
          )}
          {extractError && (
            <div className="mt-3 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {extractError}
            </div>
          )}
          {extractBanner && (
            <div className="mt-3 p-3 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              {extractBanner}
            </div>
          )}
        </div>

        {/* Right: Active Tender Structure Overview */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <div className="text-xs font-medium text-slate-500">
              {lang === 'ar' ? 'الصفقة النشطة حالياً' : 'Appel d’offres actif'} ·{' '}
              <span className="font-tabular text-slate-700 ltr-preserve">{tender.reference}</span>
            </div>
            <h3 className="mt-1 text-base font-semibold text-slate-900 ltr-preserve">
              {tender.title}
            </h3>
            <p className="mt-1 text-xs text-slate-500 ltr-preserve">
              {tender.clientName} · Wilaya {tender.wilayaName} ({tender.wilayaCode})
            </p>

            <div className="mt-5 grid grid-cols-3 gap-3 border-y border-slate-100 py-4">
              <div>
                <div className="text-xs text-slate-500">{lang === 'ar' ? 'الحصص' : 'Lots'}</div>
                <div className="mt-0.5 text-xl font-semibold font-tabular text-slate-900">
                  {tender.lots.length}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{lang === 'ar' ? 'البنود' : 'Articles'}</div>
                <div className="mt-0.5 text-xl font-semibold font-tabular text-slate-900">
                  {tender.lineItems.length}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{lang === 'ar' ? 'تنبيهات حرجة' : 'Critiques'}</div>
                <div
                  className={`mt-0.5 text-xl font-semibold font-tabular ${
                    openCriticalCount > 0 ? 'text-red-600' : 'text-emerald-600'
                  }`}
                >
                  {openCriticalCount}
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-1.5">
              <div className="text-xs font-medium text-slate-500">
                {lang === 'ar' ? 'الهيكلة المستخرجة (الحصص)' : 'Arborescence extraite'}
              </div>
              {tender.lots.map((lot) => {
                const count = tender.lineItems.filter((i) => i.lotId === lot.id).length;
                const classACount = tender.lineItems.filter(
                  (i) => i.lotId === lot.id && i.abcClass === 'A'
                ).length;
                return (
                  <div
                    key={lot.id}
                    className="flex items-center justify-between text-xs py-1.5 border-b border-slate-100 last:border-0"
                  >
                    <span className="text-slate-800 truncate ltr-preserve">
                      <strong className="font-semibold">{lot.code}</strong> · {lot.name}
                    </span>
                    <span className="font-tabular text-slate-500 shrink-0 ms-2">
                      {count} art. {classACount > 0 ? `· ${classACount} Cl.A` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <span className="text-xs text-slate-500">
              {openCount === 0
                ? lang === 'ar'
                  ? 'التدقيق مكتمل وجاهز للتسعير'
                  : 'Audit soldé · prêt pour chiffrage'
                : lang === 'ar'
                ? `${openCount} ملاحظة قبل التسعير`
                : `${openCount} point(s) à vérifier avant chiffrage`}
            </span>
            <button
              type="button"
              onClick={onGoToPricing}
              className="px-3.5 py-2 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {lang === 'ar' ? 'الانتقال للتصنيف والتسعير' : 'Passer au Triage ABC →'}
            </button>
          </div>
        </div>
      </div>

      {/* Automated Pre-Pricing Anomaly Auditor Desk */}
      <div className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {lang === 'ar'
                ? 'مدقق التجاوزات والشروط المخفية (قبل التسعير)'
                : 'Audit Automatisé des Anomalies & Clauses Cachées (Pré-Chiffrage)'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {lang === 'ar'
                ? 'كشف الأسطر المبتورة، أخطاء الوحدات (M3 بدل M2)، وشروط الموقع المستغل والاعتمادات (CNERIB / CTC / Sonelgaz / الحماية المدنية).'
                : 'Détection des coupures de pages, unités aberrantes (M3 au lieu de M2), artéfacts OCR et clauses cachées (site occupé, CNERIB, CTC, Sonelgaz, Protection Civile).'}
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(
              [
                { id: 'open', label: lang === 'ar' ? `مفتوحة (${openCount})` : `Ouvertes (${openCount})` },
                { id: 'critical', label: lang === 'ar' ? `حرجة (${openCriticalCount})` : `Critiques (${openCriticalCount})` },
                { id: 'all', label: lang === 'ar' ? `الكل (${tender.anomalies.length})` : `Toutes (${tender.anomalies.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setAnomalyFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  anomalyFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredAnomalies.length === 0 ? (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
            <p className="mt-2 text-sm font-medium text-slate-900">
              {lang === 'ar' ? 'لا توجد ملاحظات مفتوحة في هذا التصنيف.' : 'Aucune anomalie ouverte dans ce filtre.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {filteredAnomalies.map((anom) => {
              const linkedItem = anom.lineItemId
                ? tender.lineItems.find((li) => li.id === anom.lineItemId)
                : null;
              const isSiteClause =
                anom.type === 'hidden_cost_clause' && /occupé|opérationnel/i.test(`${anom.title} ${anom.description}`);

              return (
                <div
                  key={anom.id}
                  className={`px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
                    anom.resolved ? 'bg-slate-50/70 opacity-75' : 'bg-white'
                  }`}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="mt-0.5 shrink-0">
                      {anom.resolved ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                      ) : anom.severity === 'critical' ? (
                        <ShieldAlert className="w-5 h-5 text-red-600" />
                      ) : anom.severity === 'warning' ? (
                        <AlertTriangle className="w-5 h-5 text-amber-600" />
                      ) : (
                        <Info className="w-5 h-5 text-sky-600" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span
                          className={`font-semibold ${
                            anom.resolved
                              ? 'text-emerald-700'
                              : anom.severity === 'critical'
                              ? 'text-red-700'
                              : anom.severity === 'warning'
                              ? 'text-amber-700'
                              : 'text-sky-700'
                          }`}
                        >
                          {anom.resolved
                            ? lang === 'ar'
                              ? 'تمت المعالجة'
                              : 'Résolu'
                            : anom.severity === 'critical'
                            ? lang === 'ar'
                              ? 'حرج'
                              : 'Critique'
                            : anom.severity === 'warning'
                            ? lang === 'ar'
                              ? 'تحذير'
                              : 'Avertissement'
                            : 'Info OCR'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Page {anom.pageNumber}</span>
                        {linkedItem && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-tabular ltr-preserve">
                              Art. {linkedItem.articleNo} ({linkedItem.quantity} {linkedItem.unit})
                            </span>
                          </>
                        )}
                        {anom.clauseTag && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-medium text-slate-700 ltr-preserve">{anom.clauseTag}</span>
                          </>
                        )}
                      </div>
                      <h4 className="mt-1 text-sm font-semibold text-slate-900 ltr-preserve">
                        {anom.title}
                      </h4>
                      <p className="mt-0.5 text-xs text-slate-600 leading-relaxed ltr-preserve">
                        {anom.description}
                      </p>
                    </div>
                  </div>

                  {!anom.resolved && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {anom.type === 'unit_anomaly' && linkedItem && anom.suggestedUnit && (
                        <button
                          type="button"
                          onClick={() => onFixItemUnit(linkedItem.id, anom.suggestedUnit!, anom.id)}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors whitespace-nowrap"
                        >
                          {t.applyFix} ({linkedItem.unit} → {anom.suggestedUnit})
                        </button>
                      )}

                      {anom.type === 'truncated_fragment' && linkedItem && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            placeholder="Quantité"
                            value={qtyDrafts[anom.id] ?? ''}
                            onChange={(e) =>
                              setQtyDrafts((prev) => ({ ...prev, [anom.id]: e.target.value }))
                            }
                            className="w-28 px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                          />
                          <button
                            type="button"
                            disabled={!qtyDrafts[anom.id] || Number(qtyDrafts[anom.id]) <= 0}
                            onClick={() => {
                              const parsed = Number(qtyDrafts[anom.id]);
                              if (parsed > 0) onFixItemQuantity(linkedItem.id, parsed, anom.id);
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 rounded-md transition-colors whitespace-nowrap"
                          >
                            {lang === 'ar' ? 'تثبيت الكمية' : 'Valider Qté'}
                          </button>
                        </div>
                      )}

                      {anom.type === 'hidden_cost_clause' && anom.suggestedMultiplierPct && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplySiteMultiplier(anom.suggestedMultiplierPct!, anom.id, !isSiteClause)
                          }
                          className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors whitespace-nowrap"
                        >
                          {t.applyMultiplier}
                          {anom.suggestedMultiplierPct}%{' '}
                          {isSiteClause
                            ? lang === 'ar'
                              ? 'موقع مستغل'
                              : 'Site Occupé'
                            : lang === 'ar'
                            ? 'مصاريف عامة'
                            : 'Frais Généraux'}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onResolveAnomaly(anom.id)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                      >
                        {t.resolveAnomaly}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
