import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Lock,
  Search,
  Send,
  SlidersHorizontal,
  Unlock,
} from 'lucide-react';
import {
  AbcClass,
  AppLang,
  LineItem,
  TenderLot,
  TenderProject,
} from '../types/btp';
import { ALGERIA_WILAYAS } from '../data/algeriaReference';
import { UI_COPY } from '../data/i18n';
import {
  computeLineTotalHT,
  computeUnitPriceHT,
  formatDZD,
  getEffectiveCoefficients,
} from '../utils/pricingEngine';

interface Props {
  tender: TenderProject;
  lang: AppLang;
  onUpdateGlobalCoeff: (patch: Partial<Pick<TenderProject, 'wilayaCode' | 'wilayaName' | 'globalTransportPct' | 'globalOccupiedSitePct' | 'globalOverheadPct' | 'globalMarginPct' | 'tvaRate'>>) => void;
  onUpdateLotOverride: (lotId: string, patch: Partial<Pick<TenderLot, 'overrideTransportPct' | 'overrideOccupiedSitePct' | 'overrideOverheadPct' | 'overrideMarginPct'>>) => void;
  onUpdateLineItem: (itemId: string, patch: Partial<LineItem>) => void;
  onSaveItemToBpu?: (item: LineItem) => void;
  onAutoFillFromPrivateBpu: () => number;
  onRouteToRfq: () => void;
}

export const Layer2PricingEngine: React.FC<Props> = ({
  tender,
  lang,
  onUpdateGlobalCoeff,
  onUpdateLotOverride,
  onUpdateLineItem,
  onSaveItemToBpu,
  onAutoFillFromPrivateBpu,
  onRouteToRfq,
}) => {
  const t = UI_COPY[lang];
  const [abcFilter, setAbcFilter] = useState<'ALL' | AbcClass | 'BLOCKED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingLotId, setEditingLotId] = useState<string | null>(null);
  const [unlockedClassAIds, setUnlockedClassAIds] = useState<Record<string, boolean>>({});
  const [bpuToast, setBpuToast] = useState<string | null>(null);

  const globalMultiplier = useMemo(() => {
    return (
      1 +
      (tender.globalTransportPct +
        tender.globalOccupiedSitePct +
        tender.globalOverheadPct +
        tender.globalMarginPct) /
        100
    );
  }, [
    tender.globalTransportPct,
    tender.globalOccupiedSitePct,
    tender.globalOverheadPct,
    tender.globalMarginPct,
  ]);

  const handleWilayaChange = (code: string) => {
    const w = ALGERIA_WILAYAS.find((item) => item.code === code);
    if (!w) return;
    onUpdateGlobalCoeff({
      wilayaCode: w.code,
      wilayaName: w.nameFr,
      globalTransportPct: w.defaultTransportPct,
    });
  };

  const handlePrivateBpuFill = () => {
    const matched = onAutoFillFromPrivateBpu();
    setBpuToast(
      matched > 0
        ? lang === 'ar'
          ? `تمت مطابقة وتعبئة ${matched} بنداً من ذاكرة BPU الخاصة بك.`
          : `${matched} article(s) mis à jour automatiquement depuis votre BPU Privé.`
        : lang === 'ar'
        ? 'جميع البنود المطابقة محدثة بالفعل.'
        : 'Aucune nouvelle correspondance trouvée dans votre BPU Privé.'
    );
    setTimeout(() => setBpuToast(null), 4000);
  };

  const filteredItemsByLot = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tender.lots.map((lot) => {
      const items = tender.lineItems.filter((li) => {
        if (li.lotId !== lot.id) return false;
        if (abcFilter === 'BLOCKED' && li.priceSource !== 'proforma_required') return false;
        if ((abcFilter === 'A' || abcFilter === 'B' || abcFilter === 'C') && li.abcClass !== abcFilter) {
          return false;
        }
        if (q) {
          const hay = `${li.articleNo} ${li.designation} ${li.trade} ${li.selectedSupplierName || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return { lot, items };
    });
  }, [tender.lots, tender.lineItems, abcFilter, searchQuery]);

  const counts = useMemo(() => {
    let a = 0, b = 0, c = 0, blocked = 0;
    for (const li of tender.lineItems) {
      if (li.abcClass === 'A') a++;
      else if (li.abcClass === 'B') b++;
      else c++;
      if (li.priceSource === 'proforma_required') blocked++;
    }
    return { a, b, c, blocked, total: tender.lineItems.length };
  }, [tender.lineItems]);

  return (
    <div className="space-y-6">
      {/* Cost-to-Bid Global Coefficients Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {lang === 'ar'
                ? 'محرك معاملات التكلفة إلى العرض (Cost-to-Bid)'
                : 'Moteur Cost-to-Bid — Coefficients Globaux & Indexation Wilaya'}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 font-tabular ltr-preserve">
              PU (DA HT) = Déboursé Sec × (1 + {tender.globalTransportPct}% + {tender.globalOccupiedSitePct}% + {tender.globalOverheadPct}% + {tender.globalMarginPct}%) = DS × {globalMultiplier.toFixed(3)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrivateBpuFill}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
            >
              <Database className="w-3.5 h-3.5" />
              {t.autoFillPrivateBpu}
            </button>
            <button
              type="button"
              onClick={onRouteToRfq}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              {lang === 'ar'
                ? `إرسال ${counts.blocked} بنود فئة A لواتساب RFQ`
                : `Router ${counts.blocked} Classe A vers Micro-RFQ`}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.wilayaLabel}</label>
            <select
              value={tender.wilayaCode}
              onChange={(e) => handleWilayaChange(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:border-slate-900"
            >
              {ALGERIA_WILAYAS.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.code} — {lang === 'ar' ? w.nameAr : w.nameFr}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.transportPct}</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="50"
              value={tender.globalTransportPct}
              onChange={(e) => onUpdateGlobalCoeff({ globalTransportPct: Number(e.target.value) || 0 })}
              className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.occupiedSitePct}</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="40"
              value={tender.globalOccupiedSitePct}
              onChange={(e) => onUpdateGlobalCoeff({ globalOccupiedSitePct: Number(e.target.value) || 0 })}
              className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.overheadPct}</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="50"
              value={tender.globalOverheadPct}
              onChange={(e) => onUpdateGlobalCoeff({ globalOverheadPct: Number(e.target.value) || 0 })}
              className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.marginPct}</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="60"
              value={tender.globalMarginPct}
              onChange={(e) => onUpdateGlobalCoeff({ globalMarginPct: Number(e.target.value) || 0 })}
              className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t.tvaPct}</label>
            <select
              value={tender.tvaRate}
              onChange={(e) => onUpdateGlobalCoeff({ tvaRate: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded-md bg-white focus:outline-none focus:border-slate-900"
            >
              <option value={19}>19% (Taux normal)</option>
              <option value={9}>9% (Taux réduit)</option>
              <option value={0}>0% (Exonéré / HT)</option>
            </select>
          </div>
        </div>

        {bpuToast && (
          <div className="mt-3 px-3 py-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md">
            {bpuToast}
          </div>
        )}
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-md">
          {(
            [
              { id: 'ALL', label: `${lang === 'ar' ? 'الكل' : 'Tous'} (${counts.total})` },
              { id: 'A', label: `${t.classABadge} (${counts.a})` },
              { id: 'B', label: `${t.classBBadge} (${counts.b})` },
              { id: 'C', label: `${t.classCBadge} (${counts.c})` },
              { id: 'BLOCKED', label: `${t.srcProformaReq} (${counts.blocked})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setAbcFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                abcFilter === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={lang === 'ar' ? 'بحث برقم البند أو التعيين...' : 'Filtrer article, lot, fournisseur...'}
            className="w-full ps-9 pe-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
          />
        </div>
      </div>

      {/* BQE Table Grouped by Lot */}
      <div className="space-y-5">
        {tender.lineItems.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
            <p className="text-sm font-medium text-slate-800">
              {lang === 'ar'
                ? 'لا توجد بنود مستخرجة في هذه الصفقة بعد.'
                : 'Aucun article BQE dans cet appel d’offres.'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {lang === 'ar'
                ? 'انتقل إلى مرحلة الإدخال والتدقيق لرفع ملف PDF/CamScanner أو Excel (.xlsx).'
                : 'Rendez-vous dans « Ingestion & Audit » pour importer vos scans CamScanner (PDF/images) ou votre fichier Excel (.xlsx).'}
            </p>
          </div>
        )}
        {filteredItemsByLot.map(({ lot, items }) => {
          if (items.length === 0) return null;
          const eff = getEffectiveCoefficients(tender, lot);
          const hasOverride =
            lot.overrideTransportPct != null ||
            lot.overrideOccupiedSitePct != null ||
            lot.overrideOverheadPct != null ||
            lot.overrideMarginPct != null;
          const lotSubtotal = items.reduce((sum, li) => sum + computeLineTotalHT(li, eff), 0);

          return (
            <div key={lot.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              {/* Lot Header */}
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0 ltr-preserve">
                  <span className="text-xs font-semibold font-tabular text-slate-900">{lot.code}</span>
                  <span className="text-sm font-semibold text-slate-900 truncate">{lot.name}</span>
                  {hasOverride && (
                    <span className="text-xs text-blue-700 font-medium">
                      · Surcharge active (×
                      {(1 + (eff.transportPct + eff.occupiedSitePct + eff.overheadPct + eff.marginPct) / 100).toFixed(3)})
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditingLotId(editingLotId === lot.id ? null : lot.id)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    {t.lotOverrides}
                  </button>
                  <div className="text-sm font-semibold font-tabular text-slate-900 ltr-preserve">
                    {formatDZD(lotSubtotal)} DA HT
                  </div>
                </div>
              </div>

              {/* Per-Lot Override Drawer */}
              {editingLotId === lot.id && (
                <div className="px-4 py-3 bg-slate-100/80 border-b border-slate-200 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Transport % (défaut {tender.globalTransportPct}%)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      placeholder={String(tender.globalTransportPct)}
                      value={lot.overrideTransportPct ?? ''}
                      onChange={(e) =>
                        onUpdateLotOverride(lot.id, {
                          overrideTransportPct: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1 text-xs font-tabular bg-white border border-slate-300 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Site Occupé % (défaut {tender.globalOccupiedSitePct}%)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      placeholder={String(tender.globalOccupiedSitePct)}
                      value={lot.overrideOccupiedSitePct ?? ''}
                      onChange={(e) =>
                        onUpdateLotOverride(lot.id, {
                          overrideOccupiedSitePct: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1 text-xs font-tabular bg-white border border-slate-300 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Frais Gén. % (défaut {tender.globalOverheadPct}%)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      placeholder={String(tender.globalOverheadPct)}
                      value={lot.overrideOverheadPct ?? ''}
                      onChange={(e) =>
                        onUpdateLotOverride(lot.id, {
                          overrideOverheadPct: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1 text-xs font-tabular bg-white border border-slate-300 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Marge % (défaut {tender.globalMarginPct}%)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      placeholder={String(tender.globalMarginPct)}
                      value={lot.overrideMarginPct ?? ''}
                      onChange={(e) =>
                        onUpdateLotOverride(lot.id, {
                          overrideMarginPct: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1 text-xs font-tabular bg-white border border-slate-300 rounded"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onUpdateLotOverride(lot.id, {
                        overrideTransportPct: null,
                        overrideOccupiedSitePct: null,
                        overrideOverheadPct: null,
                        overrideMarginPct: null,
                      });
                      setEditingLotId(null);
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded"
                  >
                    Réinitialiser lot
                  </button>
                </div>
              )}

              {/* High-Density BQE Data Grid (LTR preserved for official tender data) */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse" dir="ltr">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-white">
                      <th className="py-2.5 px-3 w-16">Art.</th>
                      <th className="py-2.5 px-3 min-w-[280px]">Désignation BQE (FR Officiel)</th>
                      <th className="py-2.5 px-2 w-16 text-center">ABC</th>
                      <th className="py-2.5 px-2 w-16 text-center">Unité</th>
                      <th className="py-2.5 px-2 w-24 text-right">Qté</th>
                      <th className="py-2.5 px-3 w-36 text-right">Déboursé Sec (DA)</th>
                      <th className="py-2.5 px-3 w-32 text-right">PU HT (DA)</th>
                      <th className="py-2.5 px-3 w-36 text-right">Montant HT (DA)</th>
                      <th className="py-2.5 px-3 w-44">Statut & Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {items.map((item) => {
                      const isBlocked =
                        item.abcClass === 'A' &&
                        item.priceSource === 'proforma_required' &&
                        !unlockedClassAIds[item.id];
                      const puHt = isBlocked ? 0 : computeUnitPriceHT(item.debourseSecDa, eff);
                      const totalHt = isBlocked ? 0 : computeLineTotalHT(item, eff);

                      return (
                        <tr
                          key={item.id}
                          className={`hover:bg-slate-50/80 transition-colors ${
                            isBlocked ? 'bg-red-50/25' : ''
                          }`}
                        >
                          <td className="py-2.5 px-3 font-tabular font-medium text-slate-700 align-top">
                            {item.articleNo}
                          </td>

                          <td className="py-2.5 px-3 align-top">
                            <div className="text-slate-900 leading-snug">{item.designation}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                              <span>{item.trade}</span>
                              <span aria-hidden="true">·</span>
                              <span>p.{item.pageNumber}</span>
                              {item.brand && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-slate-700 font-medium">{item.brand}</span>
                                </>
                              )}
                              {item.abcClass === 'B' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <label className="inline-flex items-center gap-1 cursor-pointer text-slate-600 hover:text-slate-900">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(item.includeInRfq)}
                                      onChange={(e) =>
                                        onUpdateLineItem(item.id, { includeInRfq: e.target.checked })
                                      }
                                      className="rounded border-slate-300 text-blue-600"
                                    />
                                    Inclure RFQ
                                  </label>
                                </>
                              )}
                            </div>
                          </td>

                          <td className="py-2.5 px-2 text-center align-top">
                            <select
                              value={item.abcClass}
                              onChange={(e) => {
                                const nextClass = e.target.value as AbcClass;
                                onUpdateLineItem(item.id, {
                                  abcClass: nextClass,
                                  includeInRfq: nextClass === 'A' ? true : item.includeInRfq,
                                  priceSource:
                                    nextClass === 'A' && item.priceSource === 'indicative_bpu'
                                      ? 'proforma_required'
                                      : item.priceSource,
                                  debourseSecDa:
                                    nextClass === 'A' && item.priceSource === 'indicative_bpu'
                                      ? 0
                                      : item.debourseSecDa,
                                });
                              }}
                              className={`px-1.5 py-0.5 text-[11px] font-semibold rounded border focus:outline-none ${
                                item.abcClass === 'A'
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : item.abcClass === 'B'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                              }`}
                            >
                              <option value="A">A</option>
                              <option value="B">B</option>
                              <option value="C">C</option>
                            </select>
                          </td>

                          <td className="py-2.5 px-2 text-center font-tabular text-slate-700 align-top">
                            {item.unit}
                          </td>

                          <td className="py-2.5 px-2 text-right align-top">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={item.quantity}
                              onChange={(e) =>
                                onUpdateLineItem(item.id, { quantity: Math.max(0, Number(e.target.value) || 0) })
                              }
                              className={`w-20 px-2 py-1 text-right font-tabular border rounded focus:outline-none focus:border-slate-900 ${
                                item.quantity <= 0 ? 'border-red-400 bg-red-50 text-red-800' : 'border-slate-200'
                              }`}
                            />
                          </td>

                          <td className="py-2.5 px-3 text-right align-top">
                            {isBlocked ? (
                              <div className="flex flex-col items-end gap-1">
                                <button
                                  type="button"
                                  onClick={onRouteToRfq}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded transition-colors whitespace-nowrap"
                                >
                                  <Lock className="w-3 h-3" />
                                  Proforma Requis
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setUnlockedClassAIds((prev) => ({ ...prev, [item.id]: true }))
                                  }
                                  className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-700"
                                >
                                  <Unlock className="w-2.5 h-2.5" />
                                  Saisie manuelle
                                </button>
                              </div>
                            ) : (
                              <div>
                                <input
                                  type="number"
                                  min="0"
                                  step="10"
                                  value={item.debourseSecDa}
                                  onChange={(e) =>
                                    onUpdateLineItem(item.id, {
                                      debourseSecDa: Math.max(0, Number(e.target.value) || 0),
                                      priceSource:
                                        item.priceSource === 'supplier_verified'
                                          ? 'supplier_verified'
                                          : 'manual_override',
                                    })
                                  }
                                  className="w-32 px-2 py-1 text-right font-tabular border border-slate-200 rounded focus:outline-none focus:border-slate-900"
                                />
                                {item.priceSource === 'indicative_bpu' && item.confidenceRangePct > 0 && (
                                  <div className="mt-0.5 text-[10px] font-tabular text-amber-700">
                                    ±{item.confidenceRangePct}% indicatif
                                  </div>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="py-2.5 px-3 text-right font-tabular text-slate-800 align-top">
                            {isBlocked ? '—' : formatDZD(puHt)}
                          </td>

                          <td className="py-2.5 px-3 text-right font-tabular font-semibold text-slate-900 align-top">
                            {isBlocked ? '—' : formatDZD(totalHt)}
                          </td>

                          <td className="py-2.5 px-3 align-top">
                            {item.priceSource === 'supplier_verified' ? (
                              <div>
                                <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                  {t.srcVerified}
                                </div>
                                {item.selectedSupplierName && (
                                  <div className="text-[10px] text-slate-500 truncate max-w-[165px]">
                                    {item.selectedSupplierName}
                                  </div>
                                )}
                              </div>
                            ) : item.priceSource === 'private_bpu' ? (
                              <div>
                                <div className="text-[11px] font-semibold text-sky-700">{t.srcPrivateBpu}</div>
                                {item.selectedSupplierName && (
                                  <div className="text-[10px] text-slate-500 truncate max-w-[165px]">
                                    {item.selectedSupplierName}
                                  </div>
                                )}
                              </div>
                            ) : item.priceSource === 'proforma_required' ? (
                              <div className="text-[11px] font-semibold text-red-700">{t.srcProformaReq}</div>
                            ) : item.priceSource === 'manual_override' ? (
                              <div className="space-y-1">
                                <div className="text-[11px] font-medium text-slate-700">{t.srcManual}</div>
                                {onSaveItemToBpu && item.debourseSecDa > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => onSaveItemToBpu(item)}
                                    className="text-[10px] font-medium text-blue-700 hover:underline"
                                  >
                                    + Sauvegarder dans BPU
                                  </button>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <div className="text-[11px] font-medium text-amber-700">
                                  {item.debourseSecDa > 0 ? t.srcIndicative : 'À chiffrer'}
                                </div>
                                {onSaveItemToBpu && item.debourseSecDa > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => onSaveItemToBpu(item)}
                                    className="text-[10px] font-medium text-blue-700 hover:underline"
                                  >
                                    + Sauvegarder dans BPU
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
