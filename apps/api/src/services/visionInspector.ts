import { GoogleGenAI } from '@google/genai';
import {
  StructuredPcbInspectionSchema,
  type StructuredPcbInspection,
} from '@coresense/shared';
import type { ImageInspectionMetadata } from './imageInspector.js';

const STRUCTURED_PCB_JSON_SCHEMA = {
  type: 'object',
  properties: {
    boardOrDeviceType: {
      type: 'string',
      description: 'Concise identification of what is pictured (e.g. Laptop motherboard near USB-C charging circuit, Desktop GPU PCB, Smartphone logic board, OS BSOD/Error screen, Power connector).',
    },
    imageClarity: {
      type: 'string',
      enum: ['clear', 'moderate', 'unclear_macro_needed'],
      description: 'Honest assessment of image focus, lighting, and legibility of SMD silkscreen markings.',
    },
    clarityNotes: {
      type: 'string',
      description: 'Brief explanation of what is clearly readable vs obscured by glare, blur, or resolution.',
    },
    identifiedComponents: {
      type: 'array',
      description: 'Up to 10 clearly visible electronic components, connectors, ICs, ports, or error indicators.',
      items: {
        type: 'object',
        properties: {
          designator: {
            type: 'string',
            description: 'Silkscreen designator if legible (e.g. U7000, C412, Q3) or clear label (e.g. USB-C Port, Electrolytic Cap #1, GPU PCIe Fingers). Never fabricate unreadable silkscreen markings.',
          },
          componentType: {
            type: 'string',
            description: 'Component category (e.g. QFN IC, MLCC Capacitor, MOSFET, Inductor, Ribbon Connector, Fuse, Display Error).',
          },
          functionSummary: {
            type: 'string',
            description: 'Likely functional role on this board/device.',
          },
          visualCondition: {
            type: 'string',
            enum: [
              'normal',
              'suspect_burn',
              'suspect_corrosion',
              'suspect_cracked',
              'suspect_bulged',
              'missing_or_lifted',
              'loose_or_bent',
              'unreadable',
            ],
          },
          region: {
            type: 'string',
            description: 'Spatial location in the photo (e.g. upper-left near power jack, center-right).',
          },
          visualEvidence: {
            type: 'string',
            description: 'Exact visual observation only — never state an electrical short is confirmed solely from a photo.',
          },
          boundingBox: {
            type: 'array',
            items: { type: 'number' },
            description: 'Optional normalized bounding box [ymin, xmin, ymax, xmax] scaled 0..1000.',
          },
        },
        required: ['designator', 'componentType', 'functionSummary', 'visualCondition', 'region', 'visualEvidence'],
      },
    },
    visualAnomalies: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of visible physical defects, discoloration, residue, burn marks, or empty if none visible.',
    },
    electricalTestsRequired: {
      type: 'array',
      description: 'Concrete multimeter / bench verification measurements required to confirm electrical health.',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          testMethod: { type: 'string' },
          expectedBaseline: { type: 'string' },
          safetyNote: { type: 'string' },
        },
        required: ['target', 'testMethod', 'expectedBaseline', 'safetyNote'],
      },
    },
    safetyWarnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Relevant ESD, battery disconnect, or high-voltage capacitor safety warnings.',
    },
  },
  required: [
    'boardOrDeviceType',
    'imageClarity',
    'clarityNotes',
    'identifiedComponents',
    'visualAnomalies',
    'electricalTestsRequired',
    'safetyWarnings',
  ],
};

const PCB_VISION_SYSTEM_PROMPT = [
  'You are CoreSense Structured Hardware & PCB Vision Inspector (IPC-A-610 / bench-repair standard).',
  'Analyze the attached electronics photo or screenshot carefully and output strictly valid JSON matching the schema.',
  'STRICT ENGINEERING RULES:',
  '1. NEVER fabricate silkscreen markings, chip part numbers, or damage that is not genuinely visible. If markings are blurry or illegible, set visualCondition to "unreadable" and imageClarity to "unclear_macro_needed".',
  '2. NEVER claim a visual observation confirms an electrical short, open circuit, or dead IC. Visual inspection only identifies SUSPECT physical indicators; ALWAYS specify the exact multimeter/bench confirmation test needed in electricalTestsRequired.',
  '3. If the photo is a software/OS error screenshot rather than a circuit board, classify boardOrDeviceType accurately (e.g. "OS Error / Diagnostic Screenshot"), list visible error codes in identifiedComponents, and keep electricalTestsRequired focused on safe software/hardware verification checks.',
  '4. Include practical ESD, power-off, and high-voltage safety warnings whenever inspecting internal hardware.',
].join('\n');

