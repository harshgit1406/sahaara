type Env = ImportMetaEnv & {
  readonly VITE_SAHAARA_API_BASE_URL?: string;
  readonly VITE_SAHAARA_WATCH_USER_ID?: string;
};

interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  timestamp: string;
  data: T;
  error?: unknown;
}

interface ApiErrorPayload {
  message?: unknown;
  error?: unknown;
}

interface HealthData {
  firebase: {
    initialized: boolean;
    projectId: string | null;
    credentialSource: string;
  };
}

export interface MedicineReminder {
  id: string;
  userId: string;
  medicineName: string;
  dose: string;
  time24: string;
  days: string[];
  notes: string;
  nextTriggerAt: string;
  lastTriggeredAt?: string;
  createdAt: string;
}

interface MedicineReminderRecord {
  id?: unknown;
  userId?: unknown;
  medicineName?: unknown;
  dose?: unknown;
  time24?: unknown;
  days?: unknown;
  notes?: unknown;
  nextTriggerAt?: unknown;
  lastTriggeredAt?: unknown;
  createdAt?: unknown;
}

interface MedicineReminderData {
  reminder: MedicineReminderRecord;
}

interface MedicineReminderListData {
  reminders: MedicineReminderRecord[];
}

export interface WatchLatestSnapshot {
  userId: string;
  snapshot: {
    heartRate?: number;
    spo2?: number;
    skinTemp?: number;
    freefallStatus?: string;
    fallDetected?: boolean;
    impactDetected?: boolean;
    stillnessConfirmed?: boolean;
    alertTriggered?: boolean;
    updatedAt?: string;
  };
}

interface WatchLatestData {
  userId: string;
  snapshot: WatchLatestSnapshot["snapshot"];
}

interface WatchFreefallData {
  userId: string;
  freefall: {
    status?: string;
  };
}

interface AgentTaskRecord {
  id: string;
  target: string;
  taskType: string;
  payload: Record<string, unknown>;
  createdBy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface QueueAgentTaskData {
  task: AgentTaskRecord;
}

interface UiConfirmationResult {
  status?: string;
  orderId?: string;
  appointmentId?: string;
  itemName?: string;
  medicineName?: string;
  doctorName?: string;
  slot?: string;
  price?: number;
  fee?: number;
  eta?: string;
}

interface UiConfirmationRecord {
  id: string;
  type: "grocery" | "pharmacy" | "doctor";
  status: "pending" | "confirmed" | "cancelled";
  message: string;
  createdAt: number;
  itemName?: string | null;
  medicineName?: string | null;
  doctorName?: string | null;
  price?: number | null;
  fee?: number | null;
  slot?: string | null;
  visitType?: "online" | "home" | null;
  result: UiConfirmationResult | null;
}

interface UiPendingConfirmationsResponse {
  items: UiConfirmationRecord[];
}

interface UiRequestResponse {
  confirmationId: string;
  status: string;
  itemName?: string;
  medicineName?: string;
  doctorName?: string;
  price?: number;
  fee?: number;
  slot?: string;
  message?: string;
}

export interface QueueAgentTaskInput {
  taskType: string;
  payload?: Record<string, unknown>;
  target?: string;
  createdBy?: string;
}

type AssistantOrderKind = "grocery" | "pharmacy" | "doctor";

export interface PreparedAssistantOrder {
  kind: AssistantOrderKind;
  assistantRequestId: string;
  taskId: string | null;
  confirmationId: string;
  quantity: number;
  itemName: string;
  unitPrice: number;
  totalPrice: number;
  message: string;
  doctorMode?: "online" | "home";
}

export interface ConfirmedAssistantOrder {
  kind: AssistantOrderKind;
  assistantRequestId: string;
  taskId: string | null;
  confirmationId: string;
  status: "confirmed" | "cancelled";
  orderId?: string;
  appointmentId?: string;
  itemName?: string;
  medicineName?: string;
  doctorName?: string;
  price?: number;
  fee?: number;
  eta?: string;
  slot?: string;
}

const env = import.meta.env as Env;
const DEFAULT_BASE_URL = "https://sahaara-api.vercel.app";
const DEFAULT_WATCH_USER_ID = "user123";
const ORDER_CONFIRMATION_POLL_START_DELAY_MS = 1000;
const ORDER_CONFIRMATION_POLL_INTERVAL_MS = 1000;

function resolveBaseUrl() {
  return (env.VITE_SAHAARA_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function toAbsoluteUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const base = resolveBaseUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function readError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;

    const maybeMessage = payload?.message;
    const maybeError = payload?.error;

    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage.trim();
    if (typeof maybeError === "string" && maybeError.trim()) return maybeError.trim();

    if (maybeError != null) {
      try {
        return JSON.stringify(maybeError);
      } catch {
        return String(maybeError);
      }
    }
  }

  return (await response.text().catch(() => "")).trim() || `HTTP ${response.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(toAbsoluteUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as ApiEnvelope<T>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(toAbsoluteUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as T;
}

function makeAssistantRequestId(kind: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ai-${kind}-${Date.now()}-${rand}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function listPendingConfirmations(): Promise<UiConfirmationRecord[]> {
  const payload = await requestJson<UiPendingConfirmationsResponse>("/api/confirmations/pending", {
    method: "GET",
  });
  return Array.isArray(payload.items) ? payload.items : [];
}

async function getConfirmation(confirmationId: string): Promise<UiConfirmationRecord> {
  return requestJson<UiConfirmationRecord>(`/api/confirmations/${encodeURIComponent(confirmationId)}`, {
    method: "GET",
  });
}

async function resolveConfirmation(confirmationId: string, confirm: boolean): Promise<UiConfirmationRecord> {
  return requestJson<UiConfirmationRecord>(`/api/confirmations/${encodeURIComponent(confirmationId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ confirm }),
  });
}

