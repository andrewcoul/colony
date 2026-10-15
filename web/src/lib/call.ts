import { useSyncExternalStore } from "react";

/*
 * A voice call with a Bot. The mic is listened to here: each thing you say (speech, then a
 * short pause) goes to the server as a 16 kHz WAV clip over /api/chats/<id>/call, which
 * transcribes it and posts it as your message. The Bot's reply comes back as MP3, a sentence
 * at a time, played in order. Starting to talk over the Bot stops it (barge-in), and what you
 * say steers it like any message sent while it works.
 */

export type CallStatus = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended" | "failed";

export type CallSnapshot = {
  chatId: string;
  /** The Bot on the call (known once connected). */
  botId: string | null;
  status: CallStatus;
  muted: boolean;
  /** Playback speed of the Bot's voice. */
  speed: number;
  /** Mic level, 0–1 (drives the rings around your side). */
  level: number;
  /** The Bot's voice level, 0–1 (drives its face). */
  botLevel: number;
  /** What you said last, as transcribed, and what the Bot is saying now. */
  heard: string;
  saying: string;
  startedAt: number;
  error: string | null;
};

const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3] as const;
export const nextSpeed = (speed: number) => SPEEDS[(SPEEDS.indexOf(speed as never) + 1) % SPEEDS.length] ?? 1;
const savedSpeed = () => { const value = Number(localStorage.getItem("colony.callSpeed")); return SPEEDS.includes(value as never) ? value : 1; };

// Speech detection: speech is a level well above the room's noise floor.
const FRAME_MS = 20;
const PREROLL_MS = 300;
const END_SILENCE_MS = 750;
const MIN_SPEECH_MS = 250;
const MAX_CLIP_MS = 30_000;
const TARGET_RATE = 16_000;

