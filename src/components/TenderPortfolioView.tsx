import React, { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  FolderOpen,
  Lock,
  Plus,
  Trash2,
} from 'lucide-react';
import { AppLang, TenderProject } from '../types/btp';
import { ALGERIA_WILAYAS } from '../data/algeriaReference';
import { computeTenderFinancials, formatDZD } from '../utils/pricingEngine';

interface Props {
  tenders: TenderProject[];
  activeTenderId: string | null;
  lang: AppLang;
  onSelectTender: (id: string) => void;
  onCreateTender: (payload: {
    title: string;
    reference: string;
    clientName: string;
    wilayaCode: string;
  }) => Promise<void> | void;
  onDuplicateTender: (id: string) => void;
  onLockSubmitted: (id: string) => void;
  onDeleteTender: (id: string) => void;
}

export const TenderPortfolioView: React.FC<Props> = ({
  tenders,
  activeTenderId,
  lang,
  onSelectTender,
  onCreateTender,
  onDuplicateTender,
  onLockSubmitted,
  onDeleteTender,
}) => {
  const [showCreate, setShowCreate] = useState(tenders.length === 0);
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [clientName, setClientName] = useState('');
  const [wilayaCode, setWilayaCode] = useState('16');
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !reference.trim() || creating) return;
    setCreating(true);
    try {
      await onCreateTender({
        title: title.trim(),
        reference: reference.trim(),
        clientName: clientName.trim() || "Maître d'Ouvrage Public",
        wilayaCode,
      });
      setTitle('');
      setReference('');
      setClientName('');
      setShowCreate(false);
    } finally {
      setCreating(false);
    }
  };

  const statusLabel = (status: TenderProject['status']) => {
    switch (status) {
      case 'submitted':
        return lang === 'ar' ? 'مودع · مقفل' : 'Soumis · Verrouillé';
      case 'ready_to_submit':
        return lang === 'ar' ? 'جاهز للإيداع' : 'Prêt à déposer';
      case 'rfq_pending':
        return lang === 'ar' ? 'في انتظار الموردين' : 'RFQ en cours';
      case 'auditing':
        return lang === 'ar' ? 'قيد التدقيق والتسعير' : 'En audit / chiffrage';
      default:
        return lang === 'ar' ? 'مسودة' : 'Brouillon';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {lang === 'ar'
              ? 'محفظة الصفقات العمومية (Firestore)'
              : 'Portefeuille des Appels d’Offres BTP'}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {lang === 'ar'
              ? 'جميع صفقاتك العمومية محفوظة ومزامنة مباشرة مع قاعدة البيانات السحابية.'
              : 'Tous vos dossiers d’appels d’offres sont enregistrés et synchronisés en temps réel dans votre base de données.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#0F172A] hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          {lang === 'ar' ? 'صفقة جديدة' : 'Nouvel Appel d’Offres'}
        </button>
      </div>

      {/* Create New Tender Form */}
      {(showCreate || tenders.length === 0) && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            {lang === 'ar' ? 'إنشاء ملف صفقة جديد' : 'Créer un nouveau dossier d’appel d’offres'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="lg:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Intitulé du projet *
              </label>
              <input
                type="text"
                required
                placeholder="Ex. Réalisation d'un Groupe Scolaire Type D"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Référence AO *
              </label>
              <input
                type="text"
                required
                placeholder="AO N° 22/2026/DEP"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-full px-3 py-2 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Wilaya</label>
              <select
                value={wilayaCode}
                onChange={(e) => setWilayaCode(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white focus:outline-none focus:border-slate-900"
              >
                {ALGERIA_WILAYAS.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} — {lang === 'ar' ? w.nameAr : w.nameFr}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Maître d’Ouvrage (Organisme contractant)
              </label>
              <input
                type="text"
                placeholder="Ex. Direction des Équipements Publics"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                disabled={creating}
                className="flex-1 px-4 py-2 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 disabled:bg-slate-400 rounded-md"
              >
                {creating ? 'Création...' : 'Créer & Ouvrir'}
              </button>
              {tenders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                >
                  Annuler
                </button>
              )}
            </div>
          </div>
        </form>
      )}

      {/* Tenders Portfolio Table */}
      {tenders.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <p className="text-sm font-medium text-slate-800">
            {lang === 'ar'
              ? 'لا توجد صفقات مسجلة في قاعدة البيانات بعد.'
              : 'Aucun appel d’offres enregistré dans votre base de données.'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {lang === 'ar'
              ? 'أنشئ صفقتك الأولى أعلاه ثم قم برفع ملف BQE (PDF / صور CamScanner أو Excel).'
              : 'Créez votre premier appel d’offres ci-dessus puis importez votre BQE scanné (PDF / JPG) ou Excel (.xlsx).'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse" dir="ltr">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Référence & Projet</th>
                  <th className="py-3 px-3">Wilaya</th>
                  <th className="py-3 px-3">Statut</th>
                  <th className="py-3 px-3 text-right">Avancement</th>
                  <th className="py-3 px-3 text-right">Montant TTC (DA)</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {tenders.map((item) => {
                  const fin = computeTenderFinancials(item);
                  const isActive = item.id === activeTenderId;
                  const isLocked = item.status === 'submitted';

                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors ${
                        isActive ? 'bg-sky-50/50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-3.5 px-4 max-w-md">
                        <div className="flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="font-tabular font-semibold text-slate-700">
                            {item.reference}
                          </span>
                          {isActive && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-blue-700">Actif</span>
                            </>
                          )}
                        </div>
                        <div className="mt-0.5 font-semibold text-slate-900">{item.title}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                          {item.clientName}
                        </div>
                      </td>

                      <td className="py-3.5 px-3 whitespace-nowrap text-slate-700">
                        {item.wilayaCode} · {item.wilayaName}
                      </td>

                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 font-medium ${
                            isLocked
                              ? 'text-emerald-700'
                              : fin.proformaRequiredCount > 0
                              ? 'text-amber-700'
                              : 'text-slate-700'
                          }`}
                        >
                          {isLocked ? (
                            <Lock className="w-3.5 h-3.5" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          )}
                          {statusLabel(item.status)}
                        </span>
                      </td>

                      <td className="py-3.5 px-3 text-right font-tabular text-slate-600 whitespace-nowrap">
                        {fin.verifiedCount}/{fin.totalItems} vérifiés · {fin.proformaRequiredCount} Cl.A
                      </td>

                      <td className="py-3.5 px-3 text-right font-tabular font-semibold text-slate-900 whitespace-nowrap">
                        {formatDZD(fin.totalTtc, 0)} DA
                      </td>

                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSelectTender(item.id)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded transition-colors ${
                              isActive
                                ? 'bg-slate-900 text-white'
                                : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                            }`}
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            {isActive ? 'Ouvert' : 'Ouvrir'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDuplicateTender(item.id)}
                            className="p-1.5 text-slate-500 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded"
                            title="Dupliquer"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          {!isLocked && (
                            <>
                              <button
                                type="button"
                                onClick={() => onLockSubmitted(item.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition-colors"
                                title="Verrouiller l'offre comme déposée (irréversible)"
                              >
                                <Lock className="w-3.5 h-3.5" />
                                Déposer
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteTender(item.id)}
                                className="p-1.5 text-slate-400 hover:text-red-600 rounded"
                                title="Supprimer brouillon"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
