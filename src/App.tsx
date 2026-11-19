import React, { useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  Cloud,
  Code2,
  Database,
  Download,
  FileSearch,
  Globe,
  LogIn,
  LogOut,
  MessageSquare,
  Sliders,
} from 'lucide-react';
import {
  AppLang,
  LineItem,
  PrivateBpuEntry,
  RfqBatch,
  SupplierQuote,
  TenderLot,
  TenderProject,
  TradeCategory,
} from './types/btp';
import {
  createSampleAlgerianTender,
  STARTER_PRIVATE_BPU,
} from './data/algeriaReference';
import { UI_COPY } from './data/i18n';
import {
  computeTenderFinancials,
  formatDZD,
  matchPrivateBpu,
  normalizeItemKey,
} from './utils/pricingEngine';
import { exportTenderToExcel } from './utils/excelService';
import { auth, googleProvider, testFirestoreConnection } from './lib/firebase';
import {
  fetchPublicRfqBatch,
  fetchQuotesForOwnerBatch,
  loadPrivateBpuFromFirestore,
  publishRfqBatchToFirestore,
  savePrivateBpuEntryToFirestore,
  saveTenderToFirestore,
  submitPublicSupplierQuote,
  syncUserProfile,
} from './services/firestoreSync';
import { Layer1IngestionAudit } from './components/Layer1IngestionAudit';
import { Layer2PricingEngine } from './components/Layer2PricingEngine';
import { Layer3MicroRfqHub } from './components/Layer3MicroRfqHub';
import { Layer4BpuExport } from './components/Layer4BpuExport';
import { SupplierMicroRfqPortal } from './components/SupplierMicroRfqPortal';
import { ArchitectureSpecsView } from './components/ArchitectureSpecsView';
import { ErrorBoundary } from './components/ErrorBoundary';

type ActiveTab = 'ingestion' | 'pricing' | 'rfq' | 'bpu' | 'specs';

const STORAGE_TENDER_KEY = 'chiffragedz_tender_v1';
const STORAGE_BPU_KEY = 'chiffragedz_bpu_v1';

function loadInitialTender(): TenderProject {
  try {
    const raw = localStorage.getItem(STORAGE_TENDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback to sample
  }
  return createSampleAlgerianTender();
}

function loadInitialBpu(): PrivateBpuEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_BPU_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback to starter
  }
  return STARTER_PRIVATE_BPU;
}

