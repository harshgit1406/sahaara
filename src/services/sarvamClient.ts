type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  mode: "voice" | "chat";
}

type AssistantReplyMode = "mix" | "english";

export interface OrderConfirmationMessageInput {
  kind: "grocery" | "pharmacy" | "doctor";
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  doctorMode?: "online" | "home";
  mode?: AssistantReplyMode;
  reminder?: boolean;
}

export type SahaaraIntentAction = "none" | "grocery_order" | "pharmacy_order" | "doctor_booking" | "watch_vitals" | "api_health";

export interface SahaaraIntentPlan {
  action: SahaaraIntentAction;
  itemName?: string;
  medicineName?: string;
  quantity?: number;
  doctorSpecialization?: string;
  doctorMode?: "online" | "home";
  confidence?: number;
}

export type ConfirmationDecision = "confirm" | "cancel" | "unclear";

export interface ConfirmationPlan {
  decision: ConfirmationDecision;
  confidence?: number;
}

type LlmRole = "system" | "user" | "assistant";

interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface SarvamConfig {
  apiKey?: string;
  baseUrl?: string;
}

type Env = ImportMetaEnv & {
  readonly VITE_SARVAM_API_KEY?: string;
  readonly VITE_SARVAM_BASE_URL?: string;
  readonly VITE_SARVAM_LLM_ENDPOINT?: string;
  readonly VITE_SARVAM_TTS_ENDPOINT?: string;
  readonly VITE_SARVAM_STT_ENDPOINT?: string;
  readonly VITE_SARVAM_LLM_MODEL?: string;
  readonly VITE_SARVAM_TTS_MODEL?: string;
  readonly VITE_SARVAM_TTS_SPEAKER?: string;
  readonly VITE_SARVAM_TTS_LANG?: string;
};

const env = import.meta.env as Env;

export function isSarvamConfigured() {
  return Boolean(env.VITE_SARVAM_API_KEY?.trim());
}

function getSarvamConfig(overrides?: SarvamConfig) {
  const apiKey = overrides?.apiKey?.trim() || env.VITE_SARVAM_API_KEY?.trim() || "";
  const baseUrl = overrides?.baseUrl?.trim() || env.VITE_SARVAM_BASE_URL?.trim() || "https://api.sarvam.ai";

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    llmEndpoint: env.VITE_SARVAM_LLM_ENDPOINT?.trim() || "/v1/chat/completions",
    ttsEndpoint: env.VITE_SARVAM_TTS_ENDPOINT?.trim() || "/text-to-speech",
    sttEndpoint: env.VITE_SARVAM_STT_ENDPOINT?.trim() || "/speech-to-text",
    llmModel: env.VITE_SARVAM_LLM_MODEL?.trim() || "sarvam-m",
    ttsModel: env.VITE_SARVAM_TTS_MODEL?.trim() || "bulbul:v3",
    ttsSpeaker: env.VITE_SARVAM_TTS_SPEAKER?.trim() || "Ritu",
    ttsLang: env.VITE_SARVAM_TTS_LANG?.trim() || "en-IN",
  };
}

export async function llmReplyMock(
  prompt: string,
  history: ChatMessage[],
  mode: AssistantReplyMode = "mix",
): Promise<string> {
  await wait(650);

  const recentContext = history.slice(-4).map((item) => item.text).join(" ").slice(0, 280);
  const cleanedPrompt = prompt.replace(/\s+/g, " ").trim();

  if (mode === "english") {
    return `I heard: "${cleanedPrompt}". I can help with health support, reminders, and guidance. ${
      recentContext ? `I also considered recent context: ${recentContext}` : ""
    }`;
  }

  return `Maine suna: "${cleanedPrompt}". Main health support, reminders, aur guidance mein help kar sakti hoon. ${
    recentContext ? `Maine recent context bhi consider kiya: ${recentContext}` : ""
  }`;
}

export async function llmReplySarvam(
  prompt: string,
  history: ChatMessage[],
  config?: SarvamConfig,
  mode: AssistantReplyMode = "mix",
  sessionInstruction?: string,
): Promise<string> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.llmEndpoint);
  const styleInstruction =
    mode === "english"
      ? "Reply in clear English only."
      : "Reply in natural Hindi + English mix (Hinglish). Keep it concise and friendly.use very frndly and respectful tone. Avoid using words like 'karo'. Prefer respectful phrasing like 'kariye'.";

  const historyMessages: LlmMessage[] = history
    .slice(-10)
    .map((item): LlmMessage => ({ role: item.role as "user" | "assistant", content: item.text }));
  const messages: LlmMessage[] = [{ role: "system", content: styleInstruction }];
  const sessionText = String(sessionInstruction || "").trim();
  if (sessionText) {
    messages.push({ role: "system", content: sessionText });
  }
  messages.push(...historyMessages, { role: "user", content: prompt });

  const body = {
    model: resolved.llmModel,
    messages,
    temperature: 0.6,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": resolved.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await responseError("Sarvam LLM", response));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractLlmText(payload);
  if (!text) {
    throw new Error("Sarvam LLM response did not include assistant text.");
  }

  return text;
}

