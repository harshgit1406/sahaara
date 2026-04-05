import { useRef, useCallback } from "react";

export type MouthState =
  | "neutral"
  | "a_e_i"
  | "b_m_p"
  | "c_d_n_s_t_x_y_z"
  | "g_k"
  | "l"
  | "o"
  | "j_ch_sh"
  | "u"
  | "f_v"
  | "ee"
  | "q_w"
  | "th";

export interface LipSyncMetrics {
  speaking: boolean;
  openness: number;
  onsetBoost: number;
  rms: number;
  amplitude: number;
  dominantHz: number;
  highBandRatio: number;
  lowBandRatio: number;
  midBandRatio: number;
  zcr: number;
  calibrationProgress: number;
  calibrated: boolean;
  mouth: MouthState;
}

export interface LipSyncTuning {
  lookAheadMs: number;
  syncOffsetMs: number;
  minStateHoldMs: number;
  stableFrames: number;
  smoothing: number;
}

interface UseLipSyncOptions {
  onMetrics?: (metrics: LipSyncMetrics) => void;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
}

type AnalysisBuffer = Uint8Array<ArrayBuffer>;

interface AudioFeatures {
  rms: number;
  zcr: number;
  lowBandRatio: number;
  midBandRatio: number;
  highBandRatio: number;
  dominantHz: number;
  amplitude: number;
}

interface Thresholds {
  rmsSilence: number;
  ampSilence: number;
  ampLight: number;
  ampMedium: number;
  ampStrong: number;
}

interface MouthCue {
  timeSec: number;
  mouth: MouthState;
}

const CALIBRATION_MS = 1200;
const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const BASE_MIN_CHUNK_MS = 122;
const BLIP_MIN_CHUNK_MS = 96;

const DEFAULT_TUNING: LipSyncTuning = {
  lookAheadMs: 92,
  syncOffsetMs: 0,
  minStateHoldMs: 48,
  stableFrames: 2,
  smoothing: 0.72,
};

const DEFAULT_THRESHOLDS: Thresholds = {
  rmsSilence: 0.02,
  ampSilence: 0.08,
  ampLight: 0.16,
  ampMedium: 0.25,
  ampStrong: 0.37,
};

const MIN_SEGMENT_MS: Record<MouthState, number> = {
  neutral: 128,
  a_e_i: 116,
  b_m_p: 102,
  c_d_n_s_t_x_y_z: 108,
  g_k: 104,
  l: 108,
  o: 114,
  j_ch_sh: 102,
  u: 116,
  f_v: 98,
  ee: 112,
  q_w: 112,
  th: 100,
};

const O_PATTERNS = /[आओऔोौ]|\bo\b|\bu\b|oo|oh|ou/gi;
const FV_PATTERNS = /[फव]|\bf\b|\bv\b|ph|bh/gi;