async function queueUiDemoTask(
  taskType: string,
  payload: Record<string, unknown>,
  assistantRequestId: string,
): Promise<string | null> {
  try {
    const task = await queueAgentTask({
      target: "ui-demo",
      taskType,
      payload: {
        ...payload,
        assistantRequestId,
      },
      createdBy: `ai-assistant:${assistantRequestId}`,
    });
    return task.id;
  } catch {
    return null;
  }
}

async function waitForPendingConfirmationByType(
  type: "grocery" | "pharmacy" | "doctor",
  minCreatedAt: number,
  timeoutMs = 15000,
): Promise<UiConfirmationRecord | null> {
  const started = Date.now();
  await sleep(ORDER_CONFIRMATION_POLL_START_DELAY_MS);

  while (Date.now() - started < timeoutMs) {
    const pending = await listPendingConfirmations();
    const match = pending.find((item) => item.type === type && Number(item.createdAt || 0) >= minCreatedAt - 5000);
    if (match) {
      return match;
    }
    await sleep(ORDER_CONFIRMATION_POLL_INTERVAL_MS);
  }
  return null;
}

async function ensurePendingConfirmation(
  type: "grocery" | "pharmacy" | "doctor",
  createRequest: () => Promise<UiRequestResponse>,
  minCreatedAt: number,
): Promise<UiConfirmationRecord> {
  let confirmationId: string;
  const pending = await waitForPendingConfirmationByType(type, minCreatedAt);

  if (pending?.id) {
    confirmationId = pending.id;
  } else {
    const created = await createRequest();
    confirmationId = created.confirmationId;
  }

  const existing = await getConfirmation(confirmationId);
  return existing;
}

export async function confirmPreparedOrder(prepared: PreparedAssistantOrder, confirm: boolean): Promise<ConfirmedAssistantOrder> {
  const resolved = await resolveConfirmation(prepared.confirmationId, confirm);
  const status: "confirmed" | "cancelled" = resolved.status === "confirmed" ? "confirmed" : "cancelled";

  return {
    kind: prepared.kind,
    assistantRequestId: prepared.assistantRequestId,
    taskId: prepared.taskId,
    confirmationId: prepared.confirmationId,
    status,
    orderId: resolved.result?.orderId,
    appointmentId: resolved.result?.appointmentId,
    itemName: resolved.result?.itemName,
    medicineName: resolved.result?.medicineName,
    doctorName: resolved.result?.doctorName,
    price: resolved.result?.price,
    fee: resolved.result?.fee,
    eta: resolved.result?.eta,
    slot: resolved.result?.slot,
  };
}

