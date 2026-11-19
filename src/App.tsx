import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  Briefcase,
  Code2,
  Database,
  Download,
  FileSearch,
  Globe,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import {
  AppLang,
  CompanyLegalProfile,
  LineItem,
  PrivateBpuEntry,
  RfqBatch,
  SupplierQuote,
  TenderLot,
  TenderProject,
  TradeCategory,
} from './types/btp';
import { ALGERIA_WILAYAS } from './data/algeriaReference';
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
  batchUpdateLineItemsInFirestore,
  createTenderInFirestore,
  deletePrivateBpuEntryFromFirestore,
  deleteTenderFromFirestore,
  duplicateTenderInFirestore,
  fetchPublicRfqBatch,
  loadAllTendersFromFirestore,
  markQuoteSelectedInFirestore,
  publishRfqBatchToFirestore,
  replaceTenderExtractedDataInFirestore,
  savePrivateBpuEntryToFirestore,
  submitPublicSupplierQuote,
  subscribePrivateBpu,
  subscribeToBatchQuotes,
  subscribeUserLegalProfile,
  syncUserProfile,
  updateAnomalyResolvedInFirestore,
  updateLineItemInFirestore,
  updateTenderLotInFirestore,
  updateTenderMetaInFirestore,
  updateTenderStatusInFirestore,
} from './services/firestoreSync';
import { TenderPortfolioView } from './components/TenderPortfolioView';
import { Layer1IngestionAudit } from './components/Layer1IngestionAudit';
import { Layer2PricingEngine } from './components/Layer2PricingEngine';
import { Layer3MicroRfqHub } from './components/Layer3MicroRfqHub';
import { Layer4BpuExport } from './components/Layer4BpuExport';
import { SupplierMicroRfqPortal } from './components/SupplierMicroRfqPortal';
import { ArchitectureSpecsView } from './components/ArchitectureSpecsView';
import { ErrorBoundary } from './components/ErrorBoundary';

type ActiveTab = 'portfolio' | 'ingestion' | 'pricing' | 'rfq' | 'bpu' | 'specs';

const EMPTY_LEGAL: CompanyLegalProfile = {
  companyName: '',
  rc: '',
  nif: '',
  nis: '',
  ai: '',
  rib: '',
  qualification: '',
};

function ChiffrageApp() {
  const [lang, setLang] = useState<AppLang>('fr');
  const [activeTab, setActiveTab] = useState<ActiveTab>('portfolio');
  const [tenders, setTenders] = useState<TenderProject[]>([]);
  const [activeTenderId, setActiveTenderId] = useState<string | null>(null);
  const [privateBpu, setPrivateBpu] = useState<PrivateBpuEntry[]>([]);
  const [companyLegal, setCompanyLegal] = useState<CompanyLegalProfile>(EMPTY_LEGAL);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [previewRfqBatch, setPreviewRfqBatch] = useState<RfqBatch | null>(null);

  // Debounce timers for high-frequency numeric/text inputs -> Firestore writes
  const writeTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scheduleWrite = useCallback((key: string, fn: () => Promise<void>, delayMs = 450) => {
    const existing = writeTimersRef.current[key];
    if (existing) clearTimeout(existing);
    writeTimersRef.current[key] = setTimeout(() => {
      delete writeTimersRef.current[key];
      fn().catch((err) => {
        setDbError(err instanceof Error ? err.message : 'Erreur écriture Firestore.');
      });
    }, delayMs);
  }, []);

  // Standalone no-login supplier route (?rfq=<shareToken>) — strictly Firestore-backed
  const [standaloneToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('rfq');
  });
  const [standaloneBatch, setStandaloneBatch] = useState<(RfqBatch & { ownerId: string }) | null>(null);
  const [standaloneLoading, setStandaloneLoading] = useState(Boolean(standaloneToken));

  const t = UI_COPY[lang];

  const tender = useMemo(
    () => (activeTenderId ? tenders.find((x) => x.id === activeTenderId) || tenders[0] || null : tenders[0] || null),
    [tenders, activeTenderId]
  );

  const isLocked = tender?.status === 'submitted';

  const updateActiveTenderState = (updater: (prev: TenderProject) => TenderProject) => {
    if (!tender) return;
    setTenders((prevList) =>
      prevList.map((item) => (item.id === tender.id ? updater(item) : item))
    );
  };

  // Validate Firestore connectivity once on boot
  useEffect(() => {
    testFirestoreConnection();
  }, []);

  // Cleanup pending debounce timers on unmount
  useEffect(() => {
    const timers = writeTimersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  // Load standalone supplier Micro-RFQ batch strictly from Firestore
  useEffect(() => {
    if (!standaloneToken) return;
    let active = true;
    (async () => {
      setStandaloneLoading(true);
      try {
        const remote = await fetchPublicRfqBatch(standaloneToken);
        if (active) setStandaloneBatch(remote);
      } catch {
        if (active) setStandaloneBatch(null);
      } finally {
        if (active) setStandaloneLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [standaloneToken]);

  const refreshTendersFromDb = useCallback(async (uid: string) => {
    setDbLoading(true);
    setDbError(null);
    try {
      const remoteTenders = await loadAllTendersFromFirestore(uid);
      setTenders(remoteTenders);
      setActiveTenderId((prev) => {
        if (prev && remoteTenders.some((rt) => rt.id === prev)) return prev;
        return remoteTenders[0]?.id ?? null;
      });
    } catch (err) {
      setDbError(err instanceof Error ? err.message : 'Erreur de lecture Firestore.');
    } finally {
      setDbLoading(false);
    }
  }, []);

  // Firebase Auth listener + live Firestore subscriptions (users/{uid}, private_bpu, tenders)
  useEffect(() => {
    let unsubLegal: (() => void) | null = null;
    let unsubBpu: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      unsubLegal?.();
      unsubBpu?.();
      unsubLegal = null;
      unsubBpu = null;

      setUser(u);
      setAuthReady(true);

      if (!u) {
        setTenders([]);
        setActiveTenderId(null);
        setPrivateBpu([]);
        setCompanyLegal(EMPTY_LEGAL);
        return;
      }

      if (u.emailVerified) {
        setDbLoading(true);
        setDbError(null);
        try {
          await syncUserProfile(u.uid, u.displayName || 'Entrepreneur BTP', lang);
          unsubLegal = subscribeUserLegalProfile(u.uid, (legal) => {
            setCompanyLegal(legal);
          });
          unsubBpu = subscribePrivateBpu(u.uid, (entries) => {
            setPrivateBpu(entries);
          });
          await refreshTendersFromDb(u.uid);
        } catch (err) {
          setDbError(err instanceof Error ? err.message : 'Erreur de connexion à Firestore.');
          setDbLoading(false);
        }
      }
    });

    return () => {
      unsubAuth();
      unsubLegal?.();
      unsubBpu?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time Firestore onSnapshot listeners for incoming supplier quotes on active tender batches
  const activeShareTokensKey = tender ? tender.rfqBatches.map((b) => b.shareToken).join(',') : '';
  useEffect(() => {
    if (!user || !user.emailVerified || !tender || tender.rfqBatches.length === 0) return;
    const targetTenderId = tender.id;
    const unsubscribers = tender.rfqBatches.map((batch) =>
      subscribeToBatchQuotes(user.uid, batch.shareToken, (liveQuotes) => {
        setTenders((prevList) =>
          prevList.map((proj) => {
            if (proj.id !== targetTenderId) return proj;
            return {
              ...proj,
              rfqBatches: proj.rfqBatches.map((b) =>
                b.shareToken === batch.shareToken ? { ...b, quotes: liveQuotes } : b
              ),
            };
          })
        );
      })
    );
    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, tender?.id, activeShareTokensKey]);

  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const financials = useMemo(
    () => (tender ? computeTenderFinancials(tender) : null),
    [tender]
  );

  const getAuthToken = async (): Promise<string | null> => {
    if (!auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken();
    } catch {
      return null;
    }
  };

  const handleGoogleAuth = async () => {
    setDbError(null);
    try {
      if (user) {
        await signOut(auth);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err) {
      setDbError(err instanceof Error ? err.message : 'Erreur d’authentification Google.');
    }
  };

  // --- Portfolio Handlers (Direct Firestore Writes) ---
  const handleCreateTender = async (payload: {
    title: string;
    reference: string;
    clientName: string;
    wilayaCode: string;
  }) => {
    if (!user) return;
    const w = ALGERIA_WILAYAS.find((x) => x.code === payload.wilayaCode);
    const id = `ao_${payload.wilayaCode}_${Date.now()}`;
    const next: TenderProject = {
      id,
      title: payload.title,
      reference: payload.reference,
      clientName: payload.clientName,
      wilayaCode: payload.wilayaCode,
      wilayaName: w?.nameFr || 'Alger',
      status: 'draft',
      globalTransportPct: w?.defaultTransportPct ?? 3,
      globalOccupiedSitePct: 0,
      globalOverheadPct: 12,
      globalMarginPct: 15,
      tvaRate: 19,
      lots: [],
      lineItems: [],
      anomalies: [],
      rfqBatches: [],
      updatedAt: new Date().toISOString(),
    };
    await createTenderInFirestore(user.uid, next);
    setTenders((prev) => [next, ...prev]);
    setActiveTenderId(id);
    setActiveTab('ingestion');
  };

  const handleDuplicateTender = async (sourceId: string) => {
    if (!user) return;
    const src = tenders.find((x) => x.id === sourceId);
    if (!src) return;
    const newId = `ao_copy_${Date.now()}`;
    const copy: TenderProject = {
      ...src,
      id: newId,
      reference: `${src.reference}-COPIE`,
      status: 'draft',
      lots: src.lots.map((l) => ({ ...l, tenderId: newId })),
      lineItems: src.lineItems.map((li) => ({ ...li, tenderId: newId })),
      anomalies: src.anomalies.map((a) => ({ ...a, tenderId: newId })),
      rfqBatches: [],
      updatedAt: new Date().toISOString(),
    };
    setTenders((prev) => [copy, ...prev]);
    setActiveTenderId(newId);
    await duplicateTenderInFirestore(user.uid, copy);
  };

  const handleLockSubmitted = async (id: string) => {
    if (!user) return;
    const target = tenders.find((x) => x.id === id);
    if (!target || target.status === 'submitted') return;
    await updateTenderStatusInFirestore(id, 'submitted');
    setTenders((prev) =>
      prev.map((x) =>
        x.id === id ? { ...x, status: 'submitted', updatedAt: new Date().toISOString() } : x
      )
    );
  };

  const handleDeleteTender = async (id: string) => {
    if (!user) return;
    setTenders((prev) => {
      const filtered = prev.filter((x) => x.id !== id);
      if (activeTenderId === id) {
        setActiveTenderId(filtered[0]?.id ?? null);
      }
      return filtered;
    });
    await deleteTenderFromFirestore(user.uid, id);
  };

  // --- Layer 1 Handlers (Direct Firestore Writes) ---
  const handleReplaceExtractedData = async (payload: {
    title?: string;
    reference?: string;
    clientName?: string;
    lots: TenderLot[];
    lineItems: LineItem[];
    anomalies: TenderProject['anomalies'];
  }) => {
    if (!user || !tender || isLocked) return;
    await replaceTenderExtractedDataInFirestore(
      user.uid,
      tender.id,
      {
        title: payload.title || tender.title,
        reference: payload.reference || tender.reference,
        clientName: payload.clientName || tender.clientName,
      },
      payload.lots,
      payload.lineItems,
      payload.anomalies
    );
    updateActiveTenderState((prev) => ({
      ...prev,
      title: payload.title || prev.title,
      reference: payload.reference || prev.reference,
      clientName: payload.clientName || prev.clientName,
      status: 'auditing',
      lots: payload.lots,
      lineItems: payload.lineItems,
      anomalies: payload.anomalies,
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleResolveAnomaly = (anomalyId: string) => {
    if (!user || !tender || isLocked) return;
    updateActiveTenderState((prev) => ({
      ...prev,
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
    updateAnomalyResolvedInFirestore(tender.id, anomalyId, true).catch(() => {});
  };

  const handleFixItemUnit = (lineItemId: string, newUnit: string, anomalyId: string) => {
    if (!user || !tender || isLocked) return;
    const item = tender.lineItems.find((li) => li.id === lineItemId);
    if (!item) return;
    const nextKey = normalizeItemKey(item.designation, newUnit);
    updateActiveTenderState((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) =>
        li.id === lineItemId ? { ...li, unit: newUnit, normalizedKey: nextKey } : li
      ),
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
    updateLineItemInFirestore(tender.id, lineItemId, { unit: newUnit, normalizedKey: nextKey }).catch(() => {});
    updateAnomalyResolvedInFirestore(tender.id, anomalyId, true).catch(() => {});
  };

  const handleFixItemQuantity = (lineItemId: string, newQty: number, anomalyId: string) => {
    if (!user || !tender || isLocked) return;
    updateActiveTenderState((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) => (li.id === lineItemId ? { ...li, quantity: newQty } : li)),
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
    updateLineItemInFirestore(tender.id, lineItemId, { quantity: newQty }).catch(() => {});
    updateAnomalyResolvedInFirestore(tender.id, anomalyId, true).catch(() => {});
  };

  const handleApplySiteMultiplier = (multiplierPct: number, anomalyId: string, isOverhead = false) => {
    if (!user || !tender || isLocked) return;
    const nextOccupied = isOverhead
      ? tender.globalOccupiedSitePct
      : Math.max(tender.globalOccupiedSitePct, multiplierPct);
    const nextOverhead = isOverhead
      ? tender.globalOverheadPct + multiplierPct
      : tender.globalOverheadPct;

    updateActiveTenderState((prev) => ({
      ...prev,
      globalOccupiedSitePct: nextOccupied,
      globalOverheadPct: nextOverhead,
      anomalies: prev.anomalies.map((a) => (a.id === anomalyId ? { ...a, resolved: true } : a)),
    }));
    updateTenderMetaInFirestore(tender.id, {
      globalOccupiedSitePct: nextOccupied,
      globalOverheadPct: nextOverhead,
    }).catch(() => {});
    updateAnomalyResolvedInFirestore(tender.id, anomalyId, true).catch(() => {});
  };

  // --- Layer 2 Handlers (Direct Firestore Writes) ---
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
    if (!user || !tender || isLocked) return;
    const tid = tender.id;
    updateActiveTenderState((prev) => ({ ...prev, ...patch, updatedAt: new Date().toISOString() }));
    scheduleWrite(`tender_meta_${tid}`, () => updateTenderMetaInFirestore(tid, patch));
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
    if (!user || !tender || isLocked) return;
    const tid = tender.id;
    updateActiveTenderState((prev) => ({
      ...prev,
      lots: prev.lots.map((l) => (l.id === lotId ? { ...l, ...patch } : l)),
      updatedAt: new Date().toISOString(),
    }));
    scheduleWrite(`lot_${tid}_${lotId}`, () => updateTenderLotInFirestore(tid, lotId, patch));
  };

  const handleUpdateLineItem = (itemId: string, patch: Partial<LineItem>) => {
    if (!user || !tender || isLocked) return;
    const tid = tender.id;
    updateActiveTenderState((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) => (li.id === itemId ? { ...li, ...patch } : li)),
      updatedAt: new Date().toISOString(),
    }));
    scheduleWrite(`item_${tid}_${itemId}`, () => updateLineItemInFirestore(tid, itemId, patch));
  };

  const recordToPrivateBpu = (item: LineItem, unitPriceDa: number, brand: string, supplierName: string) => {
    if (!user || !tender) return;
    const existing = privateBpu.find(
      (p) => p.normalizedItemKey === item.normalizedKey && p.wilayaCode === tender.wilayaCode
    );
    const newBpu: PrivateBpuEntry = {
      id: existing?.id || `bpu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
    savePrivateBpuEntryToFirestore(user.uid, newBpu).catch((err) => {
      setDbError(err instanceof Error ? err.message : 'Erreur sauvegarde BPU.');
    });
  };

  const handleAutoFillFromPrivateBpu = (): number => {
    if (!user || !tender || isLocked) return 0;
    const updates: Array<{ itemId: string; patch: Partial<LineItem> }> = [];
    const nextItems = tender.lineItems.map((li) => {
      if (li.priceSource === 'supplier_verified') return li;
      const match = matchPrivateBpu(li, privateBpu, tender.wilayaCode);
      if (!match) return li;
      const patch: Partial<LineItem> = {
        debourseSecDa: match.debourseSecDa,
        priceSource: 'private_bpu',
        selectedSupplierName: `${match.supplierName} (BPU Privé)`,
        brand: match.brand,
        confidenceRangePct: 5,
      };
      updates.push({ itemId: li.id, patch });
      return { ...li, ...patch };
    });

    if (updates.length > 0) {
      updateActiveTenderState((prev) => ({
        ...prev,
        lineItems: nextItems,
        updatedAt: new Date().toISOString(),
      }));
      batchUpdateLineItemsInFirestore(tender.id, updates).catch(() => {});
    }
    return updates.length;
  };

  // --- Layer 3 Handlers (Direct Firestore Writes) ---
  const handleGenerateRfqBatches = async () => {
    if (!user || !tender || isLocked) return;
    const eligible = tender.lineItems.filter((li) => li.abcClass === 'A' || li.includeInRfq);
    const byTrade = new Map<TradeCategory, LineItem[]>();
    for (const item of eligible) {
      const list = byTrade.get(item.trade) || [];
      list.push(item);
      byTrade.set(item.trade, list);
    }

    const nextBatches: RfqBatch[] = [];
    const deadline = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

    for (const [trade, items] of byTrade.entries()) {
      const existing = tender.rfqBatches.find((b) => b.trade === trade);
      const token =
        existing?.shareToken ||
        `rfq_${tender.wilayaCode}_${Math.random().toString(36).slice(2, 10)}`;

      const batch: RfqBatch = {
        id: existing?.id || token,
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
      await publishRfqBatchToFirestore(user.uid, batch);
    }

    updateActiveTenderState((prev) => ({
      ...prev,
      rfqBatches: nextBatches,
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleSelectWinningLineQuote = (
    _batchId: string,
    quote: SupplierQuote,
    lineItemId: string,
    unitPriceDa: number,
    brand: string
  ) => {
    if (!user || !tender || isLocked) return;
    const targetItem = tender.lineItems.find((li) => li.id === lineItemId);
    const patch: Partial<LineItem> = {
      debourseSecDa: unitPriceDa,
      priceSource: 'supplier_verified',
      selectedQuoteId: quote.id,
      selectedSupplierName: quote.supplierName,
      brand: brand || targetItem?.brand || null,
      confidenceRangePct: 0,
    };

    updateActiveTenderState((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) => (li.id === lineItemId ? { ...li, ...patch } : li)),
      updatedAt: new Date().toISOString(),
    }));

    updateLineItemInFirestore(tender.id, lineItemId, patch).catch(() => {});
    markQuoteSelectedInFirestore(quote.shareToken, quote.id, true).catch(() => {});

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
    if (!user || !tender) return;
    await submitPublicSupplierQuote(payload.shareToken, tender.id, user.uid, payload);
  };

  // --- Standalone Supplier Portal Route (No-Login, Pure Firestore) ---
  if (standaloneToken) {
    if (standaloneLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-sm text-slate-600 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Chargement de la demande de prix Micro-RFQ depuis Firestore...
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
          await submitPublicSupplierQuote(
            standaloneBatch.shareToken,
            standaloneBatch.tenderId,
            standaloneBatch.ownerId,
            quotePayload
          );
        }}
      />
    );
  }

  // --- Auth Loading & Google Sign-In Gate (Contractor Database Workspace) ---
  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-sm text-slate-600 gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Initialisation de votre espace Firestore...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg p-7 space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-lg font-bold tracking-tight text-slate-900">{t.brand}</span>
            <button
              type="button"
              onClick={() => setLang((prev) => (prev === 'fr' ? 'ar' : 'fr'))}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              {lang === 'fr' ? 'العربية' : 'FR'}
            </button>
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-slate-900">
              {lang === 'ar'
                ? 'منصة تسعير الصفقات العمومية الجزائرية'
                : 'Plateforme de Chiffrage BQE & Marchés Publics'}
            </h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              {lang === 'ar'
                ? 'سجّل الدخول بحساب Google للوصول إلى قاعدة بيانات صفقاتك، جدول الأسعار الخاص (BPU)، وعروض الموردين في الوقت الفعلي.'
                : 'Connectez-vous avec votre compte Google pour accéder à votre base de données privée (appels d’offres, mémoire BPU, devis fournisseurs Micro-RFQ et profil légal).'}
            </p>
          </div>

          <button
            type="button"
            onClick={handleGoogleAuth}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#0F172A] hover:bg-slate-800 rounded-md transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {t.signInGoogle}
          </button>

          {dbError && (
            <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
              {dbError}
            </div>
          )}

          <div className="pt-4 border-t border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              {lang === 'ar'
                ? 'بياناتك محفوظة حصرياً في Firestore ومعزولة تماماً حسب حسابك.'
                : 'Toutes vos données sont stockées exclusivement dans Firestore et strictement isolées par compte.'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const navItems: Array<{ id: ActiveTab; label: string; icon: React.ReactNode; badge?: number; disabled?: boolean }> = [
    {
      id: 'portfolio',
      label: lang === 'ar' ? 'محفظة الصفقات' : 'Appels d’Offres',
      icon: <Briefcase className="w-4 h-4 shrink-0" />,
      badge: tenders.length,
    },
    {
      id: 'ingestion',
      label: t.navIngestion,
      icon: <FileSearch className="w-4 h-4 shrink-0" />,
      badge: financials && financials.openAnomalies > 0 ? financials.openAnomalies : undefined,
      disabled: !tender,
    },
    {
      id: 'pricing',
      label: t.navPricing,
      icon: <Sliders className="w-4 h-4 shrink-0" />,
      badge: financials && financials.proformaRequiredCount > 0 ? financials.proformaRequiredCount : undefined,
      disabled: !tender,
    },
    {
      id: 'rfq',
      label: t.navRfq,
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      badge: tender ? tender.rfqBatches.reduce((sum, b) => sum + b.quotes.length, 0) || undefined : undefined,
      disabled: !tender,
    },
    {
      id: 'bpu',
      label: t.navBpu,
      icon: <Database className="w-4 h-4 shrink-0" />,
      badge: privateBpu.length > 0 ? privateBpu.length : undefined,
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
      {/* Left Sidebar Navigation (252px Desktop) */}
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
                  disabled={item.disabled}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
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

        {/* Account & Live Firestore Footer */}
        <div className="hidden lg:block p-4 border-t border-slate-800 space-y-2.5">
          <div className="text-xs text-slate-300 truncate">{user.displayName || user.email}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={dbLoading}
              onClick={() => refreshTendersFromDb(user.uid)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${dbLoading ? 'animate-spin' : ''}`} />
              {dbLoading ? 'Chargement...' : 'Actualiser BD'}
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
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on Left, Concise Primary Action on Right */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <button
              type="button"
              onClick={() => setActiveTab('portfolio')}
              className="text-slate-500 hover:text-slate-900 whitespace-nowrap shrink-0 ltr-preserve"
            >
              {tender ? tender.reference : 'Portefeuille'}
            </button>
            <span className="text-slate-300" aria-hidden="true">/</span>
            <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
            {isLocked && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 ms-2 whitespace-nowrap shrink-0">
                <Lock className="w-3.5 h-3.5" />
                Soumis
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {tender && (
              <button
                type="button"
                onClick={() => exportTenderToExcel(tender, true, companyLegal)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#0F172A] hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                {t.exportExcel}
              </button>
            )}
          </div>
        </header>

        {dbError && (
          <div className="px-6 pt-4">
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
              {dbError}
            </div>
          </div>
        )}

        {/* Global 4-Column KPI Strip (when an active tender is selected) */}
        {tender && financials && (
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
        )}

        {/* Active Layer Viewport */}
        <main className="p-6 flex-1">
          {dbLoading && tenders.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-lg p-12 flex items-center justify-center gap-2 text-sm text-slate-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              Chargement de vos données depuis Firestore...
            </div>
          ) : (
            <>
              {activeTab === 'portfolio' && (
                <TenderPortfolioView
                  tenders={tenders}
                  activeTenderId={tender?.id ?? null}
                  lang={lang}
                  onSelectTender={(id) => {
                    setActiveTenderId(id);
                    const picked = tenders.find((x) => x.id === id);
                    setActiveTab(picked && picked.lineItems.length > 0 ? 'pricing' : 'ingestion');
                  }}
                  onCreateTender={handleCreateTender}
                  onDuplicateTender={handleDuplicateTender}
                  onLockSubmitted={handleLockSubmitted}
                  onDeleteTender={handleDeleteTender}
                />
              )}

              {activeTab === 'ingestion' && tender && (
                <Layer1IngestionAudit
                  tender={tender}
                  privateBpu={privateBpu}
                  lang={lang}
                  isLocked={isLocked}
                  getAuthToken={getAuthToken}
                  onReplaceExtractedData={handleReplaceExtractedData}
                  onResolveAnomaly={handleResolveAnomaly}
                  onFixItemUnit={handleFixItemUnit}
                  onFixItemQuantity={handleFixItemQuantity}
                  onApplySiteMultiplier={handleApplySiteMultiplier}
                  onGoToPricing={() => setActiveTab('pricing')}
                />
              )}

              {activeTab === 'pricing' && tender && (
                <Layer2PricingEngine
                  tender={tender}
                  lang={lang}
                  onUpdateGlobalCoeff={handleUpdateGlobalCoeff}
                  onUpdateLotOverride={handleUpdateLotOverride}
                  onUpdateLineItem={handleUpdateLineItem}
                  onSaveItemToBpu={(item) =>
                    recordToPrivateBpu(
                      item,
                      item.debourseSecDa,
                      item.brand || 'Standard',
                      item.selectedSupplierName || 'Saisie interne'
                    )
                  }
                  onAutoFillFromPrivateBpu={handleAutoFillFromPrivateBpu}
                  onRouteToRfq={() => {
                    if (tender.rfqBatches.length === 0) {
                      handleGenerateRfqBatches().catch(() => {});
                    }
                    setActiveTab('rfq');
                  }}
                />
              )}

              {activeTab === 'rfq' && tender && (
                <Layer3MicroRfqHub
                  tender={tender}
                  lang={lang}
                  onGenerateBatches={() => {
                    handleGenerateRfqBatches().catch((err) => {
                      setDbError(err instanceof Error ? err.message : 'Erreur génération Micro-RFQ.');
                    });
                  }}
                  onSelectWinningLineQuote={handleSelectWinningLineQuote}
                  onSelectEntireQuote={handleSelectEntireQuote}
                  onOpenSupplierPreview={(batch) => setPreviewRfqBatch(batch)}
                />
              )}

              {activeTab === 'bpu' && (
                <Layer4BpuExport
                  tender={tender}
                  privateBpu={privateBpu}
                  companyLegal={companyLegal}
                  lang={lang}
                  onUpdateCompanyLegal={(legal) => {
                    setCompanyLegal(legal);
                    scheduleWrite(`legal_${user.uid}`, () =>
                      syncUserProfile(user.uid, user.displayName || 'Entrepreneur BTP', lang, legal)
                    );
                  }}
                  onAddBpuEntry={(entry) => {
                    savePrivateBpuEntryToFirestore(user.uid, entry).catch((err) => {
                      setDbError(err instanceof Error ? err.message : 'Erreur ajout BPU.');
                    });
                  }}
                  onDeleteBpuEntry={(id) => {
                    deletePrivateBpuEntryFromFirestore(id).catch((err) => {
                      setDbError(err instanceof Error ? err.message : 'Erreur suppression BPU.');
                    });
                  }}
                  onAutoFillFromPrivateBpu={handleAutoFillFromPrivateBpu}
                />
              )}

              {activeTab === 'specs' && <ArchitectureSpecsView lang={lang} />}
            </>
          )}
        </main>
      </div>

      {/* In-App Mobile Supplier Preview Modal — Writes directly to Firestore */}
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
