export type AppLang = 'fr' | 'ar';

export type AbcClass = 'A' | 'B' | 'C';

export type PriceSource =
  | 'proforma_required'
  | 'indicative_bpu'
  | 'private_bpu'
  | 'supplier_verified'
  | 'manual_override';

export type AnomalyType =
  | 'truncated_fragment'
  | 'unit_anomaly'
  | 'hidden_cost_clause'
  | 'ocr_typo';

export type AnomalySeverity = 'critical' | 'warning' | 'info';

export type TradeCategory =
  | 'Électricité & Groupe'
  | 'Chauffage & Clim'
  | 'VRD & Voirie'
  | 'Plomberie & Incendie'
  | 'Étanchéité & Façade'
  | 'Gros Œuvre & Revêtements';

export interface WilayaInfo {
  code: string;
  nameFr: string;
  nameAr: string;
  defaultTransportPct: number;
  region: 'Nord' | 'Hauts-Plateaux' | 'Sud';
}

export interface CostCoefficients {
  transportPct: number;
  occupiedSitePct: number;
  overheadPct: number;
  marginPct: number;
}

export interface TenderLot {
  id: string;
  tenderId: string;
  code: string;
  name: string;
  orderIndex: number;
  overrideTransportPct?: number | null;
  overrideOccupiedSitePct?: number | null;
  overrideOverheadPct?: number | null;
  overrideMarginPct?: number | null;
}

export interface LineItem {
  id: string;
  tenderId: string;
  lotId: string;
  articleNo: string;
  designation: string;
  rawDesignation: string;
  unit: string;
  quantity: number;
  pageNumber: number;
  abcClass: AbcClass;
  trade: TradeCategory;
  debourseSecDa: number;
  confidenceRangePct: number;
  priceSource: PriceSource;
  selectedQuoteId?: string | null;
  selectedSupplierName?: string | null;
  brand?: string | null;
  normalizedKey: string;
  includeInRfq?: boolean;
}

export interface AnomalyFlag {
  id: string;
  tenderId: string;
  lineItemId?: string | null;
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  pageNumber: number;
  suggestedMultiplierPct?: number | null;
  suggestedUnit?: string | null;
  suggestedFixText?: string | null;
  clauseTag?: string | null;
  resolved: boolean;
}

export interface RfqLineSummary {
  lineItemId: string;
  articleNo: string;
  designation: string;
  unit: string;
  quantity: number;
}

export interface SupplierLineQuote {
  lineItemId: string;
  unitPriceDa: number;
  brand: string;
  availability: string;
}

export interface SupplierQuote {
  id: string;
  shareToken: string;
  tenderId: string;
  supplierName: string;
  supplierPhone?: string;
  leadTimeDays: number;
  notes?: string;
  lineQuotes: SupplierLineQuote[];
  selected: boolean;
  submittedAt: string;
}

export interface RfqBatch {
  id: string;
  shareToken: string;
  tenderId: string;
  trade: TradeCategory;
  wilayaName: string;
  deadline: string;
  status: 'open' | 'closed';
  items: RfqLineSummary[];
  quotes: SupplierQuote[];
  createdAt: string;
}

export interface PrivateBpuEntry {
  id: string;
  normalizedItemKey: string;
  designation: string;
  unit: string;
  brand: string;
  wilayaCode: string;
  wilayaName: string;
  trade: TradeCategory;
  supplierName: string;
  debourseSecDa: number;
  quotedDate: string;
}

export interface TenderProject {
  id: string;
  title: string;
  reference: string;
  clientName: string;
  wilayaCode: string;
  wilayaName: string;
  status: 'draft' | 'auditing' | 'rfq_pending' | 'ready_to_submit' | 'submitted';
  globalTransportPct: number;
  globalOccupiedSitePct: number;
  globalOverheadPct: number;
  globalMarginPct: number;
  tvaRate: number;
  lots: TenderLot[];
  lineItems: LineItem[];
  anomalies: AnomalyFlag[];
  rfqBatches: RfqBatch[];
  updatedAt: string;
}