export async function prepareGroceryOrder(input: {
  userId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  deliveryAddress?: string;
}): Promise<PreparedAssistantOrder> {
  const assistantRequestId = makeAssistantRequestId("grocery");
  const quantity = Math.max(1, input.quantity ?? 1);
  const taskCreatedAt = Date.now();
  const taskId = await queueUiDemoTask(
    "order.request",
    {
      itemName: input.itemName,
      quantity,
      unit: input.unit ?? "unit",
      deliveryAddress: input.deliveryAddress || null,
      userId: input.userId,
    },
    assistantRequestId,
  );

  const pending = await ensurePendingConfirmation(
    "grocery",
    async () =>
      requestJson<UiRequestResponse>("/api/grocery/request", {
        method: "POST",
        body: JSON.stringify({
          itemName: input.itemName,
        }),
      }),
    taskCreatedAt,
  );

  const unitPrice = Number(pending.price ?? pending.result?.price ?? 149);
  const itemName = String(pending.itemName || input.itemName || "grocery item");

  return {
    kind: "grocery",
    assistantRequestId,
    taskId,
    confirmationId: pending.id,
    quantity,
    itemName,
    unitPrice,
    totalPrice: unitPrice * quantity,
    message: pending.message || `Confirm order for ${itemName}`,
  };
}

export async function preparePharmacyOrder(input: {
  userId: string;
  medicineName: string;
  quantity?: number;
  unit?: string;
}): Promise<PreparedAssistantOrder> {
  const assistantRequestId = makeAssistantRequestId("pharmacy");
  const quantity = Math.max(1, input.quantity ?? 1);
  const taskCreatedAt = Date.now();
  const taskId = await queueUiDemoTask(
    "medicine.request",
    {
      medicineName: input.medicineName,
      quantity,
      unit: input.unit ?? "strip",
      userId: input.userId,
    },
    assistantRequestId,
  );

  const pending = await ensurePendingConfirmation(
    "pharmacy",
    async () =>
      requestJson<UiRequestResponse>("/api/pharmacy/request", {
        method: "POST",
        body: JSON.stringify({
          medicineName: input.medicineName,
        }),
      }),
    taskCreatedAt,
  );

  const unitPrice = Number(pending.price ?? pending.result?.price ?? 160);
  const itemName = String(pending.medicineName || input.medicineName || "medicine");

  return {
    kind: "pharmacy",
    assistantRequestId,
    taskId,
    confirmationId: pending.id,
    quantity,
    itemName,
    unitPrice,
    totalPrice: unitPrice * quantity,
    message: pending.message || `Confirm order for ${itemName}`,
  };
}

export async function prepareDoctorAppointment(input: {
  userId: string;
  doctorName: string;
  specialization: string;
  appointmentTime: string;
  mode: "online" | "home";
}): Promise<PreparedAssistantOrder> {
  const assistantRequestId = makeAssistantRequestId("doctor");
  const taskCreatedAt = Date.now();
  const doctorType = String(input.specialization || "general physician").trim().toLowerCase();
  const visitType: "online" | "home" = input.mode === "home" ? "home" : "online";

  const taskId = await queueUiDemoTask(
    "doctor.request",
    {
      doctorType,
      visitType,
      userId: input.userId,
    },
    assistantRequestId,
  );

  const pending = await ensurePendingConfirmation(
    "doctor",
    async () =>
      requestJson<UiRequestResponse>("/api/doctor/request", {
        method: "POST",
        body: JSON.stringify({
          doctorType,
          visitType,
        }),
      }),
    taskCreatedAt,
  );

  const unitPrice = Number(pending.fee ?? pending.result?.fee ?? 700);
  const itemName = String(pending.doctorName || input.doctorName || "Available Doctor");

  return {
    kind: "doctor",
    assistantRequestId,
    taskId,
    confirmationId: pending.id,
    quantity: 1,
    itemName,
    unitPrice,
    totalPrice: unitPrice,
    message: pending.message || `Confirm appointment with ${itemName}`,
    doctorMode: visitType,
  };
}

export async function getSahaaraHealth(): Promise<HealthData> {
  const payload = await request<HealthData>("/api/health", {
    method: "GET",
  });
  return payload.data;
}

export function getWatchUserId() {
  return env.VITE_SAHAARA_WATCH_USER_ID?.trim() || DEFAULT_WATCH_USER_ID;
}

export async function getWatchLatest(userId: string): Promise<WatchLatestSnapshot> {
  const payload = await request<WatchLatestData>(`/api/watch/latest/${encodeURIComponent(userId)}`, {
    method: "GET",
  });

  return {
    userId: payload.data.userId,
    snapshot: payload.data.snapshot || {},
  };
}

export async function getWatchFreefallLatest(userId: string): Promise<string | null> {
  const payload = await request<WatchFreefallData>(`/api/watch/freefall/latest/${encodeURIComponent(userId)}`, {
    method: "GET",
  });

  const status = payload.data.freefall?.status;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

export async function queueAgentTask(input: QueueAgentTaskInput): Promise<AgentTaskRecord> {
  const payload = await request<QueueAgentTaskData>("/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({
      taskType: input.taskType,
      payload: input.payload || {},
      target: input.target || "ui-demo",
      createdBy: input.createdBy || "ai-web",
    }),
  });

  return payload.data.task;
}