export function useLipSync(
  onMouthChange: (state: MouthState) => void,
  options?: UseLipSyncOptions
) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number>(0);

  const freqDataRef = useRef<AnalysisBuffer | null>(null);
  const timeDataRef = useRef<AnalysisBuffer | null>(null);

  const tuningRef = useRef<LipSyncTuning>(DEFAULT_TUNING);
  const thresholdsRef = useRef<Thresholds>(DEFAULT_THRESHOLDS);

  const smoothedAmpRef = useRef<number>(0);
  const smoothedRmsRef = useRef<number>(0);
  const smoothedZcrRef = useRef<number>(0);
  const opennessRef = useRef<number>(0);
  const onsetBoostRef = useRef<number>(0);
  const previousAmpRef = useRef<number>(0);

  const calibrationRef = useRef({ done: false, progress: 0 });

  const timelineRef = useRef<MouthCue[]>([]);
  const cueIndexRef = useRef<number>(0);
  const playbackStartCtxSecRef = useRef<number>(0);
  const playbackResolveRef = useRef<(() => void) | null>(null);

  const lastCommittedRef = useRef<MouthState>("neutral");
  const pendingTimelineMouthRef = useRef<MouthState>("neutral");
  const pendingTimelineCountRef = useRef<number>(0);
  const lastTimelineCommitAtRef = useRef<number>(0);

  const getLiveFeatures = useCallback((): AudioFeatures => {
    if (!analyserRef.current || !freqDataRef.current || !timeDataRef.current) {
      return {
        rms: 0,
        zcr: 0,
        lowBandRatio: 0,
        midBandRatio: 0,
        highBandRatio: 0,
        dominantHz: 0,
        amplitude: 0,
      };
    }

    const analyser = analyserRef.current;
    const freqData = freqDataRef.current;
    const timeData = timeDataRef.current;

    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    let sumSquares = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const normalized = (timeData[i] - 128) / 128;
      sumSquares += normalized * normalized;

      if (i > 0) {
        const prev = timeData[i - 1] - 128;
        const curr = timeData[i] - 128;
        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
          zeroCrossings += 1;
        }
      }
    }

    const rms = Math.sqrt(sumSquares / timeData.length);
    const zcr = zeroCrossings / timeData.length;

    let total = 0;
    let lowBand = 0;
    let midBand = 0;
    let highBand = 0;
    let maxBin = 0;
    let maxValue = -1;

    const binHz = analyser.context.sampleRate / analyser.fftSize;

    for (let i = 0; i < freqData.length; i += 1) {
      const value = freqData[i] / 255;
      total += value;

      if (value > maxValue) {
        maxValue = value;
        maxBin = i;
      }

      const hz = i * binHz;
      if (hz <= 320) lowBand += value;
      if (hz >= 900 && hz <= 3000) midBand += value;
      if (hz > 3000) highBand += value;
    }

    const amplitude = total / Math.max(freqData.length, 1);

    const smoothing = clamp(tuningRef.current.smoothing, 0.55, 0.94);
    smoothedAmpRef.current = smoothedAmpRef.current * smoothing + amplitude * (1 - smoothing);
    smoothedRmsRef.current = smoothedRmsRef.current * 0.72 + rms * 0.28;
    smoothedZcrRef.current = smoothedZcrRef.current * 0.76 + zcr * 0.24;

    return {
      rms: smoothedRmsRef.current,
      zcr: smoothedZcrRef.current,
      lowBandRatio: total > 0 ? lowBand / total : 0,
      midBandRatio: total > 0 ? midBand / total : 0,
      highBandRatio: total > 0 ? highBand / total : 0,
      dominantHz: maxBin * binHz,
      amplitude: smoothedAmpRef.current,
    };
  }, []);

  const inferVisemeChunk = useCallback(
    (features: AudioFeatures, previous: MouthState, onsetBoost: number): MouthState => {
      const th = thresholdsRef.current;

      const amplitudeRange = Math.max(0.001, th.ampStrong - th.ampSilence);
      const boostedAmplitude = features.amplitude + onsetBoost * amplitudeRange * 0.28;

      const speaking =
        features.rms > th.rmsSilence * 0.8 ||
        boostedAmplitude > th.ampSilence * 0.78 ||
        onsetBoost > 0.12;
      if (!speaking) return "neutral";

      // Soft/plosive phases (b/m/p-like closures) keep closure shapes stable.
      const closureLike =
        features.zcr < 0.042 &&
        boostedAmplitude < th.ampLight * 0.9 &&
        features.highBandRatio < 0.22;

      // Hysteresis: while speech is still active, ignore tiny closure dips that would bounce to neutral/closed.
      if (
        closureLike &&
        previous !== "neutral" &&
        previous !== "b_m_p" &&
        (boostedAmplitude > th.ampSilence * 0.92 || onsetBoost > 0.08)
      ) {
        return previous;
      }

      if (closureLike) {
        return "b_m_p";
      }

      if (features.highBandRatio > 0.31 && features.zcr > 0.1) {
        return features.zcr > 0.13 ? "th" : "f_v";
      }

      if (features.highBandRatio > 0.27 && features.midBandRatio > 0.24) {
        return "j_ch_sh";
      }

      if (features.lowBandRatio > 0.25 && features.highBandRatio < 0.26) {
        if (features.dominantHz < 500) return "u";
        if (features.dominantHz < 740) return "o";
        return "q_w";
      }

      if (features.midBandRatio > 0.27 && features.zcr > 0.085) {
        return "c_d_n_s_t_x_y_z";
      }

      if (
        features.lowBandRatio > 0.2 &&
        features.midBandRatio > 0.22 &&
        boostedAmplitude >= th.ampLight * 0.96
      ) {
        return "g_k";
      }

      if (boostedAmplitude > th.ampMedium * 1.06 && features.dominantHz > 1200) {
        return "ee";
      }

      if (boostedAmplitude > th.ampLight * 1.12 && features.midBandRatio > 0.21) {
        return "l";
      }

      if (boostedAmplitude >= th.ampLight * 0.92) {
        return "a_e_i";
      }

      return previous === "neutral" ? "a_e_i" : previous;
    },
    []
  );

  const buildTimeline = useCallback(
    (buffer: AudioBuffer): MouthCue[] => {
      const channel = buffer.getChannelData(0);
      const sampleRate = buffer.sampleRate;

      const frameCount = Math.max(1, Math.floor((channel.length - FRAME_SIZE) / HOP_SIZE));
      const frameDurationSec = HOP_SIZE / sampleRate;

      const features: AudioFeatures[] = [];
      let rmsSum = 0;
      let ampSum = 0;
      let ampPeak = 0;
      let calibrationFrames = 0;
      const calibrationFrameLimit = Math.max(1, Math.floor((CALIBRATION_MS / 1000) / frameDurationSec));

      for (let frame = 0; frame < frameCount; frame += 1) {
        const start = frame * HOP_SIZE;
        const end = Math.min(start + FRAME_SIZE, channel.length);
        const frameFeatures = computeOfflineFeatures(channel, start, end, sampleRate);
        features.push(frameFeatures);

        if (frame < calibrationFrameLimit) {
          calibrationFrames += 1;
          rmsSum += frameFeatures.rms;
          ampSum += frameFeatures.amplitude;
          ampPeak = Math.max(ampPeak, frameFeatures.amplitude);
        }
      }

      const avgRms = rmsSum / Math.max(calibrationFrames, 1);
      const avgAmp = ampSum / Math.max(calibrationFrames, 1);

      const calibrated: Thresholds = {
        rmsSilence: clamp(avgRms * 1.24, 0.009, 0.065),
        ampSilence: clamp(avgAmp * 0.86, 0.04, 0.22),
        ampLight: clamp(Math.max(avgAmp * 1.06, ampPeak * 0.2), 0.09, 0.34),
        ampMedium: clamp(Math.max(avgAmp * 1.48, ampPeak * 0.38), 0.14, 0.56),
        ampStrong: clamp(Math.max(avgAmp * 2.1, ampPeak * 0.57), 0.23, 0.8),
      };

      calibrated.ampMedium = Math.max(calibrated.ampMedium, calibrated.ampLight + 0.02);
      calibrated.ampStrong = Math.max(calibrated.ampStrong, calibrated.ampMedium + 0.04);
      thresholdsRef.current = calibrated;

      calibrationRef.current = { done: true, progress: 1 };

      const rawCues: MouthCue[] = [];
      let previous: MouthState = "neutral";
      let previousAmp = 0;
      let onsetBoost = 0;

      for (let frame = 0; frame < features.length; frame += 1) {
        const feature = features[frame];

        const amplitudeDelta = feature.amplitude - previousAmp;
        previousAmp = feature.amplitude;
        onsetBoost = Math.max(0, onsetBoost * 0.82 - 0.02);
        if (amplitudeDelta > calibrated.ampLight * 0.2) {
          onsetBoost = Math.min(1, onsetBoost + amplitudeDelta / Math.max(calibrated.ampStrong, 0.001));
        }

        const mouth = inferVisemeChunk(feature, previous, onsetBoost);
        const timeSec = frame * frameDurationSec;

        if (rawCues.length === 0 || rawCues[rawCues.length - 1].mouth !== mouth) {
          rawCues.push({ timeSec, mouth });
        }

        previous = mouth;
      }

      const compact: MouthCue[] = [];
      for (let i = 0; i < rawCues.length; i += 1) {
        const cue = rawCues[i];
        const nextCue = rawCues[i + 1];

        if (compact.length === 0) {
          compact.push(cue);
          continue;
        }

        const last = compact[compact.length - 1];
        const segmentMs = ((nextCue ? nextCue.timeSec : buffer.duration) - last.timeSec) * 1000;
        const minAllowed = Math.max(
          BASE_MIN_CHUNK_MS,
          MIN_SEGMENT_MS[last.mouth],
          tuningRef.current.minStateHoldMs * 0.95
        );

        if (segmentMs < minAllowed) {
          continue;
        }

        compact.push(cue);
      }

      const smoothed = smoothTimelineChunks(compact, buffer.duration, BLIP_MIN_CHUNK_MS);

      if (smoothed.length === 0 || smoothed[0].timeSec > 0) {
        smoothed.unshift({ timeSec: 0, mouth: "neutral" });
      }

      return smoothed;
    },
    [inferVisemeChunk]
  );

  const setMouthImmediate = useCallback(
    (state: MouthState) => {
      if (state === lastCommittedRef.current) return;
      lastCommittedRef.current = state;
      onMouthChange(state);
    },
    [onMouthChange]
  );

  const commitTimelineMouth = useCallback(
    (state: MouthState) => {
      if (state === lastCommittedRef.current) {
        pendingTimelineMouthRef.current = state;
        pendingTimelineCountRef.current = 0;
        return;
      }

      const now = performance.now();
      const minHoldMs = tuningRef.current.minStateHoldMs;

      // Keep the current mouth visible for at least min hold time and ignore fast in-between flips.
      if (now - lastTimelineCommitAtRef.current < minHoldMs) {
        pendingTimelineMouthRef.current = state;
        pendingTimelineCountRef.current = 0;
        return;
      }

      if (pendingTimelineMouthRef.current !== state) {
        pendingTimelineMouthRef.current = state;
        pendingTimelineCountRef.current = 1;
        return;
      }

      pendingTimelineCountRef.current += 1;
      const baseStable = Math.max(1, Math.round(tuningRef.current.stableFrames));
      const needsFrames = state === "neutral"
        ? baseStable + 1
        : isFastArticulation(state)
          ? Math.max(1, baseStable - 1)
          : baseStable;
      if (pendingTimelineCountRef.current < needsFrames) return;

      // Additional tiny guard to prevent same-frame or near-same-frame double commits.
      const minGap = state === "neutral" ? 52 : isFastArticulation(state) ? 22 : 30;
      if (now - lastTimelineCommitAtRef.current < minGap) return;

      lastTimelineCommitAtRef.current = now;
      setMouthImmediate(state);
    },
    [setMouthImmediate]
  );

  const startLoop = useCallback(() => {
    const tick = () => {
      const features = getLiveFeatures();

      const amplitudeDelta = features.amplitude - previousAmpRef.current;
      previousAmpRef.current = features.amplitude;

      onsetBoostRef.current = Math.max(0, onsetBoostRef.current * 0.8 - 0.02);
      const onsetThreshold = Math.max(0.006, thresholdsRef.current.ampLight * 0.18);
      if (amplitudeDelta > onsetThreshold) {
        onsetBoostRef.current = Math.min(
          1,
          onsetBoostRef.current + amplitudeDelta / Math.max(thresholdsRef.current.ampStrong, 0.001)
        );
      }

      const openness = deriveOpenness(
        features.amplitude,
        thresholdsRef.current,
        opennessRef.current,
        onsetBoostRef.current
      );
      opennessRef.current = openness;

      let mouth = inferVisemeChunk(features, lastCommittedRef.current, onsetBoostRef.current);
      const timeline = timelineRef.current;
      const ctx = audioCtxRef.current;

      if (timeline.length > 0 && ctx && playbackStartCtxSecRef.current > 0) {
        const nowSec = ctx.currentTime - playbackStartCtxSecRef.current;
        const totalLeadMs = tuningRef.current.lookAheadMs + tuningRef.current.syncOffsetMs;
        const targetSec = Math.max(0, nowSec + totalLeadMs / 1000);

        while (
          cueIndexRef.current + 1 < timeline.length &&
          timeline[cueIndexRef.current + 1].timeSec <= targetSec
        ) {
          cueIndexRef.current += 1;
        }

        mouth = timeline[cueIndexRef.current]?.mouth ?? mouth;
      }

      commitTimelineMouth(mouth);

      const speaking = features.rms > thresholdsRef.current.rmsSilence || features.amplitude > thresholdsRef.current.ampSilence;

      options?.onMetrics?.({
        speaking,
        openness,
        onsetBoost: onsetBoostRef.current,
        rms: features.rms,
        amplitude: features.amplitude,
        dominantHz: features.dominantHz,
        highBandRatio: features.highBandRatio,
        lowBandRatio: features.lowBandRatio,
        midBandRatio: features.midBandRatio,
        zcr: features.zcr,
        calibrationProgress: calibrationRef.current.progress,
        calibrated: calibrationRef.current.done,
        mouth,
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [commitTimelineMouth, getLiveFeatures, inferVisemeChunk, options]);

  const emitNeutral = useCallback(() => {
    options?.onMetrics?.({
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
      calibrationProgress: calibrationRef.current.done ? 1 : calibrationRef.current.progress,
      calibrated: calibrationRef.current.done,
      mouth: "neutral",
    });
  }, [options]);

  const playAudio = useCallback(
    async (audioData: ArrayBuffer) => {
      const ctx = audioCtxRef.current ?? new AudioContext({ latencyHint: "interactive" });
      audioCtxRef.current = ctx;

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      if (sourceRef.current) {
        sourceRef.current.stop();
        sourceRef.current.disconnect();
      }

      if (playbackResolveRef.current) {
        playbackResolveRef.current();
        playbackResolveRef.current = null;
      }

      cancelAnimationFrame(rafRef.current);
      options?.onPlaybackStateChange?.(false);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FRAME_SIZE;
      analyser.smoothingTimeConstant = 0.48;
      analyserRef.current = analyser;

      freqDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      timeDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));

      smoothedAmpRef.current = 0;
      smoothedRmsRef.current = 0;
      smoothedZcrRef.current = 0;
      opennessRef.current = 0;
      onsetBoostRef.current = 0;
      previousAmpRef.current = 0;

      lastCommittedRef.current = "neutral";
      pendingTimelineMouthRef.current = "neutral";
      pendingTimelineCountRef.current = 0;
      lastTimelineCommitAtRef.current = performance.now();
      calibrationRef.current = { done: false, progress: 0 };

      const buffer = await ctx.decodeAudioData(audioData);
      timelineRef.current = buildTimeline(buffer);
      cueIndexRef.current = 0;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      sourceRef.current = source;

      // Prime the first cue before audio starts to reduce perceived lip lag.
      setMouthImmediate(timelineRef.current[0]?.mouth ?? "neutral");

      options?.onPlaybackStateChange?.(true);
      source.start();
      playbackStartCtxSecRef.current = ctx.currentTime;
      startLoop();

      await new Promise<void>((resolve) => {
        playbackResolveRef.current = resolve;

        source.onended = () => {
          sourceRef.current = null;
          cancelAnimationFrame(rafRef.current);
          options?.onPlaybackStateChange?.(false);
          timelineRef.current = [];
          cueIndexRef.current = 0;
          playbackStartCtxSecRef.current = 0;
          emitNeutral();
          setMouthImmediate("neutral");
          playbackResolveRef.current = null;
          resolve();
        };
      });
    },
    [buildTimeline, emitNeutral, options, setMouthImmediate, startLoop]
  );

  const stop = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.stop();
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    cancelAnimationFrame(rafRef.current);
    timelineRef.current = [];
    cueIndexRef.current = 0;
    playbackStartCtxSecRef.current = 0;
    options?.onPlaybackStateChange?.(false);
    emitNeutral();
    setMouthImmediate("neutral");
    if (playbackResolveRef.current) {
      playbackResolveRef.current();
      playbackResolveRef.current = null;
    }
  }, [emitNeutral, options, setMouthImmediate]);

  const detectPhoneme = useCallback((text: string): MouthState | null => {
    O_PATTERNS.lastIndex = 0;
    FV_PATTERNS.lastIndex = 0;
    if (/[bmp]/i.test(text)) return "b_m_p";
    if (FV_PATTERNS.test(text)) return "f_v";
    if (/[jcs]/i.test(text)) return "j_ch_sh";
    if (O_PATTERNS.test(text)) return "o";
    return null;
  }, []);

  const setTuning = useCallback((partial: Partial<LipSyncTuning>) => {
    tuningRef.current = {
      lookAheadMs: clamp(partial.lookAheadMs ?? tuningRef.current.lookAheadMs, 0, 240),
      syncOffsetMs: clamp(partial.syncOffsetMs ?? tuningRef.current.syncOffsetMs, -120, 120),
      minStateHoldMs: clamp(partial.minStateHoldMs ?? tuningRef.current.minStateHoldMs, 35, 220),
      stableFrames: Math.round(clamp(partial.stableFrames ?? tuningRef.current.stableFrames, 1, 6)),
      smoothing: clamp(partial.smoothing ?? tuningRef.current.smoothing, 0.55, 0.94),
    };
  }, []);

  return { playAudio, stop, detectPhoneme, setTuning };
}

