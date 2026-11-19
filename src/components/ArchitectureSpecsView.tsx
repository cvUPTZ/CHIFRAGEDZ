import React, { useState } from 'react';
import { Check, Copy, Cpu, Database } from 'lucide-react';
import { AI_PIPELINE_SPEC, POSTGRES_DDL_SCHEMA } from '../data/architectureSpecs';
import { AppLang } from '../types/btp';

export const ArchitectureSpecsView: React.FC<{ lang: AppLang }> = ({ lang }) => {
  const [copied, setCopied] = useState(false);

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(POSTGRES_DDL_SCHEMA);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      {/* Deliverable 2: API & AI Pipeline Spec */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center gap-2 text-slate-900">
          <Cpu className="w-5 h-5 text-slate-700" />
          <h2 className="text-base font-semibold">
            {lang === 'ar'
              ? 'هندسة خط المعالجة بالذكاء الاصطناعي وواجهات API (4 طبقات)'
              : 'Spécification API & Pipeline IA (CamScanner Vision → Audit → Triage ABC → Micro-RFQ)'}
          </h2>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4" dir="ltr">
          {AI_PIPELINE_SPEC.map((stage) => (
            <div key={stage.step} className="p-4 border border-slate-200 rounded-md bg-slate-50/50">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-tabular font-semibold text-slate-900">
                  {stage.step}. {stage.title}
                </span>
                <span className="font-mono text-[11px] text-sky-800">{stage.endpoint}</span>
              </div>
              <p className="mt-2 text-xs text-slate-600 leading-relaxed">{stage.description}</p>
              <ul className="mt-3 space-y-1 text-[11px] text-slate-700 list-disc ps-4">
                {stage.guards.map((g, idx) => (
                  <li key={idx}>{g}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Deliverable 1: Relational PostgreSQL / Supabase DDL Schema */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-slate-700" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Schéma Relationnel PostgreSQL / Supabase (DDL Production)
              </h3>
              <p className="text-xs text-slate-500">
                Tables : tenders · lots · line_items · anomalies · rfq_batches · supplier_quotes · private_bpu
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopySql}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'SQL copié' : 'Copier DDL SQL'}
          </button>
        </div>

        <pre
          dir="ltr"
          className="p-5 bg-[#0F172A] text-slate-200 text-xs font-mono leading-relaxed overflow-x-auto max-h-[520px]"
        >
          {POSTGRES_DDL_SCHEMA}
        </pre>
      </div>
    </div>
  );
};
