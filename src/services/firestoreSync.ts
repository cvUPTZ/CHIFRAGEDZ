import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  AnomalyFlag,
  CompanyLegalProfile,
  LineItem,
  PrivateBpuEntry,
  RfqBatch,
  SupplierQuote,
  TenderLot,
  TenderProject,
} from '../types/btp';

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || `id_${Date.now()}`;
}

export async function syncUserProfile(
  uid: string,
  displayName: string,
  preferredLang: 'fr' | 'ar',
  legal?: CompanyLegalProfile
): Promise<void> {
  const path = `users/${uid}`;
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    const legalFields = legal
      ? {
          companyName: (legal.companyName || 'Entreprise BTP Algérie').slice(0, 160),
          rc: (legal.rc || '').slice(0, 60),
          nif: (legal.nif || '').slice(0, 40),
          nis: (legal.nis || '').slice(0, 40),
          ai: (legal.ai || '').slice(0, 40),
          rib: (legal.rib || '').slice(0, 60),
          qualification: (legal.qualification || '').slice(0, 120),
        }
      : {};

    if (!snap.exists()) {
      await setDoc(ref, {
        uid,
        displayName: (displayName || 'Entrepreneur BTP').slice(0, 120),
        companyName: (legal?.companyName || 'Entreprise BTP Algérie').slice(0, 160),
        defaultWilayaCode: '16',
        preferredLang,
        ...legalFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName: (displayName || 'Entrepreneur BTP').slice(0, 120),
        preferredLang,
        ...legalFields,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function loadUserLegalProfile(uid: string): Promise<CompanyLegalProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      companyName: d.companyName || '',
      rc: d.rc || '',
      nif: d.nif || '',
      nis: d.nis || '',
      ai: d.ai || '',
      rib: d.rib || '',
      qualification: d.qualification || '',
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function loadAllTendersFromFirestore(uid: string): Promise<TenderProject[]> {
  const path = 'tenders';
  try {
    const tQuery = query(collection(db, 'tenders'), where('ownerId', '==', uid));
    const tSnap = await getDocs(tQuery);
    if (tSnap.empty) return [];

    // Fetch all RFQ batches owned by this contractor in one query
    const rfqQuery = query(collection(db, 'rfq_public'), where('ownerId', '==', uid));
    const rfqSnap = await getDocs(rfqQuery);
    const allBatches: RfqBatch[] = await Promise.all(
      rfqSnap.docs.map(async (bDoc) => {
        const bd = bDoc.data();
        const quotes = await fetchQuotesForOwnerBatch(uid, bd.shareToken);
        return {
          id: bDoc.id,
          shareToken: bd.shareToken,
          tenderId: bd.tenderId,
          trade: bd.trade,
          wilayaName: bd.wilayaName,
          deadline: bd.deadline,
          status: bd.status,
          items: bd.items || [],
          quotes,
          createdAt: bd.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
        };
      })
    );

    const results: TenderProject[] = [];
    for (const tDoc of tSnap.docs) {
      const td = tDoc.data();
      const tenderId = tDoc.id;

      const [lotsSnap, itemsSnap, anomSnap] = await Promise.all([
        getDocs(query(collection(db, 'tenders', tenderId, 'lots'), where('ownerId', '==', uid))),
        getDocs(query(collection(db, 'tenders', tenderId, 'line_items'), where('ownerId', '==', uid))),
        getDocs(query(collection(db, 'tenders', tenderId, 'anomalies'), where('ownerId', '==', uid))),
      ]);

      const lots: TenderLot[] = lotsSnap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            tenderId,
            code: data.code,
            name: data.name,
            orderIndex: Number(data.orderIndex) || 0,
            overrideTransportPct: data.overrideTransportPct ?? null,
            overrideOccupiedSitePct: data.overrideOccupiedSitePct ?? null,
            overrideOverheadPct: data.overrideOverheadPct ?? null,
            overrideMarginPct: data.overrideMarginPct ?? null,
          };
        })
        .sort((a, b) => a.orderIndex - b.orderIndex);

      const lineItems: LineItem[] = itemsSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          tenderId,
          lotId: data.lotId,
          articleNo: data.articleNo,
          designation: data.designation,
          rawDesignation: data.rawDesignation,
          unit: data.unit,
          quantity: Number(data.quantity) || 0,
          pageNumber: Number(data.pageNumber) || 1,
          abcClass: data.abcClass,
          trade: data.trade,
          debourseSecDa: Number(data.debourseSecDa) || 0,
          confidenceRangePct: Number(data.confidenceRangePct) || 0,
          priceSource: data.priceSource,
          selectedQuoteId: data.selectedQuoteId ?? null,
          selectedSupplierName: data.selectedSupplierName ?? null,
          brand: data.brand ?? null,
          normalizedKey: data.normalizedKey,
          includeInRfq: data.abcClass === 'A',
        };
      });

      const anomalies: AnomalyFlag[] = anomSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          tenderId,
          lineItemId: data.lineItemId ?? null,
          type: data.type,
          severity: data.severity,
          title: data.title,
          description: data.description,
          pageNumber: Number(data.pageNumber) || 1,
          suggestedMultiplierPct: data.suggestedMultiplierPct ?? null,
          resolved: Boolean(data.resolved),
        };
      });

      results.push({
        id: tenderId,
        title: td.title,
        reference: td.reference,
        clientName: td.clientName,
        wilayaCode: td.wilayaCode,
        wilayaName: td.wilayaName,
        status: td.status,
        globalTransportPct: Number(td.globalTransportPct) || 0,
        globalOccupiedSitePct: Number(td.globalOccupiedSitePct) || 0,
        globalOverheadPct: Number(td.globalOverheadPct) || 0,
        globalMarginPct: Number(td.globalMarginPct) || 0,
        tvaRate: Number(td.tvaRate) || 19,
        lots,
        lineItems,
        anomalies,
        rfqBatches: allBatches.filter((b) => b.tenderId === tenderId),
        updatedAt: td.updatedAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
      });
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveTenderToFirestore(
  uid: string,
  tender: TenderProject
): Promise<void> {
  const tenderId = sanitizeId(tender.id);
  const basePath = `tenders/${tenderId}`;
  try {
    const tenderRef = doc(db, 'tenders', tenderId);
    const existing = await getDoc(tenderRef);

    if (existing.exists() && existing.data().status === 'submitted') {
      // Honor terminal state lock in Firestore rules
      return;
    }

    if (!existing.exists()) {
      await setDoc(tenderRef, {
        ownerId: uid,
        title: tender.title.slice(0, 240),
        reference: tender.reference.slice(0, 100),
        clientName: tender.clientName.slice(0, 200),
        wilayaCode: tender.wilayaCode.slice(0, 2),
        wilayaName: tender.wilayaName.slice(0, 80),
        status: tender.status === 'submitted' ? 'ready_to_submit' : tender.status,
        globalTransportPct: Number(tender.globalTransportPct),
        globalOccupiedSitePct: Number(tender.globalOccupiedSitePct),
        globalOverheadPct: Number(tender.globalOverheadPct),
        globalMarginPct: Number(tender.globalMarginPct),
        tvaRate: Number(tender.tvaRate),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(tenderRef, {
        title: tender.title.slice(0, 240),
        reference: tender.reference.slice(0, 100),
        clientName: tender.clientName.slice(0, 200),
        wilayaCode: tender.wilayaCode.slice(0, 2),
        wilayaName: tender.wilayaName.slice(0, 80),
        globalTransportPct: Number(tender.globalTransportPct),
        globalOccupiedSitePct: Number(tender.globalOccupiedSitePct),
        globalOverheadPct: Number(tender.globalOverheadPct),
        globalMarginPct: Number(tender.globalMarginPct),
        tvaRate: Number(tender.tvaRate),
        updatedAt: serverTimestamp(),
      });
    }

    const batch = writeBatch(db);
    for (const lot of tender.lots) {
      const lotId = sanitizeId(lot.id);
      const lotRef = doc(db, 'tenders', tenderId, 'lots', lotId);
      const lotSnap = await getDoc(lotRef);
      if (!lotSnap.exists()) {
        batch.set(lotRef, {
          tenderId,
          ownerId: uid,
          code: lot.code.slice(0, 40),
          name: lot.name.slice(0, 200),
          orderIndex: lot.orderIndex,
          overrideTransportPct: lot.overrideTransportPct ?? null,
          overrideOccupiedSitePct: lot.overrideOccupiedSitePct ?? null,
          overrideOverheadPct: lot.overrideOverheadPct ?? null,
          overrideMarginPct: lot.overrideMarginPct ?? null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(lotRef, {
          code: lot.code.slice(0, 40),
          name: lot.name.slice(0, 200),
          orderIndex: lot.orderIndex,
          overrideTransportPct: lot.overrideTransportPct ?? null,
          overrideOccupiedSitePct: lot.overrideOccupiedSitePct ?? null,
          overrideOverheadPct: lot.overrideOverheadPct ?? null,
          overrideMarginPct: lot.overrideMarginPct ?? null,
          updatedAt: serverTimestamp(),
        });
      }
    }

    for (const item of tender.lineItems) {
      const itemId = sanitizeId(item.id);
      const itemRef = doc(db, 'tenders', tenderId, 'line_items', itemId);
      const itemSnap = await getDoc(itemRef);
      const payload = {
        designation: item.designation.slice(0, 1200),
        unit: item.unit.slice(0, 24),
        quantity: Number(item.quantity),
        abcClass: item.abcClass,
        trade: item.trade.slice(0, 80),
        debourseSecDa: Number(item.debourseSecDa),
        confidenceRangePct: Number(item.confidenceRangePct),
        priceSource: item.priceSource,
        selectedQuoteId: item.selectedQuoteId ? item.selectedQuoteId.slice(0, 128) : null,
        selectedSupplierName: item.selectedSupplierName ? item.selectedSupplierName.slice(0, 160) : null,
        brand: item.brand ? item.brand.slice(0, 120) : null,
        normalizedKey: item.normalizedKey.slice(0, 200),
        updatedAt: serverTimestamp(),
      };
      if (!itemSnap.exists()) {
        batch.set(itemRef, {
          tenderId,
          lotId: sanitizeId(item.lotId),
          ownerId: uid,
          articleNo: item.articleNo.slice(0, 40),
          rawDesignation: item.rawDesignation.slice(0, 1200),
          pageNumber: Math.max(1, Math.round(item.pageNumber)),
          ...payload,
          createdAt: serverTimestamp(),
        });
      } else {
        batch.update(itemRef, payload);
      }
    }

    for (const anom of tender.anomalies) {
      const anomId = sanitizeId(anom.id);
      const anomRef = doc(db, 'tenders', tenderId, 'anomalies', anomId);
      const anomSnap = await getDoc(anomRef);
      if (!anomSnap.exists()) {
        batch.set(anomRef, {
          tenderId,
          ownerId: uid,
          lineItemId: anom.lineItemId ? sanitizeId(anom.lineItemId) : null,
          type: anom.type,
          severity: anom.severity,
          title: anom.title.slice(0, 200),
          description: anom.description.slice(0, 1000),
          pageNumber: Math.max(1, Math.round(anom.pageNumber)),
          suggestedMultiplierPct: anom.suggestedMultiplierPct ?? null,
          resolved: Boolean(anom.resolved),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(anomRef, {
          resolved: Boolean(anom.resolved),
          updatedAt: serverTimestamp(),
        });
      }
    }

    await batch.commit();

    if (tender.status === 'submitted') {
      await updateDoc(tenderRef, {
        status: 'submitted',
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, basePath);
  }
}

export async function deleteTenderFromFirestore(uid: string, tenderId: string): Promise<void> {
  const cleanId = sanitizeId(tenderId);
  const path = `tenders/${cleanId}`;
  try {
    const ref = doc(db, 'tenders', cleanId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    if (snap.data().ownerId === uid && snap.data().status !== 'submitted') {
      await deleteDoc(ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function publishRfqBatchToFirestore(
  uid: string,
  batch: RfqBatch
): Promise<void> {
  const token = sanitizeId(batch.shareToken);
  const path = `rfq_public/${token}`;
  try {
    const ref = doc(db, 'rfq_public', token);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        shareToken: token,
        tenderId: sanitizeId(batch.tenderId),
        ownerId: uid,
        trade: batch.trade.slice(0, 80),
        wilayaName: batch.wilayaName.slice(0, 80),
        deadline: batch.deadline.slice(0, 32),
        status: batch.status,
        items: batch.items.slice(0, 30),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        status: batch.status,
        deadline: batch.deadline.slice(0, 32),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function fetchPublicRfqBatch(
  shareToken: string
): Promise<(RfqBatch & { ownerId: string }) | null> {
  const token = sanitizeId(shareToken);
  const path = `rfq_public/${token}`;
  try {
    const snap = await getDoc(doc(db, 'rfq_public', token));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      id: token,
      shareToken: data.shareToken,
      tenderId: data.tenderId,
      ownerId: data.ownerId,
      trade: data.trade,
      wilayaName: data.wilayaName,
      deadline: data.deadline,
      status: data.status,
      items: data.items || [],
      quotes: [],
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function submitPublicSupplierQuote(
  shareToken: string,
  tenderId: string,
  ownerId: string,
  quote: Omit<SupplierQuote, 'id' | 'selected' | 'submittedAt'>
): Promise<string> {
  const token = sanitizeId(shareToken);
  const quoteId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `rfq_public/${token}/quotes/${quoteId}`;
  try {
    await setDoc(doc(db, 'rfq_public', token, 'quotes', quoteId), {
      shareToken: token,
      tenderId: sanitizeId(tenderId),
      ownerId: sanitizeId(ownerId),
      supplierName: quote.supplierName.slice(0, 160),
      supplierPhone: (quote.supplierPhone || '').slice(0, 40),
      leadTimeDays: Math.min(365, Math.max(0, Number(quote.leadTimeDays) || 7)),
      notes: (quote.notes || '').slice(0, 600),
      lineQuotes: quote.lineQuotes.slice(0, 30),
      selected: false,
      createdAt: serverTimestamp(),
    });
    return quoteId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function fetchQuotesForOwnerBatch(
  uid: string,
  shareToken: string
): Promise<SupplierQuote[]> {
  const token = sanitizeId(shareToken);
  const path = `rfq_public/${token}/quotes`;
  try {
    const q = query(
      collection(db, 'rfq_public', token, 'quotes'),
      where('ownerId', '==', uid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        shareToken: data.shareToken,
        tenderId: data.tenderId,
        supplierName: data.supplierName,
        supplierPhone: data.supplierPhone || '',
        leadTimeDays: data.leadTimeDays ?? 7,
        notes: data.notes || '',
        lineQuotes: data.lineQuotes || [],
        selected: Boolean(data.selected),
        submittedAt: data.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

/**
 * Real-time listener for incoming supplier quotes on a published Micro-RFQ batch
 */
export function subscribeToBatchQuotes(
  uid: string,
  shareToken: string,
  onUpdate: (quotes: SupplierQuote[]) => void
): Unsubscribe {
  const token = sanitizeId(shareToken);
  const path = `rfq_public/${token}/quotes`;
  const q = query(
    collection(db, 'rfq_public', token, 'quotes'),
    where('ownerId', '==', uid)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: SupplierQuote[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          shareToken: data.shareToken,
          tenderId: data.tenderId,
          supplierName: data.supplierName,
          supplierPhone: data.supplierPhone || '',
          leadTimeDays: data.leadTimeDays ?? 7,
          notes: data.notes || '',
          lineQuotes: data.lineQuotes || [],
          selected: Boolean(data.selected),
          submittedAt: data.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
        };
      });
      onUpdate(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function savePrivateBpuEntryToFirestore(
  uid: string,
  entry: PrivateBpuEntry
): Promise<void> {
  const bpuId = sanitizeId(entry.id);
  const path = `private_bpu/${bpuId}`;
  try {
    const ref = doc(db, 'private_bpu', bpuId);
    const snap = await getDoc(ref);
    const common = {
      designation: entry.designation.slice(0, 500),
      unit: entry.unit.slice(0, 24),
      brand: (entry.brand || '').slice(0, 120),
      wilayaCode: entry.wilayaCode.slice(0, 2),
      wilayaName: entry.wilayaName.slice(0, 80),
      trade: entry.trade.slice(0, 80),
      supplierName: entry.supplierName.slice(0, 160),
      debourseSecDa: Number(entry.debourseSecDa),
      quotedDate: entry.quotedDate.slice(0, 32),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        normalizedItemKey: entry.normalizedItemKey.slice(0, 200),
        ...common,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, common);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deletePrivateBpuEntryFromFirestore(bpuId: string): Promise<void> {
  const cleanId = sanitizeId(bpuId);
  const path = `private_bpu/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'private_bpu', cleanId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function loadPrivateBpuFromFirestore(uid: string): Promise<PrivateBpuEntry[]> {
  const path = 'private_bpu';
  try {
    const q = query(collection(db, 'private_bpu'), where('ownerId', '==', uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        normalizedItemKey: data.normalizedItemKey,
        designation: data.designation,
        unit: data.unit,
        brand: data.brand || '',
        wilayaCode: data.wilayaCode,
        wilayaName: data.wilayaName,
        trade: data.trade,
        supplierName: data.supplierName,
        debourseSecDa: Number(data.debourseSecDa),
        quotedDate: data.quotedDate,
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}
