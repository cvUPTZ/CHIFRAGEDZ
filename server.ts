import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Initialize Firebase Admin ONLY for verifyIdToken(token) — requires zero IAM permissions
const adminApp = getApps().length
  ? getApp()
  : initializeApp({ projectId: firebaseConfig.projectId });
const adminAuth = getAuth(adminApp);

interface AuthenticatedRequest extends Request {
  verifiedUid?: string;
}

/**
 * In-memory sliding-window rate limiter per IP or verified Firebase UID
 */
function createRateLimiter(opts: { windowMs: number; maxAuth: number; maxAnon: number }) {
  const buckets = new Map<string, number[]>();

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.verifiedUid ? `uid:${req.verifiedUid}` : `ip:${req.ip || 'unknown'}`;
    const limit = req.verifiedUid ? opts.maxAuth : opts.maxAnon;

    const history = (buckets.get(key) || []).filter((ts) => now - ts < opts.windowMs);
    if (history.length >= limit) {
      return res.status(429).json({
        error: req.verifiedUid
          ? 'Quota horaire d’extractions atteint. Réessayez dans quelques minutes.'
          : 'Limite de démonstration atteinte. Connectez-vous avec Google pour augmenter votre quota.',
      });
    }

    history.push(now);
    buckets.set(key, history);
    next();
  };
}

/**
 * Verify Firebase ID token when Authorization header is provided (rejects forged tokens with 401)
 */
async function verifyFirebaseAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return next();
  }
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'En-tête Authorization invalide.' });
  }
  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.verifiedUid = decoded.uid;
    return next();
  } catch (err) {
    console.error('Firebase token verification failed:', err);
    return res.status(401).json({ error: 'Session expirée ou jeton Firebase invalide. Veuillez vous reconnecter.' });
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY est manquante sur le serveur.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const app = express();
app.use(express.json({ limit: '35mb' }));

const extractLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, maxAuth: 60, maxAnon: 12 });
const proformaLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, maxAuth: 60, maxAnon: 20 });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'chiffragedz-api' });
});

/**
 * Layer 1: Server-side Gemini Vision BQE Extraction & Anomaly Auditor
 * Supports chunked multi-page CamScanner PDFs/images with pageOffset tracking
 */
