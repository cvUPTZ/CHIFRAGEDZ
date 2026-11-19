import React, { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { AppLang, RfqBatch, SupplierQuote, TenderProject } from '../types/btp';
import { buildWhatsappRfqMessage, UI_COPY } from '../data/i18n';
import { formatDZD } from '../utils/pricingEngine';

interface Props {
  tender: TenderProject;
  lang: AppLang;
  onGenerateBatches: () => void;
  onSelectWinningLineQuote: (
    batchId: string,
    quote: SupplierQuote,
    lineItemId: string,
    unitPriceDa: number,
    brand: string
  ) => void;
  onSelectEntireQuote: (batchId: string, quote: SupplierQuote) => void;
  onOpenSupplierPreview: (batch: RfqBatch) => void;
}

export const Layer3MicroRfqHub: React.FC<Props> = ({
  tender,
  lang,
  onGenerateBatches,
  onSelectWinningLineQuote,
  onSelectEntireQuote,
  onOpenSupplierPreview,
}) => {
  const t = UI_COPY[lang];
  const [activeBatchId, setActiveBatchId] = useState<string>(tender.rfqBatches[0]?.id ?? '');
  const [waLang, setWaLang] = useState<AppLang>(lang);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const activeBatch = useMemo(() => {
    return (
      tender.rfqBatches.find((b) => b.id === activeBatchId) ||
      tender.rfqBatches[0] ||
      null
    );
  }, [tender.rfqBatches, activeBatchId]);

  const buildShareUrl = (token: string) => {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?rfq=${encodeURIComponent(token)}`;
  };

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {lang === 'ar'
              ? 'مركز استشارات واتساب السريعة (Micro-RFQ) ومقارنة الموردين'
              : 'Hub Micro-RFQ WhatsApp & Comparatif Multi-Fournisseurs'}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {lang === 'ar'
              ? 'روابط خفيفة بدون تسجيل دخول (5 إلى 15 بنداً حسب التخصص فقط). لا يتم كشف هوية المقاول ولا أسعار المنافسين أبداً.'
              : 'Liens mobiles sans inscription (5 à 15 lignes filtrées par corps d’état). Aucune exposition de votre identité ni des prix concurrents.'}
          </p>
        </div>

        <button
          type="button"
          onClick={onGenerateBatches}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-[#0F172A] hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {t.generateRfqBatches}
        </button>
      </div>

      {tender.rfqBatches.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <p className="text-sm font-medium text-slate-800">
            {lang === 'ar'
              ? 'لم يتم توليد أي حزمة RFQ بعد. اضغط على الزر أعلاه لتجميع بنود الفئة A حسب التخصص.'
              : 'Aucun lot Micro-RFQ généré. Cliquez sur « Générer lots Micro-RFQ » pour regrouper automatiquement les articles Classe A par corps d’état.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Trade Batches List */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            <div className="px-4 py-3 text-xs font-semibold text-slate-500">
              {lang === 'ar' ? 'التخصصات (Corps d’état)' : 'Lots par corps d’état'} ({tender.rfqBatches.length})
            </div>
            {tender.rfqBatches.map((batch) => {
              const isActive = activeBatch?.id === batch.id;
              return (
                <button
                  key={batch.id}
                  type="button"
                  onClick={() => setActiveBatchId(batch.id)}
                  className={`w-full text-start px-4 py-3 transition-colors ${
                    isActive ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-800'
                  }`}
                >
                  <div className="text-sm font-semibold ltr-preserve">{batch.trade}</div>
                  <div
                    className={`mt-1 text-xs font-tabular ${
                      isActive ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {batch.items.length} {lang === 'ar' ? 'بنود' : 'lignes'} · {batch.quotes.length}{' '}
                    {lang === 'ar' ? 'عروض مستلمة' : 'devis reçus'}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Active Batch Workspace */}
          {activeBatch && (
            <div className="lg:col-span-9 space-y-6">
              {/* Distribution & WhatsApp Panel */}
              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
                  <div>
                    <div className="text-xs text-slate-500 ltr-preserve">
                      {activeBatch.wilayaName} · Échéance {activeBatch.deadline} · {activeBatch.items.length} articles
                    </div>
                    <h3 className="mt-0.5 text-base font-semibold text-slate-900 ltr-preserve">
                      {activeBatch.trade}
                    </h3>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenSupplierPreview(activeBatch)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap"
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                      {t.previewSupplier}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(buildShareUrl(activeBatch.shareToken), 'link')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                    >
                      {copiedKey === 'link' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedKey === 'link' ? 'Lien copié' : t.copyLink}
                    </button>
                  </div>
                </div>

                {/* WhatsApp Pre-formatted Message */}
                <div className="mt-4">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-medium text-slate-700">
                      {lang === 'ar' ? 'رسالة واتساب جاهزة للإرسال للموردين' : 'Message WhatsApp prêt à envoyer aux fournisseurs'}
                    </span>
                    <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded">
                      <button
                        type="button"
                        onClick={() => setWaLang('fr')}
                        className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                          waLang === 'fr' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        FR
                      </button>
                      <button
                        type="button"
                        onClick={() => setWaLang('ar')}
                        className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                          waLang === 'ar' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        AR
                      </button>
                    </div>
                  </div>

                  {(() => {
                    const shareUrl = buildShareUrl(activeBatch.shareToken);
                    const waText = buildWhatsappRfqMessage(activeBatch, shareUrl, waLang);
                    const waHref = `https://wa.me/?text=${encodeURIComponent(waText)}`;
                    return (
                      <div>
                        <pre
                          dir={waLang === 'ar' ? 'rtl' : 'ltr'}
                          className="p-3.5 text-xs leading-relaxed text-slate-800 bg-slate-50 border border-slate-200 rounded-md whitespace-pre-wrap font-sans max-h-48 overflow-y-auto"
                        >
                          {waText}
                        </pre>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <a
                            href={waHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-md transition-colors whitespace-nowrap"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            {t.openWhatsapp}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() => handleCopy(waText, 'wa')}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                          >
                            {copiedKey === 'wa' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                            {copiedKey === 'wa' ? 'Copié' : t.copyWhatsapp}
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Multi-Supplier Side-by-Side Comparison Matrix */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">{t.compareTitle}</h4>
                    <p className="text-xs text-slate-500">
                      {lang === 'ar'
                        ? 'اضغط لاعتماد أفضل سعر لكل بند أو للفاتورة كاملة — يتم تحديث BQE وحفظ السعر تلقائياً في BPU الخاص.'
                        : 'Sélectionnez le meilleur prix ligne par ligne ou par fournisseur global — verrouille « Devis Vérifié » et alimente votre BPU Privé.'}
                    </p>
                  </div>
                  <span className="text-xs font-tabular text-slate-500">
                    {activeBatch.quotes.length} {lang === 'ar' ? 'مورد(ون)' : 'fournisseur(s)'}
                  </span>
                </div>

                {activeBatch.quotes.length === 0 ? (
                  <div className="p-8 text-center">
                    <p className="text-sm text-slate-600">
                      {lang === 'ar'
                        ? 'لم يتم استلام أي عرض سعر بعد لهذه الحزمة. جرب "معاينة واجهة المورد (هاتف)" لإدخال عرض تجريبي فوري.'
                        : 'Aucun devis fournisseur reçu pour ce lot. Cliquez sur « Simuler Vue Fournisseur (Mobile) » pour tester la saisie fournisseur en 60 secondes.'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse" dir="ltr">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                          <th className="py-3 px-4 min-w-[240px]">Article BQE</th>
                          <th className="py-3 px-2 w-20 text-right">Qté</th>
                          {activeBatch.quotes.map((q) => {
                            const totalForQuote = activeBatch.items.reduce((acc, it) => {
                              const lq = q.lineQuotes.find((x) => x.lineItemId === it.lineItemId);
                              return acc + (lq?.unitPriceDa || 0) * it.quantity;
                            }, 0);
                            return (
                              <th key={q.id} className="py-3 px-4 min-w-[210px] border-s border-slate-200 align-top">
                                <div className="text-xs font-semibold text-slate-900">{q.supplierName}</div>
                                <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                                  Délai {q.leadTimeDays}j · Total DS: <span className="font-tabular font-semibold text-slate-800">{formatDZD(totalForQuote, 0)} DA</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => onSelectEntireQuote(activeBatch.id, q)}
                                  className="mt-2 px-2.5 py-1 text-[11px] font-medium text-white bg-slate-900 hover:bg-slate-800 rounded transition-colors"
                                >
                                  Retenir tout ce devis
                                </button>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {activeBatch.items.map((item) => {
                          const tenderItem = tender.lineItems.find((li) => li.id === item.lineItemId);
                          const prices = activeBatch.quotes
                            .map((q) => q.lineQuotes.find((lq) => lq.lineItemId === item.lineItemId)?.unitPriceDa || 0)
                            .filter((p) => p > 0);
                          const lowestPrice = prices.length > 0 ? Math.min(...prices) : 0;

                          return (
                            <tr key={item.lineItemId} className="hover:bg-slate-50/70">
                              <td className="py-3 px-4 align-top">
                                <div className="font-tabular text-[11px] font-semibold text-slate-500">
                                  Art. {item.articleNo}
                                </div>
                                <div className="mt-0.5 text-slate-900 leading-snug">
                                  {item.designation}
                                </div>
                              </td>
                              <td className="py-3 px-2 text-right font-tabular text-slate-700 align-top">
                                {item.quantity} {item.unit}
                              </td>
                              {activeBatch.quotes.map((q) => {
                                const lq = q.lineQuotes.find((x) => x.lineItemId === item.lineItemId);
                                const isLowest = lq && lq.unitPriceDa > 0 && lq.unitPriceDa === lowestPrice;
                                const isChosen =
                                  tenderItem?.selectedQuoteId === q.id &&
                                  tenderItem?.priceSource === 'supplier_verified';

                                return (
                                  <td
                                    key={q.id}
                                    className={`py-3 px-4 border-s border-slate-200 align-top ${
                                      isChosen ? 'bg-emerald-50/60' : isLowest ? 'bg-sky-50/40' : ''
                                    }`}
                                  >
                                    {!lq || lq.unitPriceDa <= 0 ? (
                                      <span className="text-slate-400">Non chiffré</span>
                                    ) : (
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-sm font-semibold font-tabular text-slate-900">
                                            {formatDZD(lq.unitPriceDa, 0)} DA
                                          </span>
                                          {isLowest && (
                                            <span className="text-[10px] font-semibold text-emerald-700">
                                              Moins-disant
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[11px] text-slate-600">{lq.brand || '—'}</div>
                                        <div className="text-[10px] text-slate-400">{lq.availability}</div>
                                        <div className="pt-1">
                                          {isChosen ? (
                                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                                              <CheckCircle2 className="w-3.5 h-3.5" />
                                              {t.selectedWinner}
                                            </span>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                onSelectWinningLineQuote(
                                                  activeBatch.id,
                                                  q,
                                                  item.lineItemId,
                                                  lq.unitPriceDa,
                                                  lq.brand
                                                )
                                              }
                                              className="px-2.5 py-1 text-[11px] font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-900 hover:text-white hover:border-slate-900 rounded transition-colors"
                                            >
                                              {t.selectWinner}
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
