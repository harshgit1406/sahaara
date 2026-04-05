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

interface HealthData {
  firebase: {
    initialized: boolean;
    projectId: string | null;
    credentialSource: string;
  };
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

interface GroceryOrderData {
  orderId: string;
}

interface PharmacyOrderData {
  orderId: string;
}

interface AppointmentOrderData {
  appointmentId: string;
}

export interface QueueAgentTaskInput {
  taskType: string;
  payload?: Record<string, unknown>;
  target?: string;
  createdBy?: string;
}

const env = import.meta.env as Env;
const DEFAULT_BASE_URL = "https://sahaara-api.vercel.app";
const DEFAULT_WATCH_USER_ID = "user123";

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
    const payload = (await response.json().catch(() => null)) as
      | {
          message?: unknown;
          error?: unknown;
        }
      | null;

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

export async function placeGroceryOrder(input: {
  userId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  deliveryAddress?: string;
}): Promise<{ orderId: string }> {
  const payload = await request<GroceryOrderData>("/api/grocery/order", {
    method: "POST",
    body: JSON.stringify({
      userId: input.userId,
      items: [{ name: input.itemName, quantity: input.quantity ?? 1, unit: input.unit ?? "1 unit" }],
      deliveryAddress: input.deliveryAddress || null,
      notes: "Placed from ai web app",
    }),
  });

  return { orderId: payload.data.orderId };
}

export async function placePharmacyOrder(input: {
  userId: string;
  medicineName: string;
  quantity?: number;
  unit?: string;
}): Promise<{ orderId: string }> {
  const payload = await request<PharmacyOrderData>("/api/pharmacy/order", {
    method: "POST",
    body: JSON.stringify({
      userId: input.userId,
      medicines: [{ name: input.medicineName, quantity: input.quantity ?? 1, unit: input.unit ?? "1 strip" }],
      prescriptionRequired: false,
      notes: "Placed from ai web app",
    }),
  });

  return { orderId: payload.data.orderId };
}

export async function placeDoctorAppointment(input: {
  userId: string;
  doctorName: string;
  specialization: string;
  appointmentTime: string;
  mode: "online" | "home";
}): Promise<{ appointmentId: string }> {
  const payload = await request<AppointmentOrderData>("/api/appointment/book", {
    method: "POST",
    body: JSON.stringify({
      userId: input.userId,
      doctorName: input.doctorName,
      specialization: input.specialization,
      appointmentTime: input.appointmentTime,
      mode: input.mode,
      notes: "Booked from ai web app",
    }),
  });

  return { appointmentId: payload.data.appointmentId };
}