function ChiffrageApp() {
  const [lang, setLang] = useState<AppLang>('fr');
  const [activeTab, setActiveTab] = useState<ActiveTab>('ingestion');
  const [tender, setTender] = useState<TenderProject>(loadInitialTender);
  const [privateBpu, setPrivateBpu] = useState<PrivateBpuEntry[]>(loadInitialBpu);
  const [user, setUser] = useState<User | null>(null);
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [previewRfqBatch, setPreviewRfqBatch] = useState<RfqBatch | null>(null);

  // Standalone no-login supplier route (?rfq=<shareToken>)
  const [standaloneToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('rfq');
  });
  const [standaloneBatch, setStandaloneBatch] = useState<(RfqBatch & { ownerId?: string }) | null>(null);
  const [standaloneLoading, setStandaloneLoading] = useState(Boolean(standaloneToken));

  const t = UI_COPY[lang];

  // Test Firestore connection once on boot
  useEffect(() => {
    testFirestoreConnection();
  }, []);

  // Load standalone supplier Micro-RFQ batch if ?rfq= token is present
  useEffect(() => {
    if (!standaloneToken) return;
    let active = true;
    (async () => {
      setStandaloneLoading(true);
      try {
        const remote = await fetchPublicRfqBatch(standaloneToken);
        if (active && remote) {
          setStandaloneBatch(remote);
          setStandaloneLoading(false);
          return;
        }
      } catch {
        // Fallback to local batch if previewing unsynced demo token
      }
      if (active) {
        const localMatch = tender.rfqBatches.find((b) => b.shareToken === standaloneToken) || null;
        setStandaloneBatch(localMatch);
        setStandaloneLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [standaloneToken, tender.rfqBatches]);

  // Listen to Firebase Google Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u && u.emailVerified) {
        try {
          await syncUserProfile(u.uid, u.displayName || 'Entrepreneur BTP', lang);
          const remoteBpu = await loadPrivateBpuFromFirestore(u.uid);
          if (remoteBpu.length > 0) {
            setPrivateBpu(remoteBpu);
          }
          // Fetch any live supplier quotes submitted on published batches
          const updatedBatches = await Promise.all(
            tender.rfqBatches.map(async (b) => {
              try {
                const liveQuotes = await fetchQuotesForOwnerBatch(u.uid, b.shareToken);
                if (liveQuotes.length === 0) return b;
                const existingIds = new Set(b.quotes.map((q) => q.id));
                const merged = [...b.quotes, ...liveQuotes.filter((lq) => !existingIds.has(lq.id))];
                return { ...b, quotes: merged };
              } catch {
                return b;
              }
            })
          );
          setTender((prev) => ({ ...prev, rfqBatches: updatedBatches }));
        } catch {
          // Non-blocking sync warning
        }
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist locally
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_TENDER_KEY, JSON.stringify(tender));
    } catch {
      // ignore storage quota
    }
  }, [tender]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_BPU_KEY, JSON.stringify(privateBpu));
    } catch {
      // ignore storage quota
    }
  }, [privateBpu]);

  // Update HTML dir & lang attributes cleanly
  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const financials = useMemo(() => computeTenderFinancials(tender), [tender]);

  const handleGoogleAuth = async () => {
    try {
      if (user) {
        await signOut(auth);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err) {
      console.error('Auth error:', err);
    }
  };

  const handleSyncToCloud = async () => {
    if (!user) return;
    setSyncingCloud(true);
    setSyncNotice(null);
    try {
      await saveTenderToFirestore(user.uid, tender);
      for (const batch of tender.rfqBatches) {
        await publishRfqBatchToFirestore(user.uid, batch);
      }
      for (const entry of privateBpu) {
        await savePrivateBpuEntryToFirestore(user.uid, entry);
      }
      setSyncNotice(lang === 'ar' ? 'تمت المزامنة بنجاح مع السحابة.' : 'Offre, RFQ et BPU Privé synchronisés.');
      setTimeout(() => setSyncNotice(null), 3500);
    } catch (err) {
      setSyncNotice(err instanceof Error ? err.message : 'Erreur de synchronisation.');
    } finally {
      setSyncingCloud(false);
    }
  };

  // --- Layer 1 Handlers ---
  const handleReplaceExtractedData = (payload: {
    title?: string;
    reference?: string;
    clientName?: string;
    lots: TenderLot[];
    lineItems: LineItem[];
    anomalies: TenderProject['anomalies'];
  }) => {
    setTender((prev) => ({
      ...prev,
      title: payload.title || prev.title,
      reference: payload.reference || prev.reference,
      clientName: payload.clientName || prev.clientName,
      lots: payload.lots,
      lineItems: payload.lineItems,
      anomalies: payload.anomalies,
      rfqBatches: [],
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleResolveAnomaly = (anomalyId: string) => {
    setTender((prev) => ({
      ...prev,
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
  };

  const handleFixItemUnit = (lineItemId: string, newUnit: string, anomalyId: string) => {
    setTender((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) =>
        li.id === lineItemId
          ? { ...li, unit: newUnit, normalizedKey: normalizeItemKey(li.designation, newUnit) }
          : li
      ),
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
  };

  const handleFixItemQuantity = (lineItemId: string, newQty: number, anomalyId: string) => {
    setTender((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) => (li.id === lineItemId ? { ...li, quantity: newQty } : li)),
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
  };

  const handleApplySiteMultiplier = (multiplierPct: number, anomalyId: string, isOverhead = false) => {
    setTender((prev) => ({
      ...prev,
      globalOccupiedSitePct: isOverhead
        ? prev.globalOccupiedSitePct
        : Math.max(prev.globalOccupiedSitePct, multiplierPct),
      globalOverheadPct: isOverhead ? prev.globalOverheadPct + multiplierPct : prev.globalOverheadPct,
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
  };

  // --- Layer 2 Handlers ---
  const handleUpdateGlobalCoeff = (
    patch: Partial<
      Pick<
        TenderProject,
        | 'wilayaCode'
        | 'wilayaName'
        | 'globalTransportPct'
        | 'globalOccupiedSitePct'
        | 'globalOverheadPct'
        | 'globalMarginPct'
        | 'tvaRate'
      >
    >
  ) => {
    setTender((prev) => ({ ...prev, ...patch, updatedAt: new Date().toISOString() }));
  };

  const handleUpdateLotOverride = (
    lotId: string,
    patch: Partial<
      Pick<
        TenderLot,
        'overrideTransportPct' | 'overrideOccupiedSitePct' | 'overrideOverheadPct' | 'overrideMarginPct'
      >
    >
  ) => {
    setTender((prev) => ({
      ...prev,
      lots: prev.lots.map((l) => (l.id === lotId ? { ...l, ...patch } : l)),
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleUpdateLineItem = (itemId: string, patch: Partial<LineItem>) => {
    setTender((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) => (li.id === itemId ? { ...li, ...patch } : li)),
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleAutoFillFromPrivateBpu = (): number => {
    let matchedCount = 0;
    setTender((prev) => {
      const updated = prev.lineItems.map((li) => {
        if (li.priceSource === 'supplier_verified') return li;
        const match = matchPrivateBpu(li, privateBpu, prev.wilayaCode);
        if (!match) return li;
        matchedCount++;
        return {
          ...li,
          debourseSecDa: match.debourseSecDa,
          priceSource: 'private_bpu' as const,
          selectedSupplierName: `${match.supplierName} (BPU Privé)`,
          brand: match.brand,
          confidenceRangePct: 5,
        };
      });
      return { ...prev, lineItems: updated, updatedAt: new Date().toISOString() };
    });
    return matchedCount;
  };

  // --- Layer 3 Handlers ---
  const handleGenerateRfqBatches = () => {
    const eligible = tender.lineItems.filter((li) => li.abcClass === 'A' || li.includeInRfq);
    const byTrade = new Map<TradeCategory, LineItem[]>();
    for (const item of eligible) {
      const list = byTrade.get(item.trade) || [];
      list.push(item);
      byTrade.set(item.trade, list);
    }

    const nextBatches: RfqBatch[] = [];
    const deadline = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

    byTrade.forEach((items, trade) => {
      const existing = tender.rfqBatches.find((b) => b.trade === trade);
      const token =
        existing?.shareToken ||
        `rfq_${tender.wilayaCode}_${Math.random().toString(36).slice(2, 10)}`;

      const batch: RfqBatch = {
        id: existing?.id || `rfq_${trade.slice(0, 6).replace(/\W/g, '')}_${Date.now()}`,
        shareToken: token,
        tenderId: tender.id,
        trade,
        wilayaName: `${tender.wilayaName} (${tender.wilayaCode})`,
        deadline: existing?.deadline || deadline,
        status: 'open',
        createdAt: existing?.createdAt || new Date().toISOString(),
        items: items.slice(0, 15).map((li) => ({
          lineItemId: li.id,
          articleNo: li.articleNo,
          designation: li.designation,
          unit: li.unit,
          quantity: li.quantity,
        })),
        quotes: existing?.quotes || [],
      };
      nextBatches.push(batch);
      if (user) {
        publishRfqBatchToFirestore(user.uid, batch).catch(() => {});
      }
    });

    setTender((prev) => ({
      ...prev,
      rfqBatches: nextBatches,
      updatedAt: new Date().toISOString(),
    }));
  };

  const recordToPrivateBpu = (item: LineItem, unitPriceDa: number, brand: string, supplierName: string) => {
    const newBpu: PrivateBpuEntry = {
      id: `bpu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      normalizedItemKey: item.normalizedKey,
      designation: item.designation,
      unit: item.unit,
      brand: brand || 'Standard',
      wilayaCode: tender.wilayaCode,
      wilayaName: tender.wilayaName,
      trade: item.trade,
      supplierName,
      debourseSecDa: unitPriceDa,
      quotedDate: new Date().toISOString().slice(0, 10),
    };
    setPrivateBpu((prev) => {
      const withoutDup = prev.filter(
        (p) => !(p.normalizedItemKey === newBpu.normalizedItemKey && p.wilayaCode === newBpu.wilayaCode)
      );
      return [newBpu, ...withoutDup];
    });
    if (user) {
      savePrivateBpuEntryToFirestore(user.uid, newBpu).catch(() => {});
    }
  };

  const handleSelectWinningLineQuote = (
    _batchId: string,
    quote: SupplierQuote,
    lineItemId: string,
    unitPriceDa: number,
    brand: string
  ) => {
    const targetItem = tender.lineItems.find((li) => li.id === lineItemId);
    setTender((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) =>
        li.id === lineItemId
          ? {
              ...li,
              debourseSecDa: unitPriceDa,
              priceSource: 'supplier_verified' as const,
              selectedQuoteId: quote.id,
              selectedSupplierName: quote.supplierName,
              brand: brand || li.brand,
              confidenceRangePct: 0,
            }
          : li
      ),
      updatedAt: new Date().toISOString(),
    }));
    if (targetItem) {
      recordToPrivateBpu(targetItem, unitPriceDa, brand, quote.supplierName);
    }
  };

  const handleSelectEntireQuote = (batchId: string, quote: SupplierQuote) => {
    for (const lq of quote.lineQuotes) {
      if (lq.unitPriceDa > 0) {
        handleSelectWinningLineQuote(batchId, quote, lq.lineItemId, lq.unitPriceDa, lq.brand);
      }
    }
  };

  const handleSupplierPreviewSubmit = async (
    payload: Omit<SupplierQuote, 'id' | 'selected' | 'submittedAt'>
  ) => {
    const newQuote: SupplierQuote = {
      ...payload,
      id: `q_${Date.now()}`,
      selected: false,
      submittedAt: new Date().toISOString(),
    };
    setTender((prev) => ({
      ...prev,
      rfqBatches: prev.rfqBatches.map((b) =>
        b.shareToken === payload.shareToken ? { ...b, quotes: [...b.quotes, newQuote] } : b
      ),
    }));
  };

  // --- Standalone Supplier Portal Route ---
  if (standaloneToken) {
    if (standaloneLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-sm text-slate-600">
          Chargement de la demande de prix Micro-RFQ...
        </div>
      );
    }
    if (!standaloneBatch) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-6">
          <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-md w-full text-center">
            <h2 className="text-base font-semibold text-slate-900">Lien Micro-RFQ introuvable ou expiré</h2>
            <p className="mt-2 text-xs text-slate-600">
              Vérifiez le lien WhatsApp reçu ou demandez un nouveau lien au conducteur de travaux.
            </p>
            <a
              href={window.location.pathname}
              className="mt-4 inline-block px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md"
            >
              Accéder à la plateforme ChiffrageDZ
            </a>
          </div>
        </div>
      );
    }

    return (
      <SupplierMicroRfqPortal
        batch={standaloneBatch}
        isStandalone
        onSubmitQuote={async (quotePayload) => {
          if (standaloneBatch.ownerId) {
            await submitPublicSupplierQuote(
              standaloneBatch.shareToken,
              standaloneBatch.tenderId,
              standaloneBatch.ownerId,
              quotePayload
            );
          } else {
            await handleSupplierPreviewSubmit(quotePayload);
          }
        }}
      />
    );
  }

  const navItems: Array<{ id: ActiveTab; label: string; icon: React.ReactNode; badge?: number }> = [
    {
      id: 'ingestion',
      label: t.navIngestion,
      icon: <FileSearch className="w-4 h-4 shrink-0" />,
      badge: financials.openAnomalies > 0 ? financials.openAnomalies : undefined,
    },
    {
      id: 'pricing',
      label: t.navPricing,
      icon: <Sliders className="w-4 h-4 shrink-0" />,
      badge: financials.proformaRequiredCount > 0 ? financials.proformaRequiredCount : undefined,
    },
    {
      id: 'rfq',
      label: t.navRfq,
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      badge: tender.rfqBatches.reduce((sum, b) => sum + b.quotes.length, 0) || undefined,
    },
    {
      id: 'bpu',
      label: t.navBpu,
      icon: <Database className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'specs',
      label: t.navSpecs,
      icon: <Code2 className="w-4 h-4 shrink-0" />,
    },
  ];

  const activeNavLabel = navItems.find((n) => n.id === activeTab)?.label || '';

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col lg:flex-row">
      {/* Left Sidebar Navigation (250px Desktop) */}
      <aside className="w-full lg:w-[252px] bg-[#0F172A] text-slate-100 shrink-0 flex flex-col justify-between border-b lg:border-b-0 lg:border-e border-slate-800">
        <div>
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-2">
            <span className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0">
              {t.brand}
            </span>
            <button
              type="button"
              onClick={() => setLang((prev) => (prev === 'fr' ? 'ar' : 'fr'))}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0"
              title="Basculer Français / العربية"
            >
              <Globe className="w-3.5 h-3.5" />
              {lang === 'fr' ? 'العربية' : 'FR'}
            </button>
          </div>

          <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                  {item.badge !== undefined && (
                    <span className="font-tabular text-[11px] text-slate-400">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Account & Cloud Sync Footer */}
        <div className="hidden lg:block p-4 border-t border-slate-800 space-y-2.5">
          {user ? (
            <>
              <div className="text-xs text-slate-300 truncate">{user.displayName || user.email}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={syncingCloud}
                  onClick={handleSyncToCloud}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-[#0B5ED7] hover:bg-blue-700 disabled:bg-slate-700 rounded transition-colors whitespace-nowrap"
                >
                  <Cloud className="w-3.5 h-3.5" />
                  {syncingCloud ? 'Sync...' : 'Sauvegarder'}
                </button>
                <button
                  type="button"
                  onClick={handleGoogleAuth}
                  className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded"
                  title={t.signOut}
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
              {syncNotice && <div className="text-[11px] text-emerald-400">{syncNotice}</div>}
            </>
          ) : (
            <button
              type="button"
              onClick={handleGoogleAuth}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-900 bg-white hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap"
            >
              <LogIn className="w-3.5 h-3.5" />
              {t.signInGoogle}
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on Left, Concise Primary Action on Right */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-400 whitespace-nowrap shrink-0 ltr-preserve">{tender.reference}</span>
            <span className="text-slate-300" aria-hidden="true">/</span>
            <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => exportTenderToExcel(tender, true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#0F172A] hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {t.exportExcel}
            </button>
          </div>
        </header>

        {/* Global 4-Column KPI Strip */}
        <div className="px-6 pt-5">
          <div className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500">{t.totalHt}</div>
              <div className="mt-1 text-lg font-semibold font-tabular text-slate-900 ltr-preserve">
                {formatDZD(financials.totalHt, 0)} <span className="text-xs font-normal text-slate-500">DA HT</span>
              </div>
            </div>

            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500">
                {t.totalTtc} ({t.tvaLabel} {tender.tvaRate}%)
              </div>
              <div className="mt-1 text-lg font-semibold font-tabular text-slate-900 ltr-preserve">
                {formatDZD(financials.totalTtc, 0)} <span className="text-xs font-normal text-slate-500">DA TTC</span>
              </div>
            </div>

            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500">{t.proformaBlocked}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={`text-lg font-semibold font-tabular ${
                    financials.proformaRequiredCount > 0 ? 'text-red-600' : 'text-emerald-600'
                  }`}
                >
                  {financials.proformaRequiredCount}
                </span>
                <span className="text-xs text-slate-500">
                  / {financials.totalItems} {lang === 'ar' ? 'بنود' : 'articles'}
                </span>
              </div>
            </div>

            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500">
                {t.verifiedItems} · {t.openAnomalies}
              </div>
              <div className="mt-1 flex items-baseline gap-3 font-tabular">
                <span className="text-lg font-semibold text-emerald-700">
                  {financials.verifiedCount}
                </span>
                <span className="text-slate-300">/</span>
                <span
                  className={`text-lg font-semibold ${
                    financials.openCriticalAnomalies > 0 ? 'text-amber-600' : 'text-slate-700'
                  }`}
                >
                  {financials.openAnomalies} {lang === 'ar' ? 'تنبيه' : 'alerte(s)'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Active Layer Viewport */}
        <main className="p-6 flex-1">
          {activeTab === 'ingestion' && (
            <Layer1IngestionAudit
              tender={tender}
              lang={lang}
              onReplaceExtractedData={handleReplaceExtractedData}
              onLoadSample={() => setTender(createSampleAlgerianTender())}
              onResolveAnomaly={handleResolveAnomaly}
              onFixItemUnit={handleFixItemUnit}
              onFixItemQuantity={handleFixItemQuantity}
              onApplySiteMultiplier={handleApplySiteMultiplier}
              onGoToPricing={() => setActiveTab('pricing')}
            />
          )}

          {activeTab === 'pricing' && (
            <Layer2PricingEngine
              tender={tender}
              lang={lang}
              onUpdateGlobalCoeff={handleUpdateGlobalCoeff}
              onUpdateLotOverride={handleUpdateLotOverride}
              onUpdateLineItem={handleUpdateLineItem}
              onAutoFillFromPrivateBpu={handleAutoFillFromPrivateBpu}
              onRouteToRfq={() => {
                if (tender.rfqBatches.length === 0) handleGenerateRfqBatches();
                setActiveTab('rfq');
              }}
            />
          )}

          {activeTab === 'rfq' && (
            <Layer3MicroRfqHub
              tender={tender}
              lang={lang}
              onGenerateBatches={handleGenerateRfqBatches}
              onSelectWinningLineQuote={handleSelectWinningLineQuote}
              onSelectEntireQuote={handleSelectEntireQuote}
              onOpenSupplierPreview={(batch) => setPreviewRfqBatch(batch)}
            />
          )}

          {activeTab === 'bpu' && (
            <Layer4BpuExport
              tender={tender}
              privateBpu={privateBpu}
              lang={lang}
              onAddBpuEntry={(entry) => {
                setPrivateBpu((prev) => [entry, ...prev]);
                if (user) savePrivateBpuEntryToFirestore(user.uid, entry).catch(() => {});
              }}
              onDeleteBpuEntry={(id) => setPrivateBpu((prev) => prev.filter((e) => e.id !== id))}
              onAutoFillFromPrivateBpu={handleAutoFillFromPrivateBpu}
            />
          )}

          {activeTab === 'specs' && <ArchitectureSpecsView lang={lang} />}
        </main>
      </div>

      {/* In-App Mobile Supplier Preview Modal */}
      {previewRfqBatch && (
        <SupplierMicroRfqPortal
          batch={previewRfqBatch}
          onClose={() => setPreviewRfqBatch(null)}
          onSubmitQuote={handleSupplierPreviewSubmit}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ChiffrageApp />
    </ErrorBoundary>
  );
}