function computeOfflineFeatures(
  samples: Float32Array,
  start: number,
  end: number,
  sampleRate: number
): AudioFeatures {
  let sumSquares = 0;
  let zeroCrossings = 0;
  let amplitudeAccumulator = 0;

  for (let i = start; i < end; i += 1) {
    const sample = samples[i] ?? 0;
    sumSquares += sample * sample;
    amplitudeAccumulator += Math.abs(sample);

    if (i > start) {
      const prev = samples[i - 1] ?? 0;
      if ((prev >= 0 && sample < 0) || (prev < 0 && sample >= 0)) {
        zeroCrossings += 1;
      }
    }
  }

  const count = Math.max(1, end - start);
  const rms = Math.sqrt(sumSquares / count);
  const zcr = zeroCrossings / count;

  let lowBand = 0;
  let midBand = 0;
  let highBand = 0;
  let total = 0;

  const roughBinCount = 24;
  for (let b = 1; b <= roughBinCount; b += 1) {
    const freq = (b / roughBinCount) * 4000;
    let re = 0;
    let im = 0;

    for (let n = 0; n < count; n += 1) {
      const sample = samples[start + n] ?? 0;
      const angle = (2 * Math.PI * freq * n) / sampleRate;
      re += sample * Math.cos(angle);
      im -= sample * Math.sin(angle);
    }

    const mag = Math.sqrt(re * re + im * im);
    total += mag;

    if (freq <= 320) lowBand += mag;
    if (freq >= 900 && freq <= 3000) midBand += mag;
    if (freq > 3000) highBand += mag;
  }

  const dominantHz = zcr > 0 ? Math.min(2400, (sampleRate * zcr) / 2) : 0;

  return {
    rms,
    zcr,
    lowBandRatio: total > 0 ? lowBand / total : 0,
    midBandRatio: total > 0 ? midBand / total : 0,
    highBandRatio: total > 0 ? highBand / total : 0,
    dominantHz,
    amplitude: amplitudeAccumulator / count,
  };
}

