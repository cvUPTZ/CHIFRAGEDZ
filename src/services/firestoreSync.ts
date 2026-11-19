import {
  collection,
  deleteDoc,
  doc,
  DocumentReference,
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

export function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || `id_${Date.now()}`;
}

async function commitInChunks(
  ops: Array<(batch: ReturnType<typeof writeBatch>) => void>
): Promise<void> {
  const CHUNK = 420;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + CHUNK)) {
      op(batch);
    }
    await batch.commit();
  }
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
          companyName: (legal.companyName || '').slice(0, 160),
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
        companyName: (legal?.companyName || '').slice(0, 160),
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

export function subscribeUserLegalProfile(
  uid: string,
  onUpdate: (legal: CompanyLegalProfile) => void
): Unsubscribe {
  const path = `users/${uid}`;
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      onUpdate({
        companyName: d.companyName || '',
        rc: d.rc || '',
        nif: d.nif || '',
        nis: d.nis || '',
        ai: d.ai || '',
        rib: d.rib || '',
        qualification: d.qualification || '',
      });
    },
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export function subscribePrivateBpu(
  uid: string,
  onUpdate: (entries: PrivateBpuEntry[]) => void
): Unsubscribe {
  const path = 'private_bpu';
  const q = query(collection(db, 'private_bpu'), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list: PrivateBpuEntry[] = snap.docs
        .map((d) => {
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
            debourseSecDa: Number(data.debourseSecDa) || 0,
            quotedDate: data.quotedDate || '',
          };
        })
        .sort((a, b) => b.quotedDate.localeCompare(a.quotedDate));
      onUpdate(list);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function loadAllTendersFromFirestore(uid: string): Promise<TenderProject[]> {
  const path = 'tenders';
  try {
    const tQuery = query(collection(db, 'tenders'), where('ownerId', '==', uid));
    const tSnap = await getDocs(tQuery);
    if (tSnap.empty) return [];

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

      const lineItems: LineItem[] = itemsSnap.docs
        .map((d) => {
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
            includeInRfq: data.includeInRfq ?? data.abcClass === 'A',
          };
        })
        .sort((a, b) => a.articleNo.localeCompare(b.articleNo, undefined, { numeric: true }));

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
          suggestedUnit: data.suggestedUnit ?? null,
          clauseTag: data.clauseTag ?? null,
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

export async function createTenderInFirestore(
  uid: string,
  tender: TenderProject
): Promise<void> {
  const tenderId = sanitizeId(tender.id);
  const path = `tenders/${tenderId}`;
  try {
    await setDoc(doc(db, 'tenders', tenderId), {
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
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function duplicateTenderInFirestore(
  uid: string,
  copy: TenderProject
): Promise<void> {
  const tenderId = sanitizeId(copy.id);
  const basePath = `tenders/${tenderId}`;
  try {
    await createTenderInFirestore(uid, copy);

    const ops: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
    for (const lot of copy.lots) {
      const lotId = sanitizeId(lot.id);
      const lotRef = doc(db, 'tenders', tenderId, 'lots', lotId);
      ops.push((b) =>
        b.set(lotRef, {
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
        })
      );
    }

    for (const item of copy.lineItems) {
      const itemId = sanitizeId(item.id);
      const itemRef = doc(db, 'tenders', tenderId, 'line_items', itemId);
      ops.push((b) =>
        b.set(itemRef, {
          tenderId,
          lotId: sanitizeId(item.lotId),
          ownerId: uid,
          articleNo: item.articleNo.slice(0, 40),
          designation: item.designation.slice(0, 1200),
          rawDesignation: item.rawDesignation.slice(0, 1200),
          unit: item.unit.slice(0, 24),
          quantity: Number(item.quantity),
          pageNumber: Math.max(1, Math.round(item.pageNumber)),
          abcClass: item.abcClass,
          trade: item.trade.slice(0, 80),
          debourseSecDa: Number(item.debourseSecDa),
          confidenceRangePct: Number(item.confidenceRangePct),
          priceSource: item.priceSource,
          selectedQuoteId: item.selectedQuoteId ? item.selectedQuoteId.slice(0, 128) : null,
          selectedSupplierName: item.selectedSupplierName ? item.selectedSupplierName.slice(0, 160) : null,
          brand: item.brand ? item.brand.slice(0, 120) : null,
          normalizedKey: item.normalizedKey.slice(0, 200),
          includeInRfq: Boolean(item.includeInRfq ?? item.abcClass === 'A'),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    }

    for (const anom of copy.anomalies) {
      const anomId = sanitizeId(anom.id);
      const anomRef = doc(db, 'tenders', tenderId, 'anomalies', anomId);
      ops.push((b) =>
        b.set(anomRef, {
          tenderId,
          ownerId: uid,
          lineItemId: anom.lineItemId ? sanitizeId(anom.lineItemId) : null,
          type: anom.type,
          severity: anom.severity,
          title: anom.title.slice(0, 200),
          description: anom.description.slice(0, 1000),
          pageNumber: Math.max(1, Math.round(anom.pageNumber)),
          suggestedMultiplierPct: anom.suggestedMultiplierPct ?? null,
          suggestedUnit: anom.suggestedUnit ? anom.suggestedUnit.slice(0, 24) : null,
          clauseTag: anom.clauseTag ? anom.clauseTag.slice(0, 120) : null,
          resolved: Boolean(anom.resolved),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    }

    await commitInChunks(ops);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, basePath);
  }
}

export async function updateTenderMetaInFirestore(
  tenderId: string,
  patch: Partial<
    Pick<
      TenderProject,
      | 'title'
      | 'reference'
      | 'clientName'
      | 'wilayaCode'
      | 'wilayaName'
      | 'globalTransportPct'
      | 'globalOccupiedSitePct'
      | 'globalOverheadPct'
      | 'globalMarginPct'
      | 'tvaRate'
    >
  >
): Promise<void> {
  const cleanId = sanitizeId(tenderId);
  const path = `tenders/${cleanId}`;
  try {
    const cleanPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (patch.title !== undefined) cleanPatch.title = patch.title.slice(0, 240);
    if (patch.reference !== undefined) cleanPatch.reference = patch.reference.slice(0, 100);
    if (patch.clientName !== undefined) cleanPatch.clientName = patch.clientName.slice(0, 200);
    if (patch.wilayaCode !== undefined) cleanPatch.wilayaCode = patch.wilayaCode.slice(0, 2);
    if (patch.wilayaName !== undefined) cleanPatch.wilayaName = patch.wilayaName.slice(0, 80);
    if (patch.globalTransportPct !== undefined) cleanPatch.globalTransportPct = Number(patch.globalTransportPct);
    if (patch.globalOccupiedSitePct !== undefined) cleanPatch.globalOccupiedSitePct = Number(patch.globalOccupiedSitePct);
    if (patch.globalOverheadPct !== undefined) cleanPatch.globalOverheadPct = Number(patch.globalOverheadPct);
    if (patch.globalMarginPct !== undefined) cleanPatch.globalMarginPct = Number(patch.globalMarginPct);
    if (patch.tvaRate !== undefined) cleanPatch.tvaRate = Number(patch.tvaRate);

    await updateDoc(doc(db, 'tenders', cleanId), cleanPatch);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateTenderStatusInFirestore(
  tenderId: string,
  status: TenderProject['status']
): Promise<void> {
  const cleanId = sanitizeId(tenderId);
  const path = `tenders/${cleanId}`;
  try {
    await updateDoc(doc(db, 'tenders', cleanId), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateTenderLotInFirestore(
  tenderId: string,
  lotId: string,
  patch: Partial<
    Pick<
      TenderLot,
      | 'code'
      | 'name'
      | 'orderIndex'
      | 'overrideTransportPct'
      | 'overrideOccupiedSitePct'
      | 'overrideOverheadPct'
      | 'overrideMarginPct'
    >
  >
): Promise<void> {
  const tId = sanitizeId(tenderId);
  const lId = sanitizeId(lotId);
  const path = `tenders/${tId}/lots/${lId}`;
  try {
    const cleanPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (patch.code !== undefined) cleanPatch.code = patch.code.slice(0, 40);
    if (patch.name !== undefined) cleanPatch.name = patch.name.slice(0, 200);
    if (patch.orderIndex !== undefined) cleanPatch.orderIndex = Number(patch.orderIndex);
    if (patch.overrideTransportPct !== undefined) cleanPatch.overrideTransportPct = patch.overrideTransportPct;
    if (patch.overrideOccupiedSitePct !== undefined) cleanPatch.overrideOccupiedSitePct = patch.overrideOccupiedSitePct;
    if (patch.overrideOverheadPct !== undefined) cleanPatch.overrideOverheadPct = patch.overrideOverheadPct;
    if (patch.overrideMarginPct !== undefined) cleanPatch.overrideMarginPct = patch.overrideMarginPct;

    await updateDoc(doc(db, 'tenders', tId, 'lots', lId), cleanPatch);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

function buildLineItemPatch(patch: Partial<LineItem>): Record<string, unknown> {
  const clean: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.designation !== undefined) clean.designation = patch.designation.slice(0, 1200);
  if (patch.unit !== undefined) clean.unit = patch.unit.slice(0, 24);
  if (patch.quantity !== undefined) clean.quantity = Math.max(0, Number(patch.quantity));
  if (patch.abcClass !== undefined) clean.abcClass = patch.abcClass;
  if (patch.trade !== undefined) clean.trade = patch.trade.slice(0, 80);
  if (patch.debourseSecDa !== undefined) clean.debourseSecDa = Math.max(0, Number(patch.debourseSecDa));
  if (patch.confidenceRangePct !== undefined) clean.confidenceRangePct = Math.max(0, Math.min(100, Number(patch.confidenceRangePct)));
  if (patch.priceSource !== undefined) clean.priceSource = patch.priceSource;
  if (patch.selectedQuoteId !== undefined) clean.selectedQuoteId = patch.selectedQuoteId ? patch.selectedQuoteId.slice(0, 128) : null;
  if (patch.selectedSupplierName !== undefined) clean.selectedSupplierName = patch.selectedSupplierName ? patch.selectedSupplierName.slice(0, 160) : null;
  if (patch.brand !== undefined) clean.brand = patch.brand ? patch.brand.slice(0, 120) : null;
  if (patch.normalizedKey !== undefined) clean.normalizedKey = patch.normalizedKey.slice(0, 200);
  if (patch.includeInRfq !== undefined) clean.includeInRfq = Boolean(patch.includeInRfq);
  return clean;
}

export async function updateLineItemInFirestore(
  tenderId: string,
  itemId: string,
  patch: Partial<LineItem>
): Promise<void> {
  const tId = sanitizeId(tenderId);
  const iId = sanitizeId(itemId);
  const path = `tenders/${tId}/line_items/${iId}`;
  try {
    await updateDoc(doc(db, 'tenders', tId, 'line_items', iId), buildLineItemPatch(patch));
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function batchUpdateLineItemsInFirestore(
  tenderId: string,
  updates: Array<{ itemId: string; patch: Partial<LineItem> }>
): Promise<void> {
  if (updates.length === 0) return;
  const tId = sanitizeId(tenderId);
  const path = `tenders/${tId}/line_items`;
  try {
    const ops = updates.map(({ itemId, patch }) => {
      const ref = doc(db, 'tenders', tId, 'line_items', sanitizeId(itemId));
      const clean = buildLineItemPatch(patch);
      return (b: ReturnType<typeof writeBatch>) => b.update(ref, clean);
    });
    await commitInChunks(ops);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateAnomalyResolvedInFirestore(
  tenderId: string,
  anomalyId: string,
  resolved: boolean
): Promise<void> {
  const tId = sanitizeId(tenderId);
  const aId = sanitizeId(anomalyId);
  const path = `tenders/${tId}/anomalies/${aId}`;
  try {
    await updateDoc(doc(db, 'tenders', tId, 'anomalies', aId), {
      resolved,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function replaceTenderExtractedDataInFirestore(
  uid: string,
  tenderId: string,
  metaPatch: { title?: string; reference?: string; clientName?: string },
  lots: TenderLot[],
  lineItems: LineItem[],
  anomalies: AnomalyFlag[]
): Promise<void> {
  const tId = sanitizeId(tenderId);
  const basePath = `tenders/${tId}`;
  try {
    // 1. Update tender metadata if provided
    if (metaPatch.title || metaPatch.reference || metaPatch.clientName) {
      await updateTenderMetaInFirestore(tId, metaPatch);
    }

    // 2. Delete previous subcollection documents cleanly
    const [oldLots, oldItems, oldAnoms] = await Promise.all([
      getDocs(query(collection(db, 'tenders', tId, 'lots'), where('ownerId', '==', uid))),
      getDocs(query(collection(db, 'tenders', tId, 'line_items'), where('ownerId', '==', uid))),
      getDocs(query(collection(db, 'tenders', tId, 'anomalies'), where('ownerId', '==', uid))),
    ]);

    const deleteOps: Array<(b: ReturnType<typeof writeBatch>) => void> = [];
    oldLots.docs.forEach((d) => deleteOps.push((b) => b.delete(d.ref)));
    oldItems.docs.forEach((d) => deleteOps.push((b) => b.delete(d.ref)));
    oldAnoms.docs.forEach((d) => deleteOps.push((b) => b.delete(d.ref)));
    if (deleteOps.length > 0) {
      await commitInChunks(deleteOps);
    }

    // 3. Write new lots, lineItems, and anomalies in chunked batches
    const writeOps: Array<(b: ReturnType<typeof writeBatch>) => void> = [];
    for (const lot of lots) {
      const lotRef = doc(db, 'tenders', tId, 'lots', sanitizeId(lot.id));
      writeOps.push((b) =>
        b.set(lotRef, {
          tenderId: tId,
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
        })
      );
    }

    for (const item of lineItems) {
      const itemRef = doc(db, 'tenders', tId, 'line_items', sanitizeId(item.id));
      writeOps.push((b) =>
        b.set(itemRef, {
          tenderId: tId,
          lotId: sanitizeId(item.lotId),
          ownerId: uid,
          articleNo: item.articleNo.slice(0, 40),
          designation: item.designation.slice(0, 1200),
          rawDesignation: item.rawDesignation.slice(0, 1200),
          unit: item.unit.slice(0, 24),
          quantity: Math.max(0, Number(item.quantity)),
          pageNumber: Math.max(1, Math.round(item.pageNumber)),
          abcClass: item.abcClass,
          trade: item.trade.slice(0, 80),
          debourseSecDa: Math.max(0, Number(item.debourseSecDa)),
          confidenceRangePct: Math.max(0, Math.min(100, Number(item.confidenceRangePct))),
          priceSource: item.priceSource,
          selectedQuoteId: item.selectedQuoteId ? item.selectedQuoteId.slice(0, 128) : null,
          selectedSupplierName: item.selectedSupplierName ? item.selectedSupplierName.slice(0, 160) : null,
          brand: item.brand ? item.brand.slice(0, 120) : null,
          normalizedKey: item.normalizedKey.slice(0, 200),
          includeInRfq: Boolean(item.includeInRfq ?? item.abcClass === 'A'),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    }

    for (const anom of anomalies) {
      const anomRef = doc(db, 'tenders', tId, 'anomalies', sanitizeId(anom.id));
      writeOps.push((b) =>
        b.set(anomRef, {
          tenderId: tId,
          ownerId: uid,
          lineItemId: anom.lineItemId ? sanitizeId(anom.lineItemId) : null,
          type: anom.type,
          severity: anom.severity,
          title: anom.title.slice(0, 200),
          description: anom.description.slice(0, 1000),
          pageNumber: Math.max(1, Math.round(anom.pageNumber)),
          suggestedMultiplierPct: anom.suggestedMultiplierPct ?? null,
          suggestedUnit: anom.suggestedUnit ? anom.suggestedUnit.slice(0, 24) : null,
          clauseTag: anom.clauseTag ? anom.clauseTag.slice(0, 120) : null,
          resolved: Boolean(anom.resolved),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    }

    await commitInChunks(writeOps);
    await updateTenderStatusInFirestore(tId, 'auditing');
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
    if (snap.data().ownerId !== uid || snap.data().status === 'submitted') return;

    // Cleanly delete subcollections and linked rfq_public batches first
    const [lotsSnap, itemsSnap, anomsSnap, rfqSnap] = await Promise.all([
      getDocs(query(collection(db, 'tenders', cleanId, 'lots'), where('ownerId', '==', uid))),
      getDocs(query(collection(db, 'tenders', cleanId, 'line_items'), where('ownerId', '==', uid))),
      getDocs(query(collection(db, 'tenders', cleanId, 'anomalies'), where('ownerId', '==', uid))),
      getDocs(query(collection(db, 'rfq_public'), where('ownerId', '==', uid))),
    ]);

    const refsToDelete: DocumentReference[] = [
      ...lotsSnap.docs.map((d) => d.ref),
      ...itemsSnap.docs.map((d) => d.ref),
      ...anomsSnap.docs.map((d) => d.ref),
    ];

    for (const rfqDoc of rfqSnap.docs) {
      if (rfqDoc.data().tenderId === cleanId) {
        const qSnap = await getDocs(
          query(collection(db, 'rfq_public', rfqDoc.id, 'quotes'), where('ownerId', '==', uid))
        );
        qSnap.docs.forEach((qd) => refsToDelete.push(qd.ref));
        refsToDelete.push(rfqDoc.ref);
      }
    }

    if (refsToDelete.length > 0) {
      await commitInChunks(refsToDelete.map((r) => (b) => b.delete(r)));
    }
    await deleteDoc(ref);
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
        items: batch.items.slice(0, 30),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function markQuoteSelectedInFirestore(
  shareToken: string,
  quoteId: string,
  selected = true
): Promise<void> {
  const token = sanitizeId(shareToken);
  const qId = sanitizeId(quoteId);
  const path = `rfq_public/${token}/quotes/${qId}`;
  try {
    await updateDoc(doc(db, 'rfq_public', token, 'quotes', qId), {
      selected,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
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
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
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
      const list: SupplierQuote[] = snap.docs
        .map((d) => {
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
        })
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
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