/** Passes mic samples from the audio thread to the page. */
const WORKLET = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const input = inputs[0]; if (input && input[0]) this.port.postMessage(input[0].slice(0)); return true; }
}
registerProcessor("colony-tap", Tap);`;

class CallSession {
  snapshot: CallSnapshot;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private playing: AudioBufferSourceNode | null = null;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private pendingAudio = 0;
  private sayingText: string[] = [];
  private frame: Float32Array[] = [];
  private frameSamples = 0;
  private preroll: Float32Array[] = [];
  private clip: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private noise = 0.01;
  private meter = 0;
  private waitingReply = false;

  constructor(chatId: string, private answer: string | undefined, private emit: () => void) {
    this.snapshot = { chatId, botId: null, status: "connecting", muted: false, speed: savedSpeed(), level: 0, botLevel: 0, heard: "", saying: "", startedAt: Date.now(), error: null };
  }

  private update(patch: Partial<CallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      this.fail("Colony needs the microphone for calls. Allow it in the browser and try again.");
      return;
    }
    if (this.snapshot.status === "ended") { this.release(); return; }
    const context = new AudioContext();
    this.context = context;
    void context.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(context, "colony-tap");
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => this.hear(event.data);
    const mute = context.createGain();
    mute.gain.value = 0;
    context.createMediaStreamSource(this.stream).connect(tap).connect(mute).connect(context.destination);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(context.destination);
    this.meterLoop();

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/api/chats/${this.snapshot.chatId}/call${this.answer ? `?answer=${this.answer}` : ""}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (event) => (typeof event.data === "string" ? this.control(JSON.parse(event.data)) : this.play(event.data as ArrayBuffer));
    ws.onclose = () => { if (this.snapshot.status !== "ended" && this.snapshot.status !== "failed") this.fail("The call dropped."); };
  }

  private control(message: { type: string; state?: string; text?: string; message?: string; botId?: string }) {
    if (message.type === "ready") this.update({ status: "listening", botId: message.botId ?? null });
    else if (message.type === "heard") this.update({ heard: message.text ?? "", saying: "" });
    else if (message.type === "say") this.sayingText.push(message.text ?? "");
    else if (message.type === "state" && message.state === "thinking") { this.waitingReply = true; this.update({ status: "thinking" }); }
    else if (message.type === "state" && message.state === "listening") { this.waitingReply = false; this.settle(); }
    else if (message.type === "error") { this.waitingReply = false; this.update({ error: message.message ?? "Something went wrong." }); this.settle(); }
  }

  /** Plays the Bot's sentences in order, at the chosen speed. */
  private play(bytes: ArrayBuffer) {
    const context = this.context;
    if (!context) return;
    const mine = this.generation;
    const text = this.sayingText.shift() ?? "";
    this.pendingAudio++;
    this.waitingReply = false;
    const decoded = context.decodeAudioData(bytes).catch(() => null);
    this.queue = this.queue.then(async () => {
      const buffer = await decoded;
      if (!buffer || mine !== this.generation) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.snapshot.speed;
      source.connect(this.analyser!);
      this.playing = source;
      this.update({ status: "speaking", saying: text, error: null });
      await new Promise<void>((resolve) => { source.onended = () => resolve(); source.start(); });
      if (this.playing === source) this.playing = null;
    }).finally(() => {
      this.pendingAudio--;
      if (mine === this.generation) this.settle();
    });
  }

  /** Back to listening once nothing's playing or on its way. */
  private settle() {
    if (this.snapshot.status === "ended" || this.snapshot.status === "failed" || this.snapshot.status === "hearing") return;
    if (this.pendingAudio > 0 || this.playing) return;
    this.update({ status: this.waitingReply ? "thinking" : "listening" });
  }

  /** You talked over the Bot: stop it and drop what it hadn't said yet. */
  private interrupt() {
    this.generation++;
    this.playing?.stop();
    this.playing = null;
    this.sayingText = [];
    this.queue = Promise.resolve();
    this.pendingAudio = 0;
    this.send({ type: "interrupt" });
  }

  private hear(samples: Float32Array) {
    if (this.snapshot.muted || !this.context || this.snapshot.status === "connecting" || this.snapshot.status === "ended") return;
    this.frame.push(samples);
    this.frameSamples += samples.length;
    if (this.frameSamples < (this.context.sampleRate * FRAME_MS) / 1000) return;
    const frame = concat(this.frame);
    this.frame = [];
    this.frameSamples = 0;
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    const rms = Math.sqrt(sum / frame.length);
    this.meter = Math.max(rms, this.meter * 0.85);
    // While the Bot talks, demand more: echo cancellation isn't perfect.
    const threshold = Math.max(0.015, this.noise * 3) * (this.playing ? 2.5 : 1);
    const loud = rms > threshold;
    if (!loud && !this.clip.length) this.noise = this.noise * 0.95 + rms * 0.05;

    if (this.clip.length) {
      this.clip.push(frame);
      if (loud) { this.speechMs += FRAME_MS; this.silenceMs = 0; } else this.silenceMs += FRAME_MS;
      const length = this.clip.length * FRAME_MS;
      if (this.silenceMs >= END_SILENCE_MS || length >= MAX_CLIP_MS) this.finishClip();
    } else if (loud) {
      if (this.playing || this.pendingAudio) this.interrupt();
      this.clip = [...this.preroll, frame];
      this.speechMs = FRAME_MS;
      this.silenceMs = 0;
      this.update({ status: "hearing" });
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_MS / FRAME_MS) this.preroll.shift();
    }
  }

  private finishClip() {
    const clip = concat(this.clip);
    const enough = this.speechMs >= MIN_SPEECH_MS;
    this.clip = [];
    this.preroll = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    if (!enough || !this.context) { this.update({ status: "listening" }); this.settle(); return; }
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(wav(downsample(clip, this.context.sampleRate, TARGET_RATE), TARGET_RATE));
    this.waitingReply = true;
    this.update({ status: "thinking" });
  }

  private meterLoop() {
    const data = new Uint8Array(256);
    let last = 0;
    const tick = (now: number) => {
      if (!this.context || this.snapshot.status === "ended" || this.snapshot.status === "failed") return;
      requestAnimationFrame(tick);
      if (now - last < 50) return;
      last = now;
      this.analyser?.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
      const level = this.snapshot.muted ? 0 : Math.min(1, this.meter * 8);
      const botLevel = this.playing ? Math.min(1, peak * 2.5) : 0;
      if (Math.abs(level - this.snapshot.level) > 0.02 || Math.abs(botLevel - this.snapshot.botLevel) > 0.02) this.update({ level, botLevel });
    };
    requestAnimationFrame(tick);
  }

  private send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  setMuted(muted: boolean) {
    if (muted && this.clip.length) { this.clip = []; this.speechMs = 0; }
    this.update({ muted, ...(muted && this.snapshot.status === "hearing" ? { status: "listening" as const } : {}) });
  }

  setSpeed(speed: number) {
    localStorage.setItem("colony.callSpeed", String(speed));
    if (this.playing) this.playing.playbackRate.value = speed;
    this.update({ speed });
  }

  private fail(error: string) {
    this.release();
    this.update({ status: "failed", error });
  }

  end() {
    this.release();
    this.update({ status: "ended" });
  }

  private release() {
    this.ws?.close();
    this.ws = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.playing = null;
  }
}

function concat(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function downsample(samples: Float32Array, from: number, to: number) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the samples each output sample covers (a cheap low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 16-bit mono PCM WAV. */
function wav(samples: Float32Array, rate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buffer;
}

// One call at a time, kept outside React so it survives moving between chats.
let session: CallSession | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Starts a call in a chat (answer: the id of a Bot's ringing call you're picking up). */
export function startCall(chatId: string, answer?: string) {
  session?.end();
  session = new CallSession(chatId, answer, notify);
  notify();
  void session.start();
}

export function endCall() {
  session?.end();
  session = null;
  notify();
}

export const setCallMuted = (muted: boolean) => session?.setMuted(muted);
export const setCallSpeed = (speed: number) => session?.setSpeed(speed);

export function useCall(): CallSnapshot | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => session?.snapshot ?? null,
  );
}