function deriveOpenness(
  amplitude: number,
  thresholds: Thresholds,
  previous: number,
  onsetBoost: number
) {
  const range = Math.max(0.001, thresholds.ampStrong - thresholds.ampSilence);
  const raw = clamp((amplitude - thresholds.ampSilence) / range, 0, 1);
  const boosted = clamp(raw + onsetBoost * 0.2, 0, 1);

  const attack = 0.44;
  const release = 0.2;
  const next = boosted > previous
    ? previous + (boosted - previous) * attack
    : previous + (boosted - previous) * release;

  return clamp(next, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function smoothTimelineChunks(
  cues: MouthCue[],
  totalDurationSec: number,
  minChunkMs: number
): MouthCue[] {
  if (cues.length < 3) return cues;

  const minChunkSec = minChunkMs / 1000;
  const result: MouthCue[] = [cues[0]];

  for (let i = 1; i < cues.length - 1; i += 1) {
    const previous = result[result.length - 1];
    const current = cues[i];
    const next = cues[i + 1];
    const currentDuration = next.timeSec - current.timeSec;

    // Remove short A-B-A blips that create visual chatter.
    if (currentDuration < minChunkSec && previous.mouth === next.mouth) {
      continue;
    }

    // Drop very short non-plosive fragments that usually come from noisy frame flips.
    if (currentDuration < minChunkSec * 0.62 && mouthFamily(current.mouth) !== "plosive") {
      continue;
    }

    result.push(current);
  }

  const lastCue = cues[cues.length - 1];
  const lastInResult = result[result.length - 1];
  const tailDuration = totalDurationSec - lastInResult.timeSec;

  if (lastCue.mouth !== lastInResult.mouth && tailDuration > minChunkSec * 0.65) {
    result.push(lastCue);
  }

  return result;
}

function mouthFamily(mouth: MouthState): "vowel" | "fricative" | "plosive" | "other" {
  if (mouth === "a_e_i" || mouth === "ee" || mouth === "o" || mouth === "u" || mouth === "q_w") {
    return "vowel";
  }
  if (mouth === "f_v" || mouth === "th" || mouth === "j_ch_sh" || mouth === "c_d_n_s_t_x_y_z") {
    return "fricative";
  }
  if (mouth === "b_m_p" || mouth === "g_k") {
    return "plosive";
  }
  return "other";
}

function isFastArticulation(mouth: MouthState): boolean {
  const family = mouthFamily(mouth);
  return family === "plosive" || family === "fricative";
}
