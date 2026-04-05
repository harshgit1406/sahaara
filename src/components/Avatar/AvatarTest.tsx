import { useMemo, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import type { AvatarControls, AvatarRenderState } from "./Avatar";
import type { EyeState } from "../../hooks/useBlink";
import type { LipSyncTuning } from "../../hooks/useLipSync";
import type { MouthState } from "../../hooks/useLipSync";
import type { Expression } from "../../hooks/useExpression";

const MOUTH_STATES: MouthState[] = [
  "neutral",
  "a_e_i",
  "b_m_p",
  "c_d_n_s_t_x_y_z",
  "g_k",
  "l",
  "o",
  "j_ch_sh",
  "u",
  "f_v",
  "ee",
  "q_w",
  "th",
];

const EYE_STATES: EyeState[] = ["open", "quarter_closed", "half_closed", "closed", "looking_right", "looking_up"];
const EXPRESSIONS: Expression[] = ["neutral", "happy", "concerned", "thinking"];

const DEFAULT_STATE: AvatarRenderState = {
  eye: "open",
  mouth: "neutral",
  expression: "neutral",
  speaking: false,
  metrics: {
    speaking: false,
    openness: 0,
    onsetBoost: 0,
    rms: 0,
    amplitude: 0,
    dominantHz: 0,
    highBandRatio: 0,
    lowBandRatio: 0,
    midBandRatio: 0,
    zcr: 0,
    calibrationProgress: 0,
    calibrated: false,
    mouth: "neutral",
  },
};

const DEFAULT_TUNING: LipSyncTuning = {
  lookAheadMs: 92,
  syncOffsetMs: 0,
  minStateHoldMs: 48,
  stableFrames: 2,
  smoothing: 0.72,
};

export function AvatarTest() {
  const controlsRef = useRef<AvatarControls | null>(null);

  const [avatarState, setAvatarState] = useState<AvatarRenderState>(DEFAULT_STATE);
  const [isThinking, setIsThinking] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("Ready: upload MP3 or play synthetic speech test.");

  const [audioBuffer, setAudioBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");

  const [manualMode, setManualMode] = useState(false);
  const [manualMouth, setManualMouth] = useState<MouthState>("neutral");
  const [manualEye, setManualEye] = useState<EyeState>("open");
  const [manualExpression, setManualExpression] = useState<Expression>("neutral");

  const [apiKey, setApiKey] = useState("");
  const [ttsText, setTtsText] = useState("Ramesh-ji, aapki dawai lene ka waqt ho gaya hai.");
  const [tuning, setTuning] = useState<LipSyncTuning>(DEFAULT_TUNING);

  const canPlayAudio = useMemo(() => !!audioBuffer && !isBusy, [audioBuffer, isBusy]);

  const setManualOverrides = (
    next: { mouth?: MouthState; eye?: EyeState; expression?: Expression },
    options?: { enableManual?: boolean }
  ) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const shouldEnable = options?.enableManual ?? manualMode;
    if (options?.enableManual !== undefined) {
      setManualMode(shouldEnable);
    }

    if (next.mouth) {
      setManualMouth(next.mouth);
      controls.setMouthOverride(shouldEnable ? next.mouth : null);
    }
    if (next.eye) {
      setManualEye(next.eye);
      controls.setEyeOverride(shouldEnable ? next.eye : null);
    }
    if (next.expression) {
      setManualExpression(next.expression);
      controls.setExpressionOverride(shouldEnable ? next.expression : null);
    }
  };

  const toggleManualMode = (enabled: boolean) => {
    setManualMode(enabled);
    const controls = controlsRef.current;
    if (!controls) return;

    if (!enabled) {
      controls.setMouthOverride(null);
      controls.setEyeOverride(null);
      controls.setExpressionOverride(null);
      return;
    }

    controls.setMouthOverride(manualMouth);
    controls.setEyeOverride(manualEye);
    controls.setExpressionOverride(manualExpression);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus("Loading file...");
    try {
      const buffer = await file.arrayBuffer();
      setAudioBuffer(buffer);
      setFileName(file.name);
      setStatus(`Loaded ${file.name}. Click Play to test lip-sync.`);
    } catch (error) {
      setStatus(`Could not read file: ${String(error)}`);
    }
  };

  const playAudioBuffer = async (buffer: ArrayBuffer, nextStatus: string) => {
    const controls = controlsRef.current;
    if (!controls) return;

    try {
      setIsBusy(true);
      setStatus(nextStatus);
      await controls.playAudio(buffer.slice(0));
      setStatus("Playback finished.");
    } catch (error) {
      setStatus(`Playback error: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const playUploadedFile = async () => {
    if (!audioBuffer) return;
    await playAudioBuffer(audioBuffer, `Playing ${fileName || "audio"}...`);
  };

  const playSynthetic = async () => {
    try {
      setIsBusy(true);
      setStatus("Generating synthetic speech tone...");
      const buffer = await generateSpeechTone();
      setStatus("Playing synthetic speech tone...");
      await controlsRef.current?.playAudio(buffer);
      setStatus("Synthetic test finished.");
    } catch (error) {
      setStatus(`Synthetic test failed: ${String(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const playLiveTts = async () => {
    if (!apiKey.trim()) {
      setStatus("Enter Sarvam API key first.");
      return;
    }
    if (!controlsRef.current) return;

    try {
      setIsBusy(true);
      setIsThinking(true);
      setStatus("Fetching TTS audio from Sarvam...");

      const payload = await requestSarvamTtsAudio({
        apiKey: apiKey.trim(),
        text: ttsText,
      });
      const base64Audio = payload?.audios?.[0] as string | undefined;
      if (!base64Audio) {
        throw new Error("No audio returned from Sarvam API.");
      }

      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Thinking mode is for request/processing phase; turn it off before playback starts.
      setIsThinking(false);
      controlsRef.current.applyExpressionFromText(ttsText);
      await playAudioBuffer(bytes.buffer, "Playing Sarvam TTS...");
    } catch (error) {
      setStatus(`TTS failed: ${String(error)}`);
    } finally {
      setIsBusy(false);
      setIsThinking(false);
    }
  };

  const stopPlayback = () => {
    controlsRef.current?.stopAudio();
    setIsBusy(false);
    setIsThinking(false);
    setStatus("Playback stopped.");
  };

  const updateTuning = (patch: Partial<LipSyncTuning>) => {
    const next = { ...tuning, ...patch };
    setTuning(next);
    controlsRef.current?.setLipSyncTuning(next);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col">
        <header className="border-b border-slate-800 bg-slate-950/90 px-5 py-4 backdrop-blur md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-emerald-300">Sahaara Avatar Lab</h1>
              <p className="text-sm text-slate-400">
                MP3 lip-sync testing today, live voice chatbot integration ready next.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isBusy ? "animate-pulse bg-emerald-400" : isThinking ? "animate-pulse bg-amber-300" : "bg-slate-600"
                }`}
              />
              <span className="text-xs text-slate-300">{status}</span>
            </div>
          </div>
        </header>

        <main className="grid flex-1 gap-5 px-4 py-5 md:grid-cols-[1fr_360px] md:px-8">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 md:p-6">
            <div className="mx-auto w-full max-w-5xl">
              <Avatar
                isThinking={isThinking}
                onReady={(controls) => {
                  controlsRef.current = controls;
                  controls.setLipSyncTuning(tuning);
                }}
                onStateChange={setAvatarState}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
              <span className="rounded-md bg-slate-800 px-2 py-1">eye: {avatarState.eye}</span>
              <span className="rounded-md bg-slate-800 px-2 py-1">mouth: {avatarState.mouth}</span>
              <span className="rounded-md bg-slate-800 px-2 py-1">expression: {avatarState.expression}</span>
              <span className="rounded-md bg-slate-800 px-2 py-1">speaking: {avatarState.speaking ? "yes" : "no"}</span>
            </div>

            <SphereWaveVisualizer
              speaking={avatarState.speaking}
              amplitude={avatarState.metrics.amplitude}
              rms={avatarState.metrics.rms}
              openness={avatarState.metrics.openness}
              onsetBoost={avatarState.metrics.onsetBoost}
              lowBandRatio={avatarState.metrics.lowBandRatio}
              midBandRatio={avatarState.metrics.midBandRatio}
              highBandRatio={avatarState.metrics.highBandRatio}
            />
          </section>

          <aside className="overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/70">
            <div className="space-y-5 p-4 md:p-5">
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Audio Playback</p>
                <label className="block cursor-pointer rounded-lg border border-dashed border-slate-700 p-3 text-center hover:border-emerald-400">
                  <div className="space-y-1">
                    <p className="text-sm text-slate-300">{fileName || "Select MP3 / WAV file"}</p>
                    <p className="text-xs text-slate-500">Your base case for sync testing</p>
                  </div>
                  <input type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={playUploadedFile}
                    disabled={!canPlayAudio}
                    className="col-span-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    Play File
                  </button>
                  <button
                    onClick={stopPlayback}
                    disabled={!isBusy}
                    className="rounded-lg bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    Stop
                  </button>
                </div>
                <button
                  onClick={playSynthetic}
                  disabled={isBusy}
                  className="w-full rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-600 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                >
                  Play Synthetic Speech Pattern
                </button>
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Future LLM Voice Route</p>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void playLiveTts();
                  }}
                >
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="sr-only"
                    value="sahaara-avatar-user"
                    readOnly
                  />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Sarvam API key"
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  />
                  <textarea
                    rows={3}
                    value={ttsText}
                    onChange={(event) => setTtsText(event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={isBusy}
                    className="w-full rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    Fetch TTS and Play
                  </button>
                </form>
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Manual Overrides</p>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={manualMode}
                      onChange={(event) => toggleManualMode(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-emerald-500"
                    />
                    lock manual
                  </label>
                </div>

                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">mouth</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MOUTH_STATES.map((state) => (
                      <button
                        key={state}
                        onClick={() => setManualOverrides({ mouth: state }, { enableManual: true })}
                        className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                      >
                        {state}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">eye</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {EYE_STATES.map((state) => (
                      <button
                        key={state}
                        onClick={() => setManualOverrides({ eye: state }, { enableManual: true })}
                        className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                      >
                        {state}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">expression</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {EXPRESSIONS.map((state) => (
                      <button
                        key={state}
                        onClick={() => {
                          if (state === "thinking") {
                            setIsThinking(true);
                            setTimeout(() => setIsThinking(false), 1200);
                          }
                          setManualOverrides({ expression: state }, { enableManual: true });
                        }}
                        className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                      >
                        {state}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Live Audio Metrics</p>
                <MetricRow
                  label="Calibration"
                  value={`${avatarState.metrics.calibrated ? "done" : "running"} ${Math.round(
                    avatarState.metrics.calibrationProgress * 100
                  )}%`}
                />
                <MetricRow label="RMS" value={avatarState.metrics.rms.toFixed(4)} />
                <MetricRow label="Amplitude" value={avatarState.metrics.amplitude.toFixed(4)} />
                <MetricRow label="Openness" value={avatarState.metrics.openness.toFixed(4)} />
                <MetricRow label="Onset boost" value={avatarState.metrics.onsetBoost.toFixed(4)} />
                <MetricRow label="Dominant Hz" value={avatarState.metrics.dominantHz.toFixed(1)} />
                <MetricRow label="Low-band ratio" value={avatarState.metrics.lowBandRatio.toFixed(4)} />
                <MetricRow label="Mid-band ratio" value={avatarState.metrics.midBandRatio.toFixed(4)} />
                <MetricRow label="High-band ratio" value={avatarState.metrics.highBandRatio.toFixed(4)} />
                <MetricRow label="Zero-crossing" value={avatarState.metrics.zcr.toFixed(4)} />
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Lip Sync Tuning</p>

                <RangeRow
                  label="Look-ahead"
                  value={`${Math.round(tuning.lookAheadMs)} ms`}
                  min={0}
                  max={220}
                  step={2}
                  current={tuning.lookAheadMs}
                  onChange={(value) => updateTuning({ lookAheadMs: value })}
                />

                <RangeRow
                  label="Sync offset"
                  value={`${Math.round(tuning.syncOffsetMs)} ms`}
                  min={-120}
                  max={120}
                  step={1}
                  current={tuning.syncOffsetMs}
                  onChange={(value) => updateTuning({ syncOffsetMs: value })}
                />

                <RangeRow
                  label="Min hold"
                  value={`${Math.round(tuning.minStateHoldMs)} ms`}
                  min={35}
                  max={200}
                  step={1}
                  current={tuning.minStateHoldMs}
                  onChange={(value) => updateTuning({ minStateHoldMs: value })}
                />

                <RangeRow
                  label="Stable frames"
                  value={`${Math.round(tuning.stableFrames)}`}
                  min={1}
                  max={6}
                  step={1}
                  current={tuning.stableFrames}
                  onChange={(value) => updateTuning({ stableFrames: Math.round(value) })}
                />

                <RangeRow
                  label="Smoothing"
                  value={tuning.smoothing.toFixed(2)}
                  min={0.55}
                  max={0.92}
                  step={0.01}
                  current={tuning.smoothing}
                  onChange={(value) => updateTuning({ smoothing: value })}
                />
              </section>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

async function requestSarvamTtsAudio({
  apiKey,
  text,
}: {
  apiKey: string;
  text: string;
}) {
  const endpoint = "https://api.sarvam.ai/text-to-speech";

  const attempts: Array<Record<string, unknown>> = [
    {
      inputs: [text],
      target_language_code: "hi-IN",
      speaker: "Ritu",
      model: "bulbul:v3",
      enable_preprocessing: true,
      pace: 1.00,
    },
    {
      input: text,
      target_language_code: "hi-IN",
      speaker: "Ritu",
      model: "bulbul:v3",
      enable_preprocessing: true,
      pace: 1.00,
    },
    {
      text,
      target_language_code: "hi-IN",
      voice: "Ritu",
      model: "bulbul:v3",
      enable_preprocessing: true,
      pace: 1.00,
    },
  ];

  let lastError = "";

  for (let index = 0; index < attempts.length; index += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey,
      },
      body: JSON.stringify(attempts[index]),
    });

    if (response.ok) {
      return (await response.json()) as { audios?: string[] };
    }

    const details = await extractResponseError(response);
    lastError = details
      ? `Sarvam API ${response.status}: ${details}`
      : `Sarvam API ${response.status}`;

    // For auth and quota problems, don't retry with alternative payload schemas.
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      break;
    }
  }

  throw new Error(lastError || "Sarvam API request failed.");
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

    const candidate =
      json?.message ??
      json?.error ??
      json?.detail ??
      json?.details ??
      "";

    if (typeof candidate === "string") {
      return candidate.trim();
    }

    if (candidate == null) {
      return "";
    }

    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return String(candidate);
    }

    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  return (await response.text().catch(() => "")).trim();
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-slate-800 px-2 py-1.5 text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-100">{value}</span>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="uppercase tracking-wide text-slate-400">{label}</span>
        <span className="font-mono text-slate-200">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-700"
      />
    </div>
  );
}

function SphereWaveVisualizer({
  speaking,
  amplitude,
  rms,
  openness,
  onsetBoost,
  lowBandRatio,
  midBandRatio,
  highBandRatio,
}: {
  speaking: boolean;
  amplitude: number;
  rms: number;
  openness: number;
  onsetBoost: number;
  lowBandRatio: number;
  midBandRatio: number;
  highBandRatio: number;
}) {
  const energy = clamp01(openness * 0.52 + amplitude * 2.4 + rms * 1.4 + onsetBoost * 0.32);
  const hue = Math.round(180 + highBandRatio * 70 - lowBandRatio * 25);
  const sphereScale = 1 + energy * 0.5;
  const coreOpacity = 0.22 + energy * 0.58;
  const haloOpacity = speaking ? 0.3 + energy * 0.45 : 0.12;

  const wavePoints = useMemo(() => {
    const width = 960;
    const height = 130;
    const baseline = height / 2;
    const segmentCount = 64;

    const ampA = 8 + energy * 34;
    const ampB = 5 + midBandRatio * 26;
    const ampC = 4 + highBandRatio * 20;
    const phase = openness * 5.5 + onsetBoost * 4.2;

    const top: string[] = [];
    const bottom: string[] = [];

    for (let i = 0; i <= segmentCount; i += 1) {
      const t = i / segmentCount;
      const x = t * width;

      const yOffset =
        Math.sin(t * Math.PI * 4 + phase) * ampA +
        Math.sin(t * Math.PI * 8 - phase * 0.7) * ampB +
        Math.sin(t * Math.PI * 13 + phase * 0.33) * ampC;

      const yTop = baseline - yOffset;
      const yBottom = baseline + yOffset;
      top.push(`${x.toFixed(1)},${yTop.toFixed(1)}`);
      bottom.push(`${x.toFixed(1)},${yBottom.toFixed(1)}`);
    }

    return {
      topLine: top.join(" "),
      area: `${top.join(" ")} ${bottom.reverse().join(" ")}`,
    };
  }, [energy, highBandRatio, midBandRatio, openness, onsetBoost]);

  return (
    <section className="mt-5 rounded-xl border border-slate-800 bg-slate-900/80 p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-slate-400">Audio Visualizer</p>
        <span className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
          {speaking ? "reacting" : "idle"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-[170px_1fr]">
        <div className="relative flex h-[170px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950/70">
          <div
            className="absolute h-28 w-28 rounded-full blur-xl transition-all duration-150"
            style={{
              background: `radial-gradient(circle at 35% 35%, hsla(${hue}, 85%, 62%, 0.75), hsla(${hue}, 85%, 35%, 0.15))`,
              transform: `scale(${1 + energy * 0.7})`,
              opacity: haloOpacity,
            }}
          />

          <div
            className="relative h-20 w-20 rounded-full border border-slate-700/70 transition-all duration-100"
            style={{
              transform: `scale(${sphereScale})`,
              background: `radial-gradient(circle at 30% 30%, hsla(${hue}, 95%, 70%, 0.95), hsla(${hue}, 92%, 46%, 0.55) 52%, hsla(${hue}, 92%, 28%, 0.42))`,
              boxShadow: `0 0 ${20 + energy * 30}px hsla(${hue}, 95%, 62%, ${coreOpacity})`,
            }}
          />
        </div>

        <div className="relative overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
          <svg viewBox="0 0 960 130" preserveAspectRatio="none" className="h-[170px] w-full">
            <defs>
              <linearGradient id="wave-fill" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor={`hsla(${hue - 20}, 85%, 48%, 0.20)`} />
                <stop offset="55%" stopColor={`hsla(${hue}, 88%, 55%, 0.42)`} />
                <stop offset="100%" stopColor={`hsla(${hue + 18}, 92%, 60%, 0.22)`} />
              </linearGradient>
              <linearGradient id="wave-line" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor={`hsla(${hue - 25}, 90%, 62%, 0.65)`} />
                <stop offset="60%" stopColor={`hsla(${hue + 4}, 95%, 70%, 0.96)`} />
                <stop offset="100%" stopColor={`hsla(${hue + 20}, 90%, 62%, 0.65)`} />
              </linearGradient>
            </defs>

            <polygon points={wavePoints.area} fill="url(#wave-fill)" />
            <polyline
              points={wavePoints.topLine}
              fill="none"
              stroke="url(#wave-line)"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-slate-950/55 to-transparent" />
        </div>
      </div>
    </section>
  );
}

function clamp01(value: number) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function generateSpeechTone(): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const context = new OfflineAudioContext(1, 44100 * 4, 44100);
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.frequency.value = 180;
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    const envelope: Array<[number, number]> = [
      [0, 0],
      [0.06, 0.85],
      [0.28, 0.25],
      [0.4, 0.92],
      [0.62, 0.3],
      [0.78, 0.7],
      [1.05, 0.18],
      [1.24, 0.8],
      [1.55, 0.32],
      [1.82, 0.95],
      [2.16, 0.24],
      [2.33, 0.65],
      [2.64, 0.35],
      [2.92, 0.86],
      [3.2, 0.18],
      [3.85, 0],
    ];

    envelope.forEach(([time, level]) => {
      gainNode.gain.linearRampToValueAtTime(level, time);
    });

    oscillator.start(0);
    oscillator.stop(4);

    context.startRendering().then((buffer) => {
      resolve(audioBufferToWav(buffer));
    });
  });
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const samples = buffer.getChannelData(0);
  const dataSize = samples.length * 2;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }

  return wav;
}
