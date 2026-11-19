export const POSTGRES_DDL_SCHEMA = `-- ============================================================================
-- ChiffrageDZ — Production PostgreSQL / Supabase Schema (4-Layer Architecture)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Public Tenders (Appels d'Offres BQE)
CREATE TABLE tenders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  reference                TEXT NOT NULL,
  client_name              TEXT NOT NULL,
  wilaya_code              CHAR(2) NOT NULL CHECK (wilaya_code ~ '^[0-9]{2}$'),
  wilaya_name              TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','auditing','rfq_pending','ready_to_submit','submitted')),
  global_transport_pct     NUMERIC(5,2) NOT NULL DEFAULT 4.50,
  global_occupied_site_pct NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  global_overhead_pct      NUMERIC(5,2) NOT NULL DEFAULT 12.00,
  global_margin_pct        NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  tva_rate                 NUMERIC(4,2) NOT NULL DEFAULT 19.00,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Hierarchical Lots with Per-Lot Cost-to-Bid Overrides
CREATE TABLE lots (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                  UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  code                       TEXT NOT NULL,
  name                       TEXT NOT NULL,
  order_index                INT NOT NULL DEFAULT 0,
  override_transport_pct     NUMERIC(5,2),
  override_occupied_site_pct NUMERIC(5,2),
  override_overhead_pct      NUMERIC(5,2),
  override_margin_pct        NUMERIC(5,2),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lots_tender ON lots(tender_id, order_index);

-- 3. Extracted BQE Line Items (ABC 80/20 Triage + Grounded Provenance)
CREATE TABLE line_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id              UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  lot_id                 UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  article_no             TEXT NOT NULL,
  designation            TEXT NOT NULL,
  raw_designation        TEXT NOT NULL, -- Preserved verbatim for official BQE export
  unit                   TEXT NOT NULL,
  quantity               NUMERIC(14,3) NOT NULL CHECK (quantity >= 0),
  page_number            INT NOT NULL DEFAULT 1,
  abc_class              CHAR(1) NOT NULL CHECK (abc_class IN ('A','B','C')),
  trade                  TEXT NOT NULL,
  debourse_sec_da        NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  confidence_range_pct   NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  price_source           TEXT NOT NULL DEFAULT 'proforma_required'
                         CHECK (price_source IN ('proforma_required','indicative_bpu','private_bpu','supplier_verified','manual_override')),
  selected_quote_id      UUID,
  selected_supplier_name TEXT,
  brand                  TEXT,
  normalized_key         TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_line_items_tender_abc ON line_items(tender_id, abc_class, trade);
CREATE INDEX idx_line_items_norm_key ON line_items(normalized_key);

-- 4. Automated Ingestion Audit Anomalies (Layer 1)
CREATE TABLE anomalies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id                UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  line_item_id             UUID REFERENCES line_items(id) ON DELETE SET NULL,
  type                     TEXT NOT NULL
                           CHECK (type IN ('truncated_fragment','unit_anomaly','hidden_cost_clause','ocr_typo')),
  severity                 TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,
  page_number              INT NOT NULL DEFAULT 1,
  suggested_multiplier_pct NUMERIC(5,2),
  resolved                 BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_anomalies_tender ON anomalies(tender_id, resolved, severity);

-- 5. Zero-Friction WhatsApp Micro-RFQ Batches (Layer 3)
CREATE TABLE rfq_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id   UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  trade       TEXT NOT NULL,
  wilaya_name TEXT NOT NULL,
  deadline    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  items_json  JSONB NOT NULL, -- Sanitized subset of 5-15 lines (no contractor identity)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Multi-Supplier Quotes (Write-Only Public Token, Owner-Only Compare)
CREATE TABLE supplier_quotes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_batch_id   UUID NOT NULL REFERENCES rfq_batches(id) ON DELETE CASCADE,
  supplier_name  TEXT NOT NULL,
  supplier_phone TEXT,
  lead_time_days INT NOT NULL DEFAULT 7,
  notes          TEXT,
  line_quotes    JSONB NOT NULL, -- [{ lineItemId, unitPriceDa, brand, availability }]
  proforma_url   TEXT,
  selected       BOOLEAN NOT NULL DEFAULT false,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_quotes_batch ON supplier_quotes(rfq_batch_id);

-- 7. Contractor Private BPU Memory (Layer 4)
CREATE TABLE private_bpu (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  normalized_item_key TEXT NOT NULL,
  designation         TEXT NOT NULL,
  unit                TEXT NOT NULL,
  brand               TEXT NOT NULL DEFAULT '',
  wilaya_code         CHAR(2) NOT NULL,
  wilaya_name         TEXT NOT NULL,
  trade               TEXT NOT NULL,
  supplier_name       TEXT NOT NULL,
  debourse_sec_da     NUMERIC(14,2) NOT NULL CHECK (debourse_sec_da >= 0),
  quoted_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_private_bpu_lookup ON private_bpu(owner_id, normalized_item_key, wilaya_code);`;

export const AI_PIPELINE_SPEC = [
  {
    step: '01',
    endpoint: 'POST /api/extract-bqe',
    title: 'CamScanner Vision & Page-Order Normalization',
    description:
      'Ingests multi-page PDF/JPG/PNG scans (with reverse-order CamScanner detection and reordering) or messy .xlsx spreadsheets. Sends page images server-side to Gemini Vision with structured JSON responseSchema enforcing Lot → Article N° → Désignation → Unité → Quantité → Page.',
    guards: [
      'Preserves raw French BQE text verbatim for submission export while normalizing Algerian OCR artifacts (Flein-koot, Alucobande, Kut bak, SCHNEDIR).',
      'Extracts header/footer operational constraints (occupied premises, night work, CNERIB/CTC/Protection Civile/Sonelgaz approvals).',
    ],
  },
  {
    step: '02',
    endpoint: 'Deterministic Auditor + Gemini Cross-Check',
    title: 'Automated Pre-Pricing Anomaly Gate',
    description:
      'Runs deterministic engineering rules over extracted rows before any pricing is permitted: flags page-break truncated fragments (missing qty or cut text), dimensional unit anomalies (e.g. M3 on cladding/Alucobond or SBS waterproofing), and hidden-cost multiplier clauses.',
    guards: [
      'Surface unresolved critical flags in red banner with 1-click unit correction or Occupied_Site% coefficient application.',
    ],
  },
  {
    step: '03',
    endpoint: 'ABC (80/20) Risk Triage & Wilaya BPU Engine',
    title: 'Grounded Pricing Classification',
    description:
      'Segments every line into Class A (imported equipment & heavy civil works → blocks blind AI pricing, enforces Proforma Required), Class B (standard materials → auto-filled from Wilaya-indexed reference BPU with ±% confidence band), and Class C (fittings → instant fill).',
    guards: [
      'Explicit visual distinction between Estimé (indicative), BPU Privé (historical contractor quote), and Devis Vérifié (live supplier proforma).',
    ],
  },
  {
    step: '04',
    endpoint: 'POST /api/parse-proforma & Micro-RFQ Hub',
    title: 'Zero-Friction Supplier Proforma OCR & Comparison',
    description:
      'Suppliers open an unguessable no-login mobile link showing only 5–15 trade-filtered items, type DA HT unit prices or snap a photo of their stamped proforma (parsed server-side by Gemini Vision), and submit in under 60 seconds. Contractor compares side-by-side and saves winning quotes directly to Private BPU Memory.',
    guards: [
      'Strict zero-leakage isolation: suppliers never see contractor identity, target margins, or competitor quotes.',
    ],
  },
];
