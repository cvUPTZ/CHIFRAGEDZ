import React, { useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Loader2,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { RfqBatch, SupplierLineQuote, SupplierQuote } from '../types/btp';
import { formatDZD } from '../utils/pricingEngine';

interface Props {
  batch: RfqBatch;
  isStandalone?: boolean;
  onClose?: () => void;
  onSubmitQuote: (quote: Omit<SupplierQuote, 'id' | 'selected' | 'submittedAt'>) => Promise<void> | void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.includes(',') ? s.split(',')[1] : s);
    };
    reader.onerror = () => reject(new Error('Lecture image impossible.'));
    reader.readAsDataURL(file);
  });
}

export const SupplierMicroRfqPortal: React.FC<Props> = ({
  batch,
  isStandalone = false,
  onClose,
  onSubmitQuote,
}) => {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [supplierName, setSupplierName] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [prices, setPrices] = useState<Record<string, { unitPriceDa: string; brand: string; availability: string }>>(
    () =>
      Object.fromEntries(
        batch.items.map((it) => [
          it.lineItemId,
          { unitPriceDa: '', brand: '', availability: 'En stock' },
        ])
      )
  );
  const [parsingPhoto, setParsingPhoto] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleProformaPhoto = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setParsingPhoto(true);
    setErrorMsg(null);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch('/api/parse-proforma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: file.type || 'image/jpeg',
          rfqItems: batch.items,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec de la lecture proforma.');
      if (data.supplierName && !supplierName) setSupplierName(data.supplierName);
      if (data.leadTimeDays) setLeadTimeDays(Number(data.leadTimeDays));
      if (data.notes && !notes) setNotes(data.notes);
      if (Array.isArray(data.matchedQuotes)) {
        setPrices((prev) => {
          const next = { ...prev };
          for (const mq of data.matchedQuotes) {
            if (next[mq.lineItemId] && Number(mq.unitPriceDa) > 0) {
              next[mq.lineItemId] = {
                unitPriceDa: String(mq.unitPriceDa),
                brand: mq.brand || next[mq.lineItemId].brand,
                availability: mq.availability || 'En stock',
              };
            }
          }
          return next;
        });
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Erreur lecture proforma.');
    } finally {
      setParsingPhoto(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!supplierName.trim()) {
      setErrorMsg('Veuillez indiquer le nom de votre société ou fournisseur.');
      return;
    }

    const lineQuotes: SupplierLineQuote[] = batch.items.map((it) => {
      const entry = prices[it.lineItemId] || { unitPriceDa: '0', brand: '', availability: '' };
      return {
        lineItemId: it.lineItemId,
        unitPriceDa: Math.max(0, Number(entry.unitPriceDa) || 0),
        brand: entry.brand.trim(),
        availability: entry.availability.trim() || 'Sur commande',
      };
    });

    if (!lineQuotes.some((lq) => lq.unitPriceDa > 0)) {
      setErrorMsg('Veuillez saisir au moins un prix unitaire (DA HT).');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmitQuote({
        shareToken: batch.shareToken,
        tenderId: batch.tenderId,
        supplierName: supplierName.trim(),
        supplierPhone: supplierPhone.trim(),
        leadTimeDays: Number(leadTimeDays) || 7,
        notes: notes.trim(),
        lineQuotes,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Erreur lors de l’envoi du devis.');
    } finally {
      setSubmitting(false);
    }
  };

  const estimatedTotal = batch.items.reduce((sum, it) => {
    const p = Number(prices[it.lineItemId]?.unitPriceDa) || 0;
    return sum + p * it.quantity;
  }, 0);

  const cardBody = (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden w-full max-w-xl mx-auto" dir="ltr">
      <div className="bg-[#0F172A] text-white px-5 py-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] text-slate-300">
            Demande de Prix Express (Sans Compte) · {batch.wilayaName}
          </div>
          <h2 className="mt-0.5 text-base font-semibold">{batch.trade}</h2>
          <div className="mt-1 text-xs text-slate-300">
            {batch.items.length} article(s) · Réponse souhaitée avant le {batch.deadline}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-300 hover:text-white rounded"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {submitted ? (
        <div className="p-8 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
          <h3 className="mt-3 text-base font-semibold text-slate-900">
            Devis transmis avec succès
          </h3>
          <p className="mt-1 text-xs text-slate-600">
            Merci {supplierName}. Vos prix unitaires en DA HT ont été enregistrés de façon confidentielle.
          </p>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="mt-5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md"
            >
              Retour au comparatif fournisseur
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="p-5 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Proforma Photo AI Quick Fill */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-900">
                Gagnez du temps : photo de votre facture proforma
              </div>
              <div className="text-[11px] text-slate-500">
                Prenez une photo de votre proforma cachetée pour pré-remplir les prix DA HT automatiquement.
              </div>
            </div>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => handleProformaPhoto(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              disabled={parsingPhoto}
              onClick={() => photoInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-md whitespace-nowrap"
            >
              {parsingPhoto ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Lecture IA...
                </>
              ) : (
                <>
                  <Camera className="w-3.5 h-3.5" />
                  Importer Proforma
                </>
              )}
            </button>
          </div>

          {/* Supplier Identification */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Raison sociale / Fournisseur *
              </label>
              <input
                type="text"
                required
                placeholder="Ex. SARL Atlas Énergie (Alger)"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Délai livraison (jours)
              </label>
              <input
                type="number"
                min={0}
                max={180}
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Téléphone / WhatsApp (optionnel)
              </label>
              <input
                type="tel"
                placeholder="+213 5XX XX XX XX"
                value={supplierPhone}
                onChange={(e) => setSupplierPhone(e.target.value)}
                className="w-full px-3 py-2 text-xs font-tabular border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Conditions (livraison, validité)
              </label>
              <input
                type="text"
                placeholder="Ex. Rendu Béjaïa, validité 30j"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>

          {/* Line Items */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-900">
              Articles à chiffrer (Prix Unitaires en DA HT)
            </div>
            {batch.items.map((it) => {
              const row = prices[it.lineItemId] || { unitPriceDa: '', brand: '', availability: '' };
              return (
                <div key={it.lineItemId} className="p-3.5 border border-slate-200 rounded-md bg-white space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-xs text-slate-900 leading-snug">
                      <span className="font-tabular font-semibold text-slate-500 me-1.5">
                        [{it.articleNo}]
                      </span>
                      {it.designation}
                    </div>
                    <div className="text-xs font-tabular font-semibold text-slate-800 whitespace-nowrap shrink-0">
                      {it.quantity} {it.unit}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-0.5">PU (DA HT)</label>
                      <input
                        type="number"
                        min={0}
                        step="10"
                        placeholder="0 DA"
                        value={row.unitPriceDa}
                        onChange={(e) =>
                          setPrices((prev) => ({
                            ...prev,
                            [it.lineItemId]: { ...row, unitPriceDa: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 text-xs font-tabular border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-0.5">Marque / Origine</label>
                      <input
                        type="text"
                        placeholder="Ex. Schneider / Perkins"
                        value={row.brand}
                        onChange={(e) =>
                          setPrices((prev) => ({
                            ...prev,
                            [it.lineItemId]: { ...row, brand: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-0.5">Disponibilité</label>
                      <input
                        type="text"
                        placeholder="En stock / 10j"
                        value={row.availability}
                        onChange={(e) =>
                          setPrices((prev) => ({
                            ...prev,
                            [it.lineItemId]: { ...row, availability: e.target.value },
                          }))
                        }
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {errorMsg && (
            <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
              {errorMsg}
            </div>
          )}

          {/* Footer Submit */}
          <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-slate-500">Total Offre HT Estimé</div>
              <div className="text-base font-semibold font-tabular text-slate-900">
                {formatDZD(estimatedTotal, 0)} DA HT
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 rounded-md transition-colors whitespace-nowrap"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Envoyer Devis Confidentiel
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Offre strictement confidentielle : vos prix ne sont jamais partagés avec d'autres fournisseurs.</span>
          </div>
        </form>
      )}
    </div>
  );

  if (isStandalone) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] py-8 px-4">
        {cardBody}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
      {cardBody}
    </div>
  );
};