function toMedicineReminder(record: MedicineReminderRecord): MedicineReminder {
  const daysRaw = Array.isArray(record.days) ? record.days.filter((item) => typeof item === "string") : [];
  return {
    id: String(record.id || ""),
    userId: String(record.userId || ""),
    medicineName: String(record.medicineName || "medicine"),
    dose: String(record.dose || "1 dose"),
    time24: String(record.time24 || "09:00"),
    days: daysRaw.map((item) => String(item).trim()).filter(Boolean),
    notes: String(record.notes || ""),
    nextTriggerAt: String(record.nextTriggerAt || new Date().toISOString()),
    lastTriggeredAt: record.lastTriggeredAt ? String(record.lastTriggeredAt) : undefined,
    createdAt: String(record.createdAt || new Date().toISOString()),
  };
}

export async function createMedicineReminder(input: {
  userId: string;
  medicineName: string;
  dose?: string;
  time24: string;
  notes?: string;
  days?: string[];
}): Promise<MedicineReminder> {
  const payload = await request<MedicineReminderData>("/api/medicine-reminders", {
    method: "POST",
    body: JSON.stringify({
      userId: input.userId,
      medicineName: input.medicineName,
      dose: input.dose || "1 dose",
      time24: input.time24,
      notes: input.notes || "",
      days: input.days || [],
    }),
  });

  return toMedicineReminder(payload.data.reminder || {});
}

export async function listMedicineReminders(userId: string): Promise<MedicineReminder[]> {
  const payload = await request<MedicineReminderListData>(
    `/api/medicine-reminders?userId=${encodeURIComponent(userId)}`,
    {
      method: "GET",
    },
  );

  return Array.isArray(payload.data.reminders)
    ? payload.data.reminders.map((item) => toMedicineReminder(item || {}))
    : [];
}

export async function acknowledgeMedicineReminder(reminderId: string): Promise<MedicineReminder> {
  const payload = await request<MedicineReminderData>(`/api/medicine-reminders/${encodeURIComponent(reminderId)}/ack`, {
    method: "POST",
  });

  return toMedicineReminder(payload.data.reminder || {});
}

export async function deleteMedicineReminder(reminderId: string): Promise<void> {
  await request<{}>(`/api/medicine-reminders/${encodeURIComponent(reminderId)}`, {
    method: "DELETE",
  });
}

export async function placeGroceryOrder(input: {
  userId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  deliveryAddress?: string;
}): Promise<{ orderId: string; assistantRequestId: string; taskId: string | null; confirmationId: string }> {
  const prepared = await prepareGroceryOrder(input);
  const confirmed = await confirmPreparedOrder(prepared, true);
  const orderId = String(confirmed.orderId || "").trim();
  if (!orderId) {
    throw new Error("Grocery confirmation resolved but order id is missing");
  }

  return {
    orderId,
    assistantRequestId: prepared.assistantRequestId,
    taskId: prepared.taskId,
    confirmationId: prepared.confirmationId,
  };
}

export async function placePharmacyOrder(input: {
  userId: string;
  medicineName: string;
  quantity?: number;
  unit?: string;
}): Promise<{ orderId: string; assistantRequestId: string; taskId: string | null; confirmationId: string }> {
  const prepared = await preparePharmacyOrder(input);
  const confirmed = await confirmPreparedOrder(prepared, true);
  const orderId = String(confirmed.orderId || "").trim();
  if (!orderId) {
    throw new Error("Pharmacy confirmation resolved but order id is missing");
  }

  return {
    orderId,
    assistantRequestId: prepared.assistantRequestId,
    taskId: prepared.taskId,
    confirmationId: prepared.confirmationId,
  };
}

export async function placeDoctorAppointment(input: {
  userId: string;
  doctorName: string;
  specialization: string;
  appointmentTime: string;
  mode: "online" | "home";
}): Promise<{ appointmentId: string; assistantRequestId: string; taskId: string | null; confirmationId: string }> {
  const prepared = await prepareDoctorAppointment(input);
  const confirmed = await confirmPreparedOrder(prepared, true);
  const appointmentId = String(confirmed.appointmentId || "").trim();
  if (!appointmentId) {
    throw new Error("Doctor confirmation resolved but appointment id is missing");
  }

  return {
    appointmentId,
    assistantRequestId: prepared.assistantRequestId,
    taskId: prepared.taskId,
    confirmationId: prepared.confirmationId,
  };
}