export async function inferSahaaraIntentSarvam(
  prompt: string,
  history: ChatMessage[] = [],
  config?: SarvamConfig,
): Promise<SahaaraIntentPlan | null> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.llmEndpoint);
  const systemPrompt =
    "You are an intent parser for a Hindi-first voice assistant. Correct ASR mistakes, Hinglish spellings, and transliterated Hindi. Return ONLY one valid compact JSON object with keys: action, itemName, medicineName, quantity, doctorSpecialization, doctorMode, confidence. action must be one of: none,grocery_order,pharmacy_order,doctor_booking,watch_vitals,api_health. quantity must be integer >=1 when present. doctorMode must be online or home when present.";

  const historyMessages: LlmMessage[] = history
    .slice(-6)
    .map((item): LlmMessage => ({ role: item.role as LlmRole, content: item.text }));
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: prompt },
  ];

  const body = {
    model: resolved.llmModel,
    messages,
    temperature: 0,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": resolved.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await responseError("Sarvam intent", response));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractLlmText(payload);
  if (!text) {
    return null;
  }

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return null;
  }

  const rawAction = asText(parsed.action).toLowerCase();
  const allowed: SahaaraIntentAction[] = [
    "none",
    "grocery_order",
    "pharmacy_order",
    "doctor_booking",
    "watch_vitals",
    "api_health",
  ];
  const action: SahaaraIntentAction = allowed.includes(rawAction as SahaaraIntentAction)
    ? (rawAction as SahaaraIntentAction)
    : "none";

  const qRaw = Number(parsed.quantity);
  const quantity = Number.isFinite(qRaw) && qRaw > 0 ? Math.round(qRaw) : undefined;

  const modeRaw = asText(parsed.doctorMode).toLowerCase();
  const doctorMode = modeRaw === "home" || modeRaw === "online" ? modeRaw : undefined;

  const confRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : undefined;

  return {
    action,
    itemName: asText(parsed.itemName) || undefined,
    medicineName: asText(parsed.medicineName) || undefined,
    quantity,
    doctorSpecialization: asText(parsed.doctorSpecialization) || undefined,
    doctorMode,
    confidence,
  };
}

export async function inferConfirmationDecisionSarvam(
  prompt: string,
  context?: {
    kind?: "grocery" | "pharmacy" | "doctor";
    itemName?: string;
    quantity?: number;
    totalPrice?: number;
  },
  config?: SarvamConfig,
): Promise<ConfirmationPlan | null> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.llmEndpoint);
  const systemPrompt =
    "You classify confirmation replies for an order assistant in Hindi, Hinglish, and English with ASR mistakes. Return ONLY compact JSON: {\"decision\":\"confirm|cancel|unclear\",\"confidence\":0..1}.";

  const contextText = context
    ? `Pending: kind=${context.kind || "unknown"}, item=${context.itemName || "unknown"}, qty=${context.quantity ?? "unknown"}, total=${context.totalPrice ?? "unknown"}`
    : "Pending: unknown";

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${contextText}\nUser reply: ${prompt}` },
  ];

  const body = {
    model: resolved.llmModel,
    messages,
    temperature: 0,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": resolved.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await responseError("Sarvam confirmation", response));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractLlmText(payload);
  if (!text) return null;

  const parsed = parseJsonObject(text);
  if (!parsed) return null;

  const rawDecision = asText(parsed.decision).toLowerCase();
  const decision: ConfirmationDecision =
    rawDecision === "confirm" || rawDecision === "cancel" || rawDecision === "unclear"
      ? (rawDecision as ConfirmationDecision)
      : "unclear";

  const confRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : undefined;

  return { decision, confidence };
}

export async function composeOrderConfirmationMessageSarvam(
  input: OrderConfirmationMessageInput,
  config?: SarvamConfig,
): Promise<string | null> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.llmEndpoint);
  const mode = input.mode || "mix";
  const styleInstruction =
    mode === "english"
      ? "Write in polite English only."
      : "Write in polite respectful Hinglish (Hindi + English mix), concise, clear, and warm.";

  const templateHint =
    mode === "english"
      ? "Use this style: Please confirm the order for <item> with value Rs <amount>."
      : "Use this style idea naturally: '<item> ko mangane ke liye jiski value Rs <amount> hai, kripya confirm kariye.'";

  const context = [
    `kind=${input.kind}`,
    `item=${input.itemName}`,
    `quantity=${input.quantity}`,
    `unitPrice=${input.unitPrice}`,
    `totalPrice=${input.totalPrice}`,
    `doctorMode=${input.doctorMode || "na"}`,
    `reminder=${Boolean(input.reminder)}`,
  ].join(", ");

  const systemPrompt =
    `${styleInstruction} You are a transactional assistant writing order confirmation prompts.` +
    ` Mention item, quantity and amount clearly. Ask user to reply confirm/cancel.` +
    ` Do not use words like 'karo'. Prefer respectful phrasing like 'kariye'.` +
    ` ${templateHint} Return plain text only.`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Generate confirmation prompt for: ${context}` },
  ];

  const body = {
    model: resolved.llmModel,
    messages,
    temperature: 0.3,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": resolved.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await responseError("Sarvam confirmation-msg", response));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractLlmText(payload);
  return text || null;
}