const STANDARD_DISCLAIMER =
  'Visual inspection only — photos cannot electrically confirm short circuits, open traces, or internal IC failures. Always verify suspected faults with power-off resistance/diode-mode measurements or validated telemetry.';

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeBoundingBox(raw: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((n) => Number(n));
  if (nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) {
    return [nums[0], nums[1], nums[2], nums[3]];
  }
  return undefined;
}

export function buildLocalFallbackInspection(params: {
  filename: string;
  metadata: ImageInspectionMetadata;
  reason: string;
}): StructuredPcbInspection {
  const { filename, metadata, reason } = params;
  return {
    analysisMode: 'local_metadata_fallback',
    boardOrDeviceType: `Uploaded hardware image (${filename})`,
    imageClarity: metadata.isLowResolution ? 'unclear_macro_needed' : 'moderate',
    clarityNotes: `${metadata.clarityNote} ${reason}`,
    identifiedComponents: [],
    visualAnomalies: [],
    electricalTestsRequired: [
      {
        target: 'Suspected power rail or port',
        testMethod: 'Disconnect battery/AC power, inspect under bright macro lighting, then check resistance-to-ground on main rails with a digital multimeter.',
        expectedBaseline: 'Non-shorted rails typically read > 50–100 Ω (varies by low-impedance CPU/GPU core rails).',
        safetyNote: 'Always disconnect power & battery before probing resistance or diode mode. Never probe mains AC or high-voltage PSU primary capacitors.',
      },
    ],
    safetyWarnings: [
      'Disconnect AC power and internal battery before touching exposed PCB components.',
      'Use ESD protection and avoid probing live high-voltage power supply primary circuits.',
    ],
    disclaimer: STANDARD_DISCLAIMER,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function inspectHardwareImageStructured(params: {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  userMessage: string;
  imageAttachment: {
    filename: string;
    mimeType: string;
    base64Data: string;
    metadata: ImageInspectionMetadata;
  };
}): Promise<{
  inspection: StructuredPcbInspection;
  inputTokens: number;
  outputTokens: number;
}> {
  const { provider, apiKey, baseUrl, model, userMessage, imageAttachment } = params;

  if (provider === 'gemini' && apiKey) {
    const candidateModels = Array.from(new Set([model, 'gemini-3.5-flash-lite']));
    for (const activeModel of candidateModels) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const promptText = `User question / context: "${userMessage.slice(0, 600)}"\nImage metadata: ${imageAttachment.metadata.clarityNote}\nPerform a structured hardware/PCB visual inspection and return strictly matching JSON.`;

        const interaction = await withTimeout(
          ai.interactions.create({
            model: activeModel,
            system_instruction: PCB_VISION_SYSTEM_PROMPT,
            input: [
              {
                type: 'user_input',
                content: [
                  { type: 'text', text: promptText },
                  {
                    type: 'image',
                    data: imageAttachment.base64Data,
                    mime_type: imageAttachment.mimeType,
                  },
                ],
              },
            ] as unknown as string,
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: STRUCTURED_PCB_JSON_SCHEMA,
            } as unknown as Record<string, unknown>,
          }),
          20_000,
          `Gemini vision (${activeModel})`,
        );

        const rawText = interaction.output_text || '';
        const rawObj = extractJsonObject(rawText);
        const usage = (interaction as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;

        if (rawObj) {
          const sanitizedComponents = Array.isArray(rawObj.identifiedComponents)
            ? rawObj.identifiedComponents.slice(0, 12).map((c: Record<string, unknown>) => ({
                designator: String(c.designator || 'Visible component'),
                componentType: String(c.componentType || 'Unknown'),
                functionSummary: String(c.functionSummary || 'Hardware element'),
                visualCondition: String(c.visualCondition || 'unreadable'),
                region: String(c.region || 'Unspecified region'),
                visualEvidence: String(c.visualEvidence || 'Observed visually.'),
                ...(normalizeBoundingBox(c.boundingBox) ? { boundingBox: normalizeBoundingBox(c.boundingBox) } : {}),
              }))
            : [];

          const candidate = {
            analysisMode: 'gemini_vision_structured' as const,
            boardOrDeviceType: String(rawObj.boardOrDeviceType || 'Hardware / Electronics Photo'),
            imageClarity: rawObj.imageClarity || (imageAttachment.metadata.isLowResolution ? 'unclear_macro_needed' : 'moderate'),
            clarityNotes: String(rawObj.clarityNotes || imageAttachment.metadata.clarityNote),
            identifiedComponents: sanitizedComponents,
            visualAnomalies: Array.isArray(rawObj.visualAnomalies) ? rawObj.visualAnomalies.map(String).slice(0, 12) : [],
            electricalTestsRequired: Array.isArray(rawObj.electricalTestsRequired)
              ? rawObj.electricalTestsRequired.slice(0, 8).map((t: Record<string, unknown>) => ({
                  target: String(t.target || 'Suspect circuit'),
                  testMethod: String(t.testMethod || 'Multimeter check'),
                  expectedBaseline: String(t.expectedBaseline || 'Compare against schematic/known-good board'),
                  safetyNote: String(t.safetyNote || 'Power off and disconnect battery before probing.'),
                }))
              : [],
            safetyWarnings: Array.isArray(rawObj.safetyWarnings) ? rawObj.safetyWarnings.map(String).slice(0, 8) : [],
            disclaimer: STANDARD_DISCLAIMER,
          };

          const validated = StructuredPcbInspectionSchema.safeParse(candidate);
          if (validated.success) {
            return {
              inspection: validated.data,
              inputTokens: usage?.input_tokens ?? 800,
              outputTokens: usage?.output_tokens ?? Math.max(100, Math.ceil(rawText.length / 4)),
            };
          }
        }
      } catch {
        // Try next Gemini model on transient 503/overload before falling back to local intake
      }
    }
  } else if ((provider === 'openai' || provider === 'ollama') && baseUrl) {
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${PCB_VISION_SYSTEM_PROMPT}\nReturn a JSON object with keys: boardOrDeviceType, imageClarity, clarityNotes, identifiedComponents, visualAnomalies, electricalTestsRequired, safetyWarnings.` },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Inspect this hardware image for user note: "${userMessage.slice(0, 400)}". Metadata: ${imageAttachment.metadata.clarityNote}` },
                { type: 'image_url', image_url: { url: `data:${imageAttachment.mimeType};base64,${imageAttachment.base64Data}` } },
              ],
            },
          ],
          temperature: 0.2,
        }),
      });
      if (resp.ok) {
        const json = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const rawText = json.choices?.[0]?.message?.content || '';
        const rawObj = extractJsonObject(rawText);
        if (rawObj) {
          const candidate = {
            analysisMode: 'openai_vision_structured' as const,
            boardOrDeviceType: String(rawObj.boardOrDeviceType || 'Hardware Photo'),
            imageClarity: rawObj.imageClarity || 'moderate',
            clarityNotes: String(rawObj.clarityNotes || imageAttachment.metadata.clarityNote),
            identifiedComponents: Array.isArray(rawObj.identifiedComponents) ? rawObj.identifiedComponents : [],
            visualAnomalies: Array.isArray(rawObj.visualAnomalies) ? rawObj.visualAnomalies.map(String) : [],
            electricalTestsRequired: Array.isArray(rawObj.electricalTestsRequired) ? rawObj.electricalTestsRequired : [],
            safetyWarnings: Array.isArray(rawObj.safetyWarnings) ? rawObj.safetyWarnings.map(String) : [],
            disclaimer: STANDARD_DISCLAIMER,
          };
          const validated = StructuredPcbInspectionSchema.safeParse(candidate);
          if (validated.success) {
            return {
              inspection: validated.data,
              inputTokens: json.usage?.prompt_tokens ?? 800,
              outputTokens: json.usage?.completion_tokens ?? 250,
            };
          }
        }
      }
    } catch {
      // Fall through cleanly
    }
  }

  return {
    inspection: buildLocalFallbackInspection({
      filename: imageAttachment.filename,
      metadata: imageAttachment.metadata,
      reason:
        provider === 'coresense-local'
          ? 'External Vision AI is disabled or unconfigured — local engine records image metadata only and never fabricates visual markings.'
          : 'Structured vision extraction fell back to local metadata intake.',
    }),
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function formatStructuredInspectionForCopilot(inspection: StructuredPcbInspection): string {
  const lines = [
    `Structured Vision Inspection (${inspection.analysisMode}):`,
    `- Subject: ${inspection.boardOrDeviceType} | Image Clarity: ${inspection.imageClarity} (${inspection.clarityNotes})`,
  ];
  if (inspection.identifiedComponents.length > 0) {
    lines.push(
      `- Visible Components:\n${inspection.identifiedComponents
        .map((c) => `  * ${c.designator} (${c.componentType}, ${c.region}): [${c.visualCondition}] ${c.visualEvidence}`)
        .join('\n')}`,
    );
  }
  if (inspection.visualAnomalies.length > 0) {
    lines.push(`- Visual Anomalies: ${inspection.visualAnomalies.join('; ')}`);
  }
  if (inspection.electricalTestsRequired.length > 0) {
    lines.push(
      `- Required Electrical Confirmation Tests:\n${inspection.electricalTestsRequired
        .map((t) => `  * ${t.target}: ${t.testMethod} (Expected: ${t.expectedBaseline})`)
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}