app.post('/api/extract-bqe', verifyFirebaseAuth, extractLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const {
      files,
      reverseOrder = false,
      wilayaName = 'Alger',
      pageOffset = 0,
    } = req.body as {
      files?: Array<{ name: string; mimeType: string; base64: string }>;
      reverseOrder?: boolean;
      wilayaName?: string;
      pageOffset?: number;
    };

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier PDF ou image fourni pour extraction.' });
    }
    if (files.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 pages par lot d’extraction. Utilisez le découpage par lots.' });
    }

    const orderedFiles = reverseOrder ? [...files].reverse() : files;
    const ai = getGeminiClient();

    const fileParts = orderedFiles.map((file) => ({
      inlineData: {
        mimeType: file.mimeType || 'image/jpeg',
        data: file.base64,
      },
    }));

    const startPage = Math.max(1, Number(pageOffset) + 1);
    const promptText = `Tu es un métreur-vérificateur expert en marchés publics BTP en Algérie (Cahier des Charges / BQE).
Analyse les pages scannées ci-jointes (${orderedFiles.length} document(s), à partir de la page ${startPage}, ordre ${reverseOrder ? 'inversé corrigé' : 'normal'}, Wilaya cible: ${wilayaName}).

Exigences strictes :
1. Extrais la structure hiérarchique complète : Lots -> Articles (articleNo, rawDesignation conservée mot pour mot en français officiel, designation normalisée si faute OCR typique algérienne comme Flein-koot->Flinkote, Alucobande->Alucobond, Kut bak->Cut-back, SCHNEDIR->Schneider Electric, unit, quantity, pageNumber commençant à ${startPage}).
2. Classifie chaque article en ABC (80/20) :
   - 'A' : équipements importés coûteux et gros ouvrages critiques (groupe électrogène, transformateur, TGBT, chaudière, onduleur UPS, climatiseurs/VRF, alucobond, enrobé, centrale incendie).
   - 'B' : matériaux standards (carrelage, peinture, câbles, tubes PVC/PPR, SBS, TVO, PEHD).
   - 'C' : petits accessoires/quincaillerie (vannes, siphons, butoirs, prises, grilles).
3. Assigne chaque article à un corps d'état exact parmi :
   "Électricité & Groupe", "Chauffage & Clim", "VRD & Voirie", "Plomberie & Incendie", "Étanchéité & Façade", "Gros Œuvre & Revêtements".
4. Audite AVANT chiffrage et remonte TOUTES les anomalies :
   - truncated_fragment : article coupé en bas de page sans quantité ou désignation incomplète.
   - unit_anomaly : unité incohérente (ex. M3 pour bardage/Alucobond, étanchéité SBS, peinture, carrelage où M2 est standard).
   - hidden_cost_clause : clauses en en-tête ou pied de page (locaux opérationnels / site occupé, travail de nuit, exigences CNERIB, CTC, Protection Civile, Sonelgaz) avec suggestedMultiplierPct (ex. 8 pour site occupé).
   - ocr_typo : fautes OCR BTP corrigées.

Ne devine JAMAIS de prix pour les articles Classe A.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [...fileParts, { text: promptText }],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tenderTitle: { type: Type.STRING },
            tenderReference: { type: Type.STRING },
            clientName: { type: Type.STRING },
            detectedFooterClauses: { type: Type.STRING },
            lots: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  code: { type: Type.STRING },
                  name: { type: Type.STRING },
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        articleNo: { type: Type.STRING },
                        rawDesignation: { type: Type.STRING },
                        designation: { type: Type.STRING },
                        unit: { type: Type.STRING },
                        quantity: { type: Type.NUMBER },
                        pageNumber: { type: Type.INTEGER },
                        abcClass: { type: Type.STRING },
                        trade: { type: Type.STRING },
                      },
                      required: ['articleNo', 'rawDesignation', 'designation', 'unit', 'quantity', 'pageNumber', 'abcClass', 'trade'],
                    },
                  },
                },
                required: ['code', 'name', 'items'],
              },
            },
            anomalies: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  severity: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  articleNo: { type: Type.STRING },
                  pageNumber: { type: Type.INTEGER },
                  suggestedMultiplierPct: { type: Type.NUMBER },
                  suggestedUnit: { type: Type.STRING },
                  clauseTag: { type: Type.STRING },
                },
                required: ['type', 'severity', 'title', 'description', 'pageNumber'],
              },
            },
          },
          required: ['lots', 'anomalies'],
        },
      },
    });

    const rawText = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawText);
    return res.json(parsed);
  } catch (err: unknown) {
    console.error('Gemini /api/extract-bqe error:', err);
    const message = err instanceof Error ? err.message : 'Erreur lors de l’extraction Gemini Vision.';
    return res.status(500).json({ error: message });
  }
});

/**
 * Layer 3: Supplier Proforma Photo OCR Parser (rate-limited for no-login Micro-RFQ portal)
 */
app.post('/api/parse-proforma', proformaLimiter, async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg', rfqItems = [] } = req.body as {
      imageBase64?: string;
      mimeType?: string;
      rfqItems?: Array<{ lineItemId: string; articleNo: string; designation: string; unit: string; quantity: number }>;
    };

    if (!imageBase64) {
      return res.status(400).json({ error: 'Aucune photo de facture proforma fournie.' });
    }
    if (rfqItems.length > 30) {
      return res.status(400).json({ error: 'Trop d’articles dans la demande Micro-RFQ (max 30).' });
    }

    const ai = getGeminiClient();
    const itemsList = rfqItems
      .map((it) => `- ID=${it.lineItemId} | Art.${it.articleNo} | ${it.designation} (${it.quantity} ${it.unit})`)
      .join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
          {
            text: `Lis cette facture proforma fournisseur algérienne en Dinars Algériens (DA HT).
Extrais le nom du fournisseur, le délai de livraison estimé en jours, et associe chaque prix unitaire HT (en DA) aux articles demandés ci-dessous :
${itemsList}

Si un article n'apparaît pas sur la proforma, ne l'invente pas (mets 0).`,
          },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            supplierName: { type: Type.STRING },
            leadTimeDays: { type: Type.INTEGER },
            notes: { type: Type.STRING },
            matchedQuotes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lineItemId: { type: Type.STRING },
                  unitPriceDa: { type: Type.NUMBER },
                  brand: { type: Type.STRING },
                  availability: { type: Type.STRING },
                },
                required: ['lineItemId', 'unitPriceDa', 'brand', 'availability'],
              },
            },
          },
          required: ['matchedQuotes'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    return res.json(parsed);
  } catch (err: unknown) {
    console.error('Gemini /api/parse-proforma error:', err);
    const message = err instanceof Error ? err.message : 'Erreur lecture proforma par IA.';
    return res.status(500).json({ error: message });
  }
});

async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ChiffrageDZ server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