export async function ttsSarvam(text: string, config?: SarvamConfig): Promise<ArrayBuffer> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.ttsEndpoint);

  const attempts: Array<Record<string, unknown>> = [
    {
      inputs: [text],
      target_language_code: resolved.ttsLang,
      speaker: resolved.ttsSpeaker,
      model: resolved.ttsModel,
      enable_preprocessing: true,
      pace: 1,
    },
    {
      input: text,
      target_language_code: resolved.ttsLang,
      speaker: resolved.ttsSpeaker,
      model: resolved.ttsModel,
      enable_preprocessing: true,
      pace: 1,
    },
    {
      text,
      target_language_code: resolved.ttsLang,
      voice: resolved.ttsSpeaker,
      model: resolved.ttsModel,
      enable_preprocessing: true,
      pace: 1,
    },
  ];

  let lastError = "";

  for (const body of attempts) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": resolved.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const payload = (await response.json()) as { audios?: string[]; audio?: string };
      const base64Audio = payload.audios?.[0] || payload.audio;
      if (!base64Audio) {
        throw new Error("Sarvam TTS response missing audio payload.");
      }
      return decodeBase64ToArrayBuffer(base64Audio);
    }

    lastError = await responseError("Sarvam TTS", response);
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      break;
    }
  }

  throw new Error(lastError || "Sarvam TTS request failed.");
}

export async function sttSarvam(audio: Blob, config?: SarvamConfig): Promise<string> {
  const resolved = getSarvamConfig(config);
  ensureApiKey(resolved.apiKey);

  const endpoint = toAbsoluteUrl(resolved.baseUrl, resolved.sttEndpoint);
  const formData = new FormData();
  formData.append("file", audio, "speech.webm");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "api-subscription-key": resolved.apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await responseError("Sarvam STT", response));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractSttText(payload);
  if (!text) {
    throw new Error("Sarvam STT response did not include transcript text.");
  }

  return text;
}

function ensureApiKey(apiKey: string) {
  if (!apiKey) {
    throw new Error("Missing VITE_SARVAM_API_KEY in .env file.");
  }
}

function toAbsoluteUrl(baseUrl: string, endpoint: string) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
}

function extractLlmText(payload: Record<string, unknown>): string {
  const direct = asText(payload.reply) || asText(payload.output_text) || asText(payload.text) || asText(payload.response);
  if (direct) return direct;

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = asText(message?.content) || asText(first.text);
    if (content) return content;
  }

  return "";
}

function extractSttText(payload: Record<string, unknown>): string {
  return (
    asText(payload.transcript) ||
    asText(payload.text) ||
    asText(payload.output_text) ||
    asText(payload.response) ||
    ""
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? text.slice(first, last + 1) : text;

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64.replace(/^data:audio\/[^;]+;base64,/, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function responseError(prefix: string, response: Response): Promise<string> {
  const details = await extractResponseError(response);
  return details ? `${prefix} ${response.status}: ${details}` : `${prefix} ${response.status}`;
}

async function extractResponseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const json = (await response.json().catch(() => null)) as
      | {
          message?: unknown;
          error?: unknown;
          detail?: unknown;
          details?: unknown;
        }
      | null;

    const candidate = json?.message ?? json?.error ?? json?.detail ?? json?.details ?? "";

    if (typeof candidate === "string") return candidate.trim();
    if (candidate == null) return "";
    if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);

    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  return (await response.text().catch(() => "")).trim();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
