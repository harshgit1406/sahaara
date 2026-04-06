import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "./components/Avatar/avatar.css";
import { Avatar } from "./components/Avatar";
import type { AvatarControls } from "./components/Avatar";
import { DEFAULT_GREETING_MESSAGE, DEFAULT_SESSION_INSTRUCTIONS } from "./config/assistantInstructions";
import {
  composeOrderConfirmationMessageSarvam,
  inferConfirmationDecisionSarvam,
  inferSahaaraIntentSarvam,
  isSarvamConfigured,
  llmReplyMock,
  llmReplySarvam,
  sttSarvam,
  ttsSarvam,
  type SahaaraIntentPlan,
} from "./services/sarvamClient";
import {
  confirmPreparedOrder,
  getSahaaraHealth,
  getWatchLatest,
  getWatchUserId,
  prepareDoctorAppointment,
  prepareGroceryOrder,
  preparePharmacyOrder,
  type PreparedAssistantOrder,
} from "./services/sahaaraApiClient";

type ChatRole = "user" | "assistant";
type InputMode = "voice" | "chat";
type AssistantLanguageMode = "mix" | "english";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  mode: InputMode;
}

interface WatchPanelSnapshot {
  heartRate?: number;
  spo2?: number;
  skinTemp?: number;
  freefallStatus?: string;
}

interface ActionReply {
  reply: string;
  pendingOrder?: PreparedAssistantOrder;
}

