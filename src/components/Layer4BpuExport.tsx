import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AppLang, PrivateBpuEntry, TenderProject, TradeCategory } from '../types/btp';
import { ALGERIA_WILAYAS } from '../data/algeriaReference';
import { UI_COPY } from '../data/i18n';
import {
  computeTenderFinancials,
  formatDZD,
  montantEnLettresDZD,
  normalizeItemKey,
} from '../utils/pricingEngine';
import { exportTenderToExcel } from '../utils/excelService';

interface Props {
  tender: TenderProject;
  privateBpu: PrivateBpuEntry[];
  lang: AppLang;
  onAddBpuEntry: (entry: PrivateBpuEntry) => void;
  onDeleteBpuEntry: (id: string) => void;
  onAutoFillFromPrivateBpu: () => number;
}

const TRADES: TradeCategory[] = [
  'Électricité & Groupe',
  'Chauffage & Clim',
  'VRD & Voirie',
  'Plomberie & Incendie',
  'Étanchéité & Façade',
  'Gros Œuvre & Revêtements',
];

export const Layer4BpuExport: React.FC<Props> = ({
  tender,
  privateBpu,
  lang,
  onAddBpuEntry,
  onDeleteBpuEntry,
  onAutoFillFromPrivateBpu,
}) => {
  const t = UI_COPY[lang];
  const [includeWords, setIncludeWords] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [searchBpu, setSearchBpu] = useState('');
  const [wilayaFilter, setWilayaFilter] = useState('ALL');
  const [showAddForm, setShowAddForm] = useState(false);

  const [newEntry, setNewEntry] = useState({
    designation: '',
    unit: 'M2',
    brand: '',
    wilayaCode: tender.wilayaCode,
    trade: 'Gros Œuvre & Revêtements' as TradeCategory,
    supplierName: '',
    debourseSecDa: '',
  });

  const financials = useMemo(() => computeTenderFinancials(tender), [tender]);

  const lotChartData = useMemo(() => {
    return tender.lots.map((lot) => ({
      name: lot.code,
      fullName: lot.name,
      montantHt: Math.round(financials.lotTotals[lot.id]?.totalHt || 0),
    }));
  }, [tender.lots, financials.lotTotals]);

  const filteredBpu = useMemo(() => {
    const q = searchBpu.trim().toLowerCase();
    return privateBpu.filter((e) => {
      if (wilayaFilter !== 'ALL' && e.wilayaCode !== wilayaFilter) return false;
      if (!q) return true;
      return `${e.designation} ${e.brand} ${e.supplierName} ${e.trade} ${e.wilayaName}`
        .toLowerCase()
        .includes(q);
    });
  }, [privateBpu, searchBpu, wilayaFilter]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportTenderToExcel(tender, includeWords);
    } finally {
      setExporting(false);
    }
  };

  const handleCreateBpu = (e: React.FormEvent) => {
    e.preventDefault();
    const ds = Number(newEntry.debourseSecDa);
    if (!newEntry.designation.trim() || !ds || ds <= 0) return;
    const wilayaObj = ALGERIA_WILAYAS.find((w) => w.code === newEntry.wilayaCode);
    onAddBpuEntry({
      id: `bpu_${Date.now()}`,
      normalizedItemKey: normalizeItemKey(newEntry.designation, newEntry.unit),
      designation: newEntry.designation.trim(),
      unit: newEntry.unit.toUpperCase(),
      brand: newEntry.brand.trim() || 'Standard',
      wilayaCode: newEntry.wilayaCode,
      wilayaName: wilayaObj?.nameFr || 'Alger',
      trade: newEntry.trade,
      supplierName: newEntry.supplierName.trim() || 'Fournisseur vérifié',
      debourseSecDa: ds,
      quotedDate: new Date().toISOString().slice(0, 10),
    });
    setNewEntry({
      designation: '',
      unit: 'M2',
      brand: '',
      wilayaCode: tender.wilayaCode,
      trade: 'Gros Œuvre & Revêtements',
      supplierName: '',
      debourseSecDa: '',
    });
    setShowAddForm(false);
  };

  const totalHtNonZero = Math.max(1, financials.totalHt);
  const pctA = Math.round((financials.classATotal / totalHtNonZero) * 100);
  const pctB = Math.round((financials.classBTotal / totalHtNonZero) * 100);
  const pctC = Math.max(0, 100 - pctA - pctB);

  return (
    <div className="space-y-6">
      {/* Top Grid: Submission Export & Financial Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Export Control Panel */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {lang === 'ar'
                ? 'تصدير العرض المالي النهائي (Excel متعدد الأوراق)'
                : 'Export Soumission Officielle (.xlsx à Formules Dynamiques)'}
            </h2>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              {lang === 'ar'
                ? 'يولد ملف Excel جاهزاً للإيداع يحتوي على 3 أوراق: Bordereau بصيغ تلقائية + Récapitulatif مع النسب و TVA + Hypothèses & Audit.'
                : 'Génère un classeur prêt à déposer comprenant 3 onglets liés par formules : Bordereau, Récapitulatif (% + TVA + TTC en toutes lettres) et Hypothèses & Audit.'}
            </p>

            {/* Pre-Flight Groundedness Readiness Check */}
            <div className="mt-4 space-y-2 border-y border-slate-100 py-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">
                  {lang === 'ar' ? 'تغطية الفئة A بعروض أسعار موثقة' : 'Couverture Classe A (Devis Vérifié)'}
                </span>
                {financials.proformaRequiredCount === 0 ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 100% Vérifié
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                    <AlertCircle className="w-3.5 h-3.5" /> {financials.proformaRequiredCount} Proforma(s) en attente
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">
                  {lang === 'ar' ? 'الملاحظات الحرجة المفتوحة' : 'Anomalies critiques résolues'}
                </span>
                {financials.openCriticalAnomalies === 0 ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Soldées
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                    <AlertCircle className="w-3.5 h-3.5" /> {financials.openCriticalAnomalies} ouverte(s)
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">
                  {lang === 'ar' ? 'المبلغ الإجمالي (TTC) بالحروف الفرنسية' : 'Arrêté TTC en toutes lettres'}
                </span>
                <span className="font-tabular font-semibold text-slate-900 ltr-preserve">
                  {formatDZD(financials.totalTtc)} DA
                </span>
              </div>
            </div>

            <div className="mt-3 p-3 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800 italic ltr-preserve">
              « {montantEnLettresDZD(financials.totalTtc)} »
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 space-y-3">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeWords}
                onChange={(e) => setIncludeWords(e.target.checked)}
                className="rounded border-slate-300 text-slate-900"
              />
              {t.includeWordsToggle}
            </label>

            <button
              type="button"
              disabled={exporting}
              onClick={handleExport}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#0F172A] hover:bg-slate-800 disabled:bg-slate-400 rounded-md transition-colors"
            >
              <Download className="w-4 h-4" />
              {exporting ? 'Génération Excel...' : t.exportExcel}
            </button>
          </div>
        </div>

        {/* Lot Financial Distribution & ABC Pareto Chart */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">
                {lang === 'ar' ? 'توزيع المبالغ حسب الحصص (DA HT)' : 'Répartition Financière par Lot (DA HT)'}
              </h3>
              <span className="text-xs font-tabular text-slate-500">
                Pareto ABC : A {pctA}% · B {pctB}% · C {pctC}%
              </span>
            </div>

            <div className="mt-4 h-56 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={lotChartData} margin={{ top: 8, right: 12, left: 10, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#475569' }}
                    tickFormatter={(v) => `${(Number(v) / 1_000_000).toFixed(1)}M`}
                  />
                  <Tooltip
                    formatter={(value) => [`${formatDZD(Number(value), 0)} DA HT`, 'Montant']}
                    contentStyle={{ fontSize: '12px', borderRadius: '6px', borderColor: '#CBD5E1' }}
                  />
                  <Bar dataKey="montantHt" fill="#0F172A" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-slate-500">Classe A (Critique)</div>
              <div className="mt-0.5 font-tabular font-semibold text-slate-900 ltr-preserve">
                {formatDZD(financials.classATotal, 0)} DA
              </div>
            </div>
            <div>
              <div className="text-slate-500">Classe B (Standard)</div>
              <div className="mt-0.5 font-tabular font-semibold text-slate-900 ltr-preserve">
                {formatDZD(financials.classBTotal, 0)} DA
              </div>
            </div>
            <div>
              <div className="text-slate-500">Classe C (Accessoires)</div>
              <div className="mt-0.5 font-tabular font-semibold text-slate-900 ltr-preserve">
                {formatDZD(financials.classCTotal, 0)} DA
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Private BPU Memory Database */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {lang === 'ar'
                ? 'ذاكرة جدول الأسعار الخاص (Private BPU Memory)'
                : 'Base Privée BPU — Mémoire des Prix Vérifiés'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {lang === 'ar'
                ? 'كل سعر مورد معتمد يُحفظ تلقائياً لتعبئة 70%–80% من الصفقات المستقبلية في ثوانٍ.'
                : 'Chaque devis fournisseur retenu est indexé par clé normalisée, marque et wilaya pour pré-chiffrer 70% à 80% de vos futurs appels d’offres.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAutoFillFromPrivateBpu}
              className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
            >
              {t.autoFillPrivateBpu}
            </button>
            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              {lang === 'ar' ? 'إضافة سعر مرجعي' : 'Ajouter un prix BPU'}
            </button>
          </div>
        </div>

        {showAddForm && (
          <form onSubmit={handleCreateBpu} className="px-6 py-4 bg-slate-50 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Désignation BQE *</label>
              <input
                type="text"
                required
                placeholder="Ex. F/P Carrelage grès cérame 60x60"
                value={newEntry.designation}
                onChange={(e) => setNewEntry((p) => ({ ...p, designation: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Unité / Corps d'état</label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={newEntry.unit}
                  onChange={(e) => setNewEntry((p) => ({ ...p, unit: e.target.value }))}
                  className="w-16 px-2 py-1.5 text-xs font-tabular bg-white border border-slate-300 rounded"
                />
                <select
                  value={newEntry.trade}
                  onChange={(e) => setNewEntry((p) => ({ ...p, trade: e.target.value as TradeCategory }))}
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-white border border-slate-300 rounded"
                >
                  {TRADES.map((tr) => (
                    <option key={tr} value={tr}>{tr}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Marque & Fournisseur</label>
              <input
                type="text"
                placeholder="Fournisseur / Marque"
                value={newEntry.supplierName}
                onChange={(e) => setNewEntry((p) => ({ ...p, supplierName: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Déboursé Sec (DA) *</label>
              <input
                type="number"
                required
                min={1}
                placeholder="3200"
                value={newEntry.debourseSecDa}
                onChange={(e) => setNewEntry((p) => ({ ...p, debourseSecDa: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-xs font-tabular bg-white border border-slate-300 rounded"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded"
            >
              Enregistrer
            </button>
          </form>
        )}

        {/* Filter Bar */}
        <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchBpu}
              onChange={(e) => setSearchBpu(e.target.value)}
              placeholder={lang === 'ar' ? 'بحث في قاعدة BPU الخاصة...' : 'Rechercher un ouvrage, marque, fournisseur...'}
              className="w-full ps-9 pe-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>
          <select
            value={wilayaFilter}
            onChange={(e) => setWilayaFilter(e.target.value)}
            className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
          >
            <option value="ALL">Toutes les Wilayas ({privateBpu.length})</option>
            {Array.from(new Set(privateBpu.map((b) => b.wilayaCode))).map((code) => {
              const w = ALGERIA_WILAYAS.find((x) => x.code === code);
              return (
                <option key={code} value={code}>
                  {code} — {w?.nameFr || code}
                </option>
              );
            })}
          </select>
        </div>

        {/* Private BPU Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse" dir="ltr">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 px-4 min-w-[260px]">Désignation & Clé Normalisée</th>
                <th className="py-2.5 px-3 w-16 text-center">Unité</th>
                <th className="py-2.5 px-3">Marque</th>
                <th className="py-2.5 px-3">Wilaya</th>
                <th className="py-2.5 px-3">Fournisseur</th>
                <th className="py-2.5 px-3 text-right">Déboursé Sec (DA)</th>
                <th className="py-2.5 px-3 text-right">Date</th>
                <th className="py-2.5 px-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredBpu.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-4">
                    <div className="text-slate-900 font-medium">{entry.designation}</div>
                    <div className="text-[10px] font-mono text-slate-400 truncate max-w-md">
                      {entry.normalizedItemKey}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-center font-tabular text-slate-700">{entry.unit}</td>
                  <td className="py-2.5 px-3 text-slate-700">{entry.brand}</td>
                  <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                    {entry.wilayaCode} · {entry.wilayaName}
                  </td>
                  <td className="py-2.5 px-3 text-slate-700">{entry.supplierName}</td>
                  <td className="py-2.5 px-3 text-right font-tabular font-semibold text-slate-900">
                    {formatDZD(entry.debourseSecDa, 0)} DA
                  </td>
                  <td className="py-2.5 px-3 text-right font-tabular text-slate-500 whitespace-nowrap">
                    {entry.quotedDate}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => onDeleteBpuEntry(entry.id)}
                      className="p-1 text-slate-400 hover:text-red-600"
                      aria-label="Supprimer entrée BPU"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