const STORAGE_KEY = "sahaara.ai.chatHistory.v2";
const MAX_MESSAGES = 180;
const TRANSCRIPT_WORDS_PREVIEW = 22;
const DEFAULT_ADDRESS = "Saved user address";
const VOICE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function App() {
  const avatarControlsRef = useRef<AvatarControls | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const aiTranscriptTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionInstructionsRef = useRef(DEFAULT_SESSION_INSTRUCTIONS);
  const hasSpokenGreetingRef = useRef(false);
  const micActiveRef = useRef(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isChatOnly, setIsChatOnly] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [liveAiTranscript, setLiveAiTranscript] = useState("");
  const [status, setStatus] = useState("Ready");
  const [showHealthPanel, setShowHealthPanel] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [watchSnapshot, setWatchSnapshot] = useState<WatchPanelSnapshot | null>(null);
  const [pendingOrder, setPendingOrder] = useState<PreparedAssistantOrder | null>(null);
  const [assistantLanguageMode, setAssistantLanguageMode] = useState<AssistantLanguageMode>("mix");
  const [wakeWordEveryUtterance, setWakeWordEveryUtterance] = useState(true);

  const supportsRecording =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const supportsSpeechRecognition =
    typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const supportsVoiceInput = supportsSpeechRecognition || supportsRecording;

  useEffect(() => {
    messagesRef.current = messages;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
    } catch {}
  }, [messages]);

  useEffect(() => {
    micActiveRef.current = isMicOn && !isChatOnly;
  }, [isChatOnly, isMicOn]);

  useEffect(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}

    const greeting = String(DEFAULT_GREETING_MESSAGE || "").trim();
    if (!greeting) {
      setMessages([]);
      return;
    }

    setMessages([
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: greeting,
        timestamp: Date.now(),
        mode: "chat",
      },
    ]);
  }, []);

  const loadWatchSnapshot = useCallback(async () => {
    setHealthLoading(true);
    setHealthError("");
    try {
      const userId = getWatchUserId();
      const latest = await getWatchLatest(userId);
      setWatchSnapshot({
        heartRate: latest.snapshot.heartRate,
        spo2: latest.snapshot.spo2,
        skinTemp: latest.snapshot.skinTemp,
        freefallStatus: latest.snapshot.freefallStatus,
      });
    } catch (error) {
      setHealthError(toErrorMessage(error));
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const stopAiTranscriptAnimation = useCallback(() => {
    if (aiTranscriptTimerRef.current !== null) {
      window.clearInterval(aiTranscriptTimerRef.current);
      aiTranscriptTimerRef.current = null;
    }
  }, []);

  const stopAiVoice = useCallback(() => {
    stopAiTranscriptAnimation();
    window.speechSynthesis?.cancel();
    avatarControlsRef.current?.stopAudio();
    avatarControlsRef.current?.setMouthOverride(null);
    setIsSpeaking(false);
    setStatus("Voice stopped");
  }, [stopAiTranscriptAnimation]);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message].slice(-MAX_MESSAGES));
  }, []);

  const animateAiTranscript = useCallback(
    (text: string) => {
      stopAiTranscriptAnimation();
      setLiveAiTranscript("");
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length === 0) return;
      let index = 0;
      aiTranscriptTimerRef.current = window.setInterval(() => {
        index += 1;
        setLiveAiTranscript(words.slice(0, index).join(" "));
        if (index >= words.length) {
          stopAiTranscriptAnimation();
        }
      }, 90);
    },
    [stopAiTranscriptAnimation]
  );

  const speakReply = useCallback(
    async (text: string) => {
      if (isChatOnly) return;
      setIsSpeaking(true);
      animateAiTranscript(text);

      if (isSarvamConfigured()) {
        try {
          const audioBuffer = await ttsSarvam(text);
          await avatarControlsRef.current?.playAudio(audioBuffer.slice(0));
          setLiveAiTranscript(text);
          setIsSpeaking(false);
          return;
        } catch (error) {
          setStatus(`Sarvam TTS failed: ${toErrorMessage(error)}`);
          setIsSpeaking(false);
          setLiveAiTranscript(text);
          return;
        }
      }

      if (!("speechSynthesis" in window)) {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
        return;
      }

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "en-IN";
      utter.rate = 1.02;
      utter.onend = () => {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
      };
      utter.onerror = () => {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
      };
      window.speechSynthesis.speak(utter);
    },
    [animateAiTranscript, isChatOnly]
  );

  useEffect(() => {
    if (hasSpokenGreetingRef.current) return;
    const greeting = String(DEFAULT_GREETING_MESSAGE || "").trim();
    if (!greeting) return;
    hasSpokenGreetingRef.current = true;
    void speakReply(greeting);
  }, [speakReply]);

  const submitUserMessage = useCallback(
    async (text: string, mode: InputMode) => {
      const normalized = text.trim();
      if (!normalized) return;

      const nextLanguageMode = resolveAssistantLanguageMode(normalized, assistantLanguageMode);
      if (nextLanguageMode !== assistantLanguageMode) {
        setAssistantLanguageMode(nextLanguageMode);
      }

      const snapshot = messagesRef.current;

      appendMessage({
        id: crypto.randomUUID(),
        role: "user",
        text: normalized,
        timestamp: Date.now(),
        mode,
      });

      setIsThinking(true);
      setStatus("Thinking");

      const shouldShowPlacingOrder = !pendingOrder && isOrderIntentMessage(normalized);
      if (shouldShowPlacingOrder) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: chooseReply(
            nextLanguageMode,
            "Order process start ho gaya hai, details verify kar rahi hoon...",
            "Order process started, verifying details..."
          ),
          timestamp: Date.now(),
          mode: "chat",
        });
      }

      let reply = "";

      try {
        if (isLanguagePreferenceCommand(normalized)) {
          reply =
            nextLanguageMode === "english"
              ? "Sure. I will reply in English from now on."
              : "Theek hai. Ab se main Hindi + English mix mein reply karungi.";
        } else {
          const confirmationDecision = pendingOrder
          ? await inferConfirmationDecision(normalized, pendingOrder)
          : "unclear";

          if (pendingOrder && confirmationDecision === "confirm") {
            const confirmed = await confirmPreparedOrder(pendingOrder, true);
            setPendingOrder(null);
            if (confirmed.kind === "doctor") {
              const doctorName = confirmed.doctorName || pendingOrder.itemName;
              const fee = confirmed.fee ?? pendingOrder.unitPrice;
              const visitMode = pendingOrder.doctorMode || "online";
              const slot = confirmed.slot || "Slot confirmation shared shortly";
              reply = chooseReply(
                nextLanguageMode,
                `Confirm ho gaya. Doctor appointment book ho gaya. Doctor: ${doctorName}. Mode: ${visitMode}. Fee: Rs ${fee}. Slot: ${slot}.`,
                `Confirmed. Doctor appointment booked. Doctor: ${doctorName}. Mode: ${visitMode}. Fee: Rs ${fee}. Slot: ${slot}.`
              );
            } else {
              const itemName = confirmed.itemName || confirmed.medicineName || pendingOrder.itemName;
              const quantity = pendingOrder.quantity;
              const total = pendingOrder.totalPrice;
              reply = chooseReply(
                nextLanguageMode,
                `Confirm ho gaya. Order place ho gaya for ${itemName}. Quantity: ${quantity}. Total: Rs ${total}. Estimated delivery: 30 to 40 minutes.`,
                `Confirmed. Order placed for ${itemName}. Quantity: ${quantity}. Total: Rs ${total}. Estimated delivery: 30 to 40 minutes.`
              );
            }
          } else if (pendingOrder && confirmationDecision === "cancel") {
            await confirmPreparedOrder(pendingOrder, false);
            setPendingOrder(null);
            reply = chooseReply(nextLanguageMode, "Cancel kar diya. Order place nahi hua.", "Cancelled. No order was placed.");
          } else if (pendingOrder && isOrderIntentMessage(normalized)) {
            reply = await buildConfirmationPrompt(nextLanguageMode, pendingOrder, true);
          } else if (pendingOrder && confirmationDecision === "unclear") {
            reply = chooseReply(
              nextLanguageMode,
              `Mujhe clearly samajh nahi aaya. ${pendingOrder.itemName} place karne ke liye "confirm" bolo, ya stop ke liye "cancel" bolo.`,
              `I did not clearly catch that. Please reply "confirm" to place ${pendingOrder.itemName}, or "cancel" to stop.`
            );
          } else {
            const actionReply = await tryHandleSahaaraAction(normalized, nextLanguageMode);
            if (actionReply) {
              reply = actionReply.reply;
              if (actionReply.pendingOrder) {
                setPendingOrder(actionReply.pendingOrder);
              }
            }
          }
        }
      } catch (error) {
        setStatus(`API action failed: ${toErrorMessage(error)}`);
      }

      if (!reply) {
        if (isSarvamConfigured()) {
          try {
            reply = await llmReplySarvam(
              normalized,
              snapshot,
              undefined,
              nextLanguageMode,
              sessionInstructionsRef.current
            );
          } catch (error) {
            setStatus(`LLM fallback: ${toErrorMessage(error)}`);
            reply = await llmReplyMock(normalized, snapshot, nextLanguageMode);
          }
        } else {
          reply = await llmReplyMock(normalized, snapshot, nextLanguageMode);
        }
      }

      appendMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: reply,
        timestamp: Date.now(),
        mode: "chat",
      });

      avatarControlsRef.current?.applyExpressionFromText(reply);
      setIsThinking(false);
      setStatus("Replied");

      if (!isChatOnly) {
        await speakReply(reply);
      }
    },
    [appendMessage, assistantLanguageMode, isChatOnly, pendingOrder, speakReply]
  );

  const processVoiceBlob = useCallback(
    async (blob: Blob) => {
      if (!micActiveRef.current) return;
      if (blob.size < 1200 || isChatOnly) return;
      if (isSpeaking || window.speechSynthesis?.speaking) return;

      setStatus("Transcribing");
      setLiveUserTranscript("Listening...");

      let transcript = "";

      if (isSarvamConfigured()) {
        try {
          transcript = await sttSarvam(blob);
        } catch (error) {
          setStatus(`STT failed: ${toErrorMessage(error)}`);
          return;
        }
      }

      const clean = transcript.trim();
      if (!clean) return;
      if (!micActiveRef.current) return;
      const wakeDecision = gateVoiceTranscript(clean, wakeWordEveryUtterance);
      if (!wakeDecision.acceptedText) {
        setLiveUserTranscript(clean);
        setStatus(wakeDecision.statusText);
        return;
      }
      setLiveUserTranscript(wakeDecision.acceptedText);
      if (!micActiveRef.current) return;
      await submitUserMessage(wakeDecision.acceptedText, "voice");
    },
    [isChatOnly, isSpeaking, submitUserMessage, wakeWordEveryUtterance]
  );

  const stopRecording = useCallback(
    (forceOffMic: boolean) => {
      if (flushTimerRef.current !== null) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      mediaRecorderRef.current = null;
      chunksRef.current = [];
      queueRef.current = Promise.resolve();
      setIsRecording(false);

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }

      if (forceOffMic) {
        setIsMicOn(false);
      }
    },
    []
  );

  const stopSpeechRecognition = useCallback(() => {
    if (!recognitionRef.current) return;
    recognitionRef.current.onstart = null;
    recognitionRef.current.onend = null;
    recognitionRef.current.onerror = null;
    recognitionRef.current.onresult = null;
    recognitionRef.current.stop();
    recognitionRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    if (!supportsRecording || isChatOnly || !isSarvamConfigured()) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS });
    mediaStreamRef.current = stream;

    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType: preferredType });
    mediaRecorderRef.current = recorder;

    recorder.onstart = () => {
      if (!micActiveRef.current) {
        stopRecording(false);
        return;
      }
      setIsRecording(true);
      setStatus("Mic on");
      setLiveUserTranscript("Listening...");
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!micActiveRef.current) return;
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
      const ready = chunksRef.current;
      chunksRef.current = [];
      if (ready.length === 0) return;
      const blob = new Blob(ready, { type: preferredType });
      queueRef.current = queueRef.current
        .then(async () => processVoiceBlob(blob))
        .catch(() => undefined);
    };

    recorder.onerror = () => {
      setStatus("Mic error");
      stopRecording(true);
    };

    recorder.start(3200);

    flushTimerRef.current = window.setInterval(() => {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
    }, 3200);
  }, [isChatOnly, processVoiceBlob, stopRecording, supportsRecording]);

  const startSpeechRecognition = useCallback(async () => {
    if (!supportsSpeechRecognition || isChatOnly) return;

    const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!RecognitionCtor) return;

    const recognition = new RecognitionCtor();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-IN";

    recognition.onstart = () => {
      setIsRecording(true);
      setStatus("Mic on");
      setLiveUserTranscript("Listening...");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (!micActiveRef.current) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          if (isSpeaking || window.speechSynthesis?.speaking) {
            continue;
          }
          const wakeDecision = gateVoiceTranscript(transcript, wakeWordEveryUtterance);
          if (!wakeDecision.acceptedText) {
            setLiveUserTranscript(transcript);
            setStatus(wakeDecision.statusText);
            continue;
          }
          setLiveUserTranscript(wakeDecision.acceptedText);
          if (!micActiveRef.current) {
            return;
          }
          void submitUserMessage(wakeDecision.acceptedText, "voice");
        } else {
          interim = `${interim} ${transcript}`.trim();
        }
      }
      if (interim) {
        setLiveUserTranscript(interim);
      }
    };

    recognition.onerror = () => {
      setStatus("Speech recognition error");
      setIsRecording(false);
      stopSpeechRecognition();
      if (!micActiveRef.current) {
        return;
      }
      if (isSarvamConfigured()) {
        void startRecording();
      }
    };

    recognition.onend = () => {
      if (micActiveRef.current) {
        recognition.start();
      } else {
        setIsRecording(false);
      }
    };

    recognition.start();
  }, [
    isChatOnly,
    isMicOn,
    startRecording,
    stopSpeechRecognition,
    submitUserMessage,
    supportsSpeechRecognition,
    wakeWordEveryUtterance,
    isSpeaking,
  ]);

  useEffect(() => {
    if (isChatOnly && isMicOn) {
      setIsMicOn(false);
    }
  }, [isChatOnly, isMicOn]);

  useEffect(() => {
    if (!isMicOn || isChatOnly) {
      stopSpeechRecognition();
      stopRecording(false);
      return;
    }

    if (supportsSpeechRecognition) {
      void startSpeechRecognition().catch((error) => {
        setStatus(`Mic blocked: ${toErrorMessage(error)}`);
        if (isSarvamConfigured()) {
          void startRecording().catch(() => stopRecording(true));
        } else {
          stopRecording(true);
        }
      });
      return;
    }

    void startRecording().catch((error) => {
      setStatus(`Mic blocked: ${toErrorMessage(error)}`);
      stopRecording(true);
    });
  }, [
    isChatOnly,
    isMicOn,
    startRecording,
    stopRecording,
    startSpeechRecognition,
    stopSpeechRecognition,
    supportsSpeechRecognition,
  ]);

  useEffect(() => {
    return () => {
      stopSpeechRecognition();
      stopRecording(true);
      stopAiVoice();
      stopAiTranscriptAnimation();
    };
  }, [stopAiTranscriptAnimation, stopAiVoice, stopRecording, stopSpeechRecognition]);

  useEffect(() => {
    if (!showHealthPanel) return;
    void loadWatchSnapshot();
    const timer = window.setInterval(() => {
      void loadWatchSnapshot();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadWatchSnapshot, showHealthPanel]);

  const handleSend = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text) return;
      setDraft("");
      await submitUserMessage(text, "chat");
    },
    [draft, submitUserMessage]
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    setDraft("");
    setLiveUserTranscript("");
    setLiveAiTranscript("");
    localStorage.removeItem(STORAGE_KEY);
    sessionInstructionsRef.current = DEFAULT_SESSION_INSTRUCTIONS;
    setStatus("History cleared");
  }, []);

  const toggleChatOnly = useCallback(() => {
    setIsChatOnly((prev) => {
      const next = !prev;
      if (next) {
        setIsMicOn(false);
        stopRecording(false);
        stopAiVoice();
      }
      setStatus(next ? "Chat mode" : "Voice mode");
      return next;
    });
  }, [stopAiVoice, stopRecording]);

  const toggleMic = useCallback(() => {
    setIsMicOn((prev) => {
      const next = !prev;
      if (!next) {
        stopSpeechRecognition();
        stopRecording(false);
        setLiveUserTranscript("");
        setStatus("Mic off");
      } else {
        setStatus("Mic on");
      }
      return next;
    });
  }, [stopRecording, stopSpeechRecognition]);

  const transcriptUser = liveUserTranscript || lastRoleText(messages, "user");
  const transcriptAi = liveAiTranscript || lastRoleText(messages, "assistant");
  const recentMessages = useMemo(() => messages.slice(-24).reverse(), [messages]);

  return (
    <div className="app-shell">
      <main className={`main-layout ${isChatOnly ? "chat-mode" : "voice-mode"}`}>
        <section className="avatar-stage">
          <div className="avatar-frame">
            <Avatar
              isThinking={isThinking}
              onReady={(controls) => {
                avatarControlsRef.current = controls;
              }}
            />
          </div>

          <div className="avatar-controls" role="toolbar" aria-label="Avatar controls">
            <button
              className={`icon-btn ${isMicOn ? "danger" : "success"} ${isRecording ? "listening" : ""}`}
              onClick={toggleMic}
              disabled={isChatOnly || !supportsVoiceInput}
              title={isMicOn ? "Mic off" : "Mic on"}
              aria-label={isMicOn ? "Mic off" : "Mic on"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V7a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5zm-6-3.5a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 5.98 5.98 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.09A5.98 5.98 0 0 1 6 12z" />
              </svg>
            </button>
            <div
              className={`mic-state-pill ${isMicOn ? "on" : "off"} ${isRecording ? "active" : ""}`}
              aria-live="polite"
            >
              {isMicOn ? (isRecording ? "MIC ON - LISTENING" : "MIC ON") : "MIC OFF"}
            </div>
            <button
              className={`icon-btn ${wakeWordEveryUtterance ? "success" : "secondary"}`}
              onClick={() => {
                setWakeWordEveryUtterance((prev) => !prev);
                if (isMicOn && !isChatOnly) {
                  stopSpeechRecognition();
                  stopRecording(false);
                  if (supportsSpeechRecognition) {
                    void startSpeechRecognition().catch(() => undefined);
                  } else {
                    void startRecording().catch(() => undefined);
                  }
                }
              }}
              disabled={isChatOnly || !supportsVoiceInput}
              title={
                wakeWordEveryUtterance
                  ? "Wake word required before every voice command"
                  : "Wake word off (no Harshita required)"
              }
              aria-label={
                wakeWordEveryUtterance
                  ? "Wake word required before every voice command"
                  : "Wake word off (no Harshita required)"
              }
            >
              {wakeWordEveryUtterance ? "HW*" : "HW1"}
            </button>
            <button
              className="icon-btn secondary"
              onClick={stopAiVoice}
              disabled={!isSpeaking}
              title="Stop voice"
              aria-label="Stop voice"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 7h10v10H7z" />
              </svg>
            </button>
            <button className="icon-btn secondary" onClick={clearHistory} title="Clear" aria-label="Clear">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3a1 1 0 0 0-1 1v1H5a1 1 0 1 0 0 2h1v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7h1a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H9zm1 2h4v1h-4V5zm-2 2h8v12H8V7zm2 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
              </svg>
            </button>
            <button
              className={`icon-btn ${showHealthPanel ? "success" : "secondary"}`}
              onClick={() => setShowHealthPanel((prev) => !prev)}
              title={showHealthPanel ? "Hide health" : "Show health"}
              aria-label={showHealthPanel ? "Hide health" : "Show health"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21s-6.66-4.35-9.33-8.02C.78 10.37 1.38 6.9 4.4 5.2c2.2-1.23 4.5-.51 5.94 1.1C11.78 4.69 14.08 3.97 16.28 5.2c3.02 1.7 3.62 5.17 1.73 7.78C18.66 16.65 12 21 12 21z" />
              </svg>
            </button>
            <button
              className={`icon-btn ${isChatOnly ? "success" : "secondary"}`}
              onClick={toggleChatOnly}
              title={isChatOnly ? "Voice mode" : "Chat mode"}
              aria-label={isChatOnly ? "Voice mode" : "Chat mode"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9.7l-3.95 3.36A1 1 0 0 1 4 18.98V16a3 3 0 0 1-3-3V5h3zm3-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h.86a1 1 0 0 1 1 1v1.82l2.62-2.22a1 1 0 0 1 .65-.24H17a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7z" />
              </svg>
            </button>
          </div>
        </section>

        {isChatOnly && (
          <section className="chat-panel">
            <div className="chat-list">
              {recentMessages.length === 0 && <div className="empty-chat">No chats</div>}
              {recentMessages.map((message) => (
                <article key={message.id} className={`msg ${message.role}`}>
                  <div className="meta">
                    <span>{message.role === "user" ? "You" : "AI"}</span>
                    <span>{formatTime(message.timestamp)}</span>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>

            <form className="chat-form" onSubmit={handleSend}>
              <textarea
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type"
              />
              <button type="submit" className="send-btn" aria-label="Send">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.2 20.8a1 1 0 0 1-.18-1.8l16.2-7a1 1 0 0 0 0-1.84l-16.2-7a1 1 0 0 1 .26-1.91 1 1 0 0 1 .32.05l17.3 7.48a3 3 0 0 1 0 5.52L3.6 21.75a1 1 0 0 1-1.27-.95 1 1 0 0 1 .87-1z" />
                </svg>
              </button>
            </form>
          </section>
        )}
      </main>

      <p className="sr-status" aria-live="polite">
        {status}
      </p>

      {showHealthPanel && (
        <section className="floating-health" aria-label="Watch health panel">
          <div className="health-grid">
            <article className="health-card">
              <div className="health-icon heart">❤</div>
              <div className="health-meta">
                <span>Heart Rate</span>
                <strong>{watchSnapshot?.heartRate != null ? `${watchSnapshot.heartRate} bpm` : "--"}</strong>
              </div>
            </article>

            <article className="health-card">
              <div className="health-icon spo2">O2</div>
              <div className="health-meta">
                <span>SpO2</span>
                <strong>{watchSnapshot?.spo2 != null ? `${watchSnapshot.spo2}%` : "--"}</strong>
              </div>
            </article>

            <article className="health-card">
              <div className="health-icon temp">🌡</div>
              <div className="health-meta">
                <span>Skin Temp</span>
                <strong>{watchSnapshot?.skinTemp != null ? `${watchSnapshot.skinTemp} C` : "--"}</strong>
              </div>
            </article>

            <article className={`health-card status ${freefallClass(watchSnapshot?.freefallStatus)}`}>
              <div className="health-icon fall">⚠</div>
              <div className="health-meta">
                <span>Freefall</span>
                <strong>{formatFreefall(watchSnapshot?.freefallStatus)}</strong>
              </div>
            </article>
          </div>

          {healthLoading && <p className="health-state">Loading...</p>}
          {healthError && <p className="health-state error">{healthError}</p>}
        </section>
      )}

      {!isChatOnly && (
        <section className="floating-conversation" aria-label="Live conversation">
          <div className="floating-conversation-stream">
            <div className="mini-row user">
              <span className="who">You</span>
              <p>{toPreview(transcriptUser)}</p>
            </div>
            <div className="mini-row ai">
              <span className="who">AI</span>
              <p>{toPreview(transcriptAi)}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

async function tryHandleSahaaraAction(text: string, languageMode: AssistantLanguageMode): Promise<ActionReply | null> {
  const lower = text.toLowerCase();
  const userId = getWatchUserId();

  const llmPlan = await inferActionPlan(text);
  if (llmPlan) {
    const planned = await handleActionPlan(llmPlan, text, userId, languageMode);
    if (planned) {
      return planned;
    }
  }

  const hasOrderVerb = /\b(order|book|place|get|buy|need|want|arrange|send)\b/i.test(lower);
  const groceryHint =
    /\b(grocery|groceries|ration|atta|rice|milk|bread|egg|eggs|banana|apple|dal|sugar|salt|flour)\b/i.test(lower);
  const medicineHint =
    /\b(pharmacy|medicine|medicines|tablet|tablets|meds|drug|paracetamol|dolo|crocin|calpol|cetirizine|azithromycin|vitamin c)\b/i.test(
      lower
    );
  const doctorHint =
    /\b(doctor|appointment|consult|physician|cardio|cardiologist|derma|dermatology|pediatric|neurology|pulmonology)\b/i.test(
      lower
    );

  if (/(api health|health status|backend status|server status)/i.test(lower)) {
    const health = await getSahaaraHealth();
    return {
      reply: health.firebase.initialized
        ? chooseReply(languageMode, "Sahaara API connected hai aur Firebase initialized hai.", "Sahaara API is connected and Firebase is initialized.")
        : chooseReply(languageMode, "Sahaara API reachable hai, lekin Firebase abhi initialized nahi hai.", "Sahaara API is reachable but Firebase is not initialized yet."),
    };
  }

  if (/(watch|heart rate|spo2|oxygen|skin temp|temperature|vitals)/i.test(lower)) {
    const watch = await getWatchLatest(userId);
    const hr = watch.snapshot.heartRate != null ? `HR ${watch.snapshot.heartRate}` : "HR --";
    const spo2 = watch.snapshot.spo2 != null ? `SpO2 ${watch.snapshot.spo2}` : "SpO2 --";
    const temp = watch.snapshot.skinTemp != null ? `Temp ${watch.snapshot.skinTemp}` : "Temp --";
    return {
      reply: chooseReply(
        languageMode,
        `Latest watch vitals ${watch.userId} ke liye: ${hr}, ${spo2}, ${temp}.`,
        `Latest watch vitals for ${watch.userId}: ${hr}, ${spo2}, ${temp}.`
      ),
    };
  }

  if (hasOrderVerb && groceryHint) {
    const itemRaw = pickItem(text, ["rice", "milk", "bread", "egg", "eggs", "banana", "apple", "atta", "dal", "sugar", "salt"]) || "milk";
    const item = normalizeGroceryItem(itemRaw);
    const quantity = pickQuantity(lower) ?? 1;
    const order = await prepareGroceryOrder({
      userId,
      itemName: item,
      quantity,
      unit: "unit",
      deliveryAddress: DEFAULT_ADDRESS,
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, order),
      pendingOrder: order,
    };
  }

  if (hasOrderVerb && medicineHint) {
    const medicineRaw =
      pickItem(text, ["paracetamol", "dolo", "crocin", "calpol", "azithromycin", "vitamin c", "cetirizine"]) ||
      "paracetamol";
    const medicine = normalizeMedicineItem(medicineRaw);
    const quantity = pickQuantity(lower) ?? 1;
    const order = await preparePharmacyOrder({
      userId,
      medicineName: medicine,
      quantity,
      unit: "strip",
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, order),
      pendingOrder: order,
    };
  }

  if (doctorHint && (hasOrderVerb || /\b(consult|appointment)\b/i.test(lower))) {
    const mode = /(home|at home)/i.test(lower) ? "home" : "online";
    const specialization = pickSpecialization(lower);
    const appointmentTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const appointment = await prepareDoctorAppointment({
      userId,
      doctorName: "Available Doctor",
      specialization,
      appointmentTime,
      mode,
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, appointment),
      pendingOrder: appointment,
    };
  }

  return null;
}

async function inferActionPlan(text: string): Promise<SahaaraIntentPlan | null> {
  if (!isSarvamConfigured()) {
    return null;
  }

  try {
    return await inferSahaaraIntentSarvam(text);
  } catch {
    return null;
  }
}

async function inferConfirmationDecision(
  text: string,
  pendingOrder: PreparedAssistantOrder,
): Promise<"confirm" | "cancel" | "unclear"> {
  if (isSarvamConfigured()) {
    try {
      const plan = await inferConfirmationDecisionSarvam(text, {
        kind: pendingOrder.kind,
        itemName: pendingOrder.itemName,
        quantity: pendingOrder.quantity,
        totalPrice: pendingOrder.totalPrice,
      });
      if (plan?.decision) {
        return plan.decision;
      }
    } catch {
      // fallback to regex
    }
  }

  if (isConfirmReply(text)) return "confirm";
  if (isCancelReply(text)) return "cancel";
  return "unclear";
}

async function handleActionPlan(
  plan: SahaaraIntentPlan,
  text: string,
  userId: string,
  languageMode: AssistantLanguageMode,
): Promise<ActionReply | null> {
  if (plan.action === "none") {
    return null;
  }

  if (plan.action === "api_health") {
    const health = await getSahaaraHealth();
    return {
      reply: health.firebase.initialized
        ? chooseReply(languageMode, "Sahaara API connected hai aur Firebase initialized hai.", "Sahaara API is connected and Firebase is initialized.")
        : chooseReply(languageMode, "Sahaara API reachable hai, lekin Firebase abhi initialized nahi hai.", "Sahaara API is reachable but Firebase is not initialized yet."),
    };
  }

  if (plan.action === "watch_vitals") {
    const watch = await getWatchLatest(userId);
    const hr = watch.snapshot.heartRate != null ? `HR ${watch.snapshot.heartRate}` : "HR --";
    const spo2 = watch.snapshot.spo2 != null ? `SpO2 ${watch.snapshot.spo2}` : "SpO2 --";
    const temp = watch.snapshot.skinTemp != null ? `Temp ${watch.snapshot.skinTemp}` : "Temp --";
    return {
      reply: chooseReply(
        languageMode,
        `Latest watch vitals ${watch.userId} ke liye: ${hr}, ${spo2}, ${temp}.`,
        `Latest watch vitals for ${watch.userId}: ${hr}, ${spo2}, ${temp}.`
      ),
    };
  }

  if (plan.action === "grocery_order") {
    const itemRaw =
      plan.itemName || pickItem(text, ["rice", "milk", "bread", "egg", "eggs", "banana", "apple", "atta", "dal", "sugar", "salt"]) || "milk";
    const item = normalizeGroceryItem(itemRaw);
    const quantity = plan.quantity ?? pickQuantity(text.toLowerCase()) ?? 1;
    const order = await prepareGroceryOrder({
      userId,
      itemName: item,
      quantity,
      unit: "unit",
      deliveryAddress: DEFAULT_ADDRESS,
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, order),
      pendingOrder: order,
    };
  }

  if (plan.action === "pharmacy_order") {
    const medicineRaw =
      plan.medicineName ||
      pickItem(text, ["paracetamol", "dolo", "crocin", "calpol", "azithromycin", "vitamin c", "cetirizine"]) ||
      "paracetamol";
    const medicine = normalizeMedicineItem(medicineRaw);
    const quantity = plan.quantity ?? pickQuantity(text.toLowerCase()) ?? 1;
    const order = await preparePharmacyOrder({
      userId,
      medicineName: medicine,
      quantity,
      unit: "strip",
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, order),
      pendingOrder: order,
    };
  }

  if (plan.action === "doctor_booking") {
    const mode = plan.doctorMode || (/home|at home/i.test(text) ? "home" : "online");
    const specialization = plan.doctorSpecialization || pickSpecialization(text.toLowerCase());
    const appointmentTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const appointment = await prepareDoctorAppointment({
      userId,
      doctorName: "Available Doctor",
      specialization,
      appointmentTime,
      mode,
    });
    return {
      reply: await buildConfirmationPrompt(languageMode, appointment),
      pendingOrder: appointment,
    };
  }

  return null;
}

function isConfirmReply(text: string): boolean {
  return /\b(confirm|yes|proceed|place|book it|do it|ok|okay|go ahead)\b/i.test(text);
}

function isCancelReply(text: string): boolean {
  return /\b(cancel|no|stop|don\s*'?t|do not)\b/i.test(text);
}

function isOrderIntentMessage(text: string): boolean {
  return /\b(order|book|buy|get|medicine|grocery|doctor|appointment|atta|pharmacy)\b/i.test(text);
}

function chooseReply(mode: AssistantLanguageMode, mixText: string, englishText: string): string {
  return mode === "english" ? englishText : mixText;
}

function resolveAssistantLanguageMode(text: string, current: AssistantLanguageMode): AssistantLanguageMode {
  if (/\b(english|only english|in english|speak english|talk in english)\b/i.test(text)) {
    return "english";
  }
  if (/\b(hindi|hinglish|mix|hindi me|hindi mein|hindi english)\b/i.test(text)) {
    return "mix";
  }
  return current;
}

function isLanguagePreferenceCommand(text: string): boolean {
  return /(speak|talk|reply|respond).*(english|hindi|hinglish|mix)|\b(only english|in english|hindi me|hindi mein)\b/i.test(text);
}

function extractWakeWordCommand(text: string): string | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const match = raw.match(/^\s*harshita[\s,.:;!-]*(.+)$/i);
  if (!match?.[1]) return null;
  const command = match[1].trim();
  return command || null;
}

function gateVoiceTranscript(
  transcript: string,
  requireEveryUtterance: boolean,
): {
  acceptedText: string | null;
  unlockSession: boolean;
  statusText: string;
} {
  const wakeCommand = extractWakeWordCommand(transcript);

  if (requireEveryUtterance) {
    if (!wakeCommand) {
      return {
        acceptedText: null,
        unlockSession: false,
        statusText: "Wake word not detected. Say 'Harshita ...'",
      };
    }
    return {
      acceptedText: wakeCommand,
      unlockSession: false,
      statusText: "Listening...",
    };
  }

  return {
    acceptedText: transcript.trim(),
    unlockSession: false,
    statusText: "Listening...",
  };
}

async function buildConfirmationPrompt(
  languageMode: AssistantLanguageMode,
  order: PreparedAssistantOrder,
  reminder = false,
): Promise<string> {
  if (isSarvamConfigured()) {
    try {
      const llmText = await composeOrderConfirmationMessageSarvam({
        kind: order.kind,
        itemName: order.itemName,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        totalPrice: order.totalPrice,
        doctorMode: order.doctorMode,
        mode: languageMode,
        reminder,
      });
      if (llmText && llmText.trim()) {
        return llmText.trim();
      }
    } catch {
      // fallback text below
    }
  }

  if (order.kind === "doctor") {
    return chooseReply(
      languageMode,
      `Doctor booking confirm kariye: ${order.itemName}, mode ${order.doctorMode || "online"}, fee Rs ${order.unitPrice}. Book karne ke liye "confirm" bolo, cancel ke liye "cancel" bolo.`,
      `Please confirm doctor booking: ${order.itemName}, mode ${order.doctorMode || "online"}, fee Rs ${order.unitPrice}. Reply "confirm" to book or "cancel" to stop.`
    );
  }

  const prefix = order.kind === "pharmacy" ? "Pharmacy" : "Grocery";
  return chooseReply(
    languageMode,
    `${prefix} order confirm kariye: ${order.itemName}, qty ${order.quantity}, price Rs ${order.unitPrice} each (total Rs ${order.totalPrice}). Place karne ke liye "confirm" bolo, cancel ke liye "cancel" bolo.`,
    `Please confirm ${order.kind} order: ${order.itemName}, qty ${order.quantity}, price Rs ${order.unitPrice} each (total Rs ${order.totalPrice}). Reply "confirm" to place or "cancel" to stop.`
  );
}

const GROCERY_CANONICAL = ["atta", "rice", "milk", "bread", "eggs", "banana", "apple", "dal", "sugar", "salt"] as const;
const MEDICINE_CANONICAL = ["paracetamol", "cetirizine", "vitamin c", "azithromycin"] as const;

function normalizeGroceryItem(raw: string): string {
  return normalizeByCatalog(raw, GROCERY_CANONICAL);
}

function normalizeMedicineItem(raw: string): string {
  const normalized = normalizeByCatalog(raw, MEDICINE_CANONICAL);
  if (normalized === "paracetamol") return "paracetamol";
  return normalized;
}

function normalizeByCatalog(raw: string, catalog: readonly string[]): string {
  const cleaned = normalizeToken(raw);
  if (!cleaned) return catalog[0] || raw;

  const alias: Record<string, string> = {
    aata: "atta",
    ata: "atta",
    gehun: "atta",
    gehu: "atta",
    doodh: "milk",
    ande: "eggs",
    anda: "eggs",
    daal: "dal",
    medisin: "paracetamol",
    medicine: "paracetamol",
    dolo: "paracetamol",
    crocin: "paracetamol",
    calpol: "paracetamol",
    cetrizine: "cetirizine",
    vitaminc: "vitamin c",
  };

  if (alias[cleaned]) return alias[cleaned];

  let best = catalog[0] || raw;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of catalog) {
    const dist = levenshtein(cleaned, normalizeToken(candidate));
    if (dist < bestScore) {
      bestScore = dist;
      best = candidate;
    }
  }

  if (bestScore <= 3) return best;
  return raw.trim();
}

function normalizeToken(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function pickQuantity(text: string): number | null {
  const match = text.match(/\b(\d{1,2})\b/);
  if (!match) return null;
  const qty = Number(match[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return qty;
}

function pickItem(text: string, options: string[]): string | null {
  const lower = text.toLowerCase();
  for (const option of options) {
    if (lower.includes(option.toLowerCase())) {
      return option;
    }
  }

  const orderFor = text.match(/(?:for|of)\s+([a-zA-Z\s]+?)(?:\.|,|$)/);
  if (orderFor?.[1]) {
    return orderFor[1].trim();
  }

  return null;
}

function pickSpecialization(text: string): string {
  if (/heart|cardio/.test(text)) return "Cardiology";
  if (/skin|derma/.test(text)) return "Dermatology";
  if (/child|pediatric/.test(text)) return "Pediatrics";
  if (/lung|breath|chest/.test(text)) return "Pulmonology";
  if (/neuro|brain|headache/.test(text)) return "Neurology";
  return "General Medicine";
}

function toPreview(text: string): string {
  if (!text) return "...";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= TRANSCRIPT_WORDS_PREVIEW) return text;
  return `${words.slice(words.length - TRANSCRIPT_WORDS_PREVIEW).join(" ")}...`;
}

function lastRoleText(messages: ChatMessage[], role: ChatRole): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return messages[i].text;
  }
  return "";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatFreefall(status?: string): string {
  if (!status) return "Unknown";
  return status;
}

function freefallClass(status?: string): string {
  const normalized = (status || "").toLowerCase();
  if (normalized.includes("alert") || normalized.includes("impact")) return "critical";
  if (normalized.includes("free fall") || normalized.includes("stillness")) return "warn";
  if (normalized.includes("normal")) return "ok";
  return "neutral";
}

export default App;