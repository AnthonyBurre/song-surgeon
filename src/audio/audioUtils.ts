let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  const arr = await file.arrayBuffer();
  return await audioContext().decodeAudioData(arr);
}

// Downmix every channel to a single mono signal for analysis.
export function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < len; i++) out[i] /= channels;
  }
  return out;
}

export function cropMono(
  mono: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
): Float32Array {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(mono.length, Math.floor(endSec * sampleRate));
  return mono.slice(a, Math.max(a, b));
}

// Crop each channel of a decoded buffer to [startSec, startSec + lengthSamples).
// Used to feed the separator real stereo so it can output stereo components.
export function cropChannels(
  buffer: AudioBuffer,
  startSec: number,
  lengthSamples: number,
): Float32Array[] {
  const a = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const b = Math.min(data.length, a + lengthSamples);
    channels.push(data.slice(a, Math.max(a, b)));
  }
  return channels;
}

// Sum several multi-channel parts sample-wise into one part (for combining
// components). Parts share a length/channel count; a mono part folds into every
// output channel so it can be combined with a stereo one.
export function mixChannels(parts: Float32Array[][]): Float32Array[] {
  const channelCount = Math.max(1, ...parts.map((p) => p.length));
  const length = Math.max(0, ...parts.map((p) => p[0]?.length ?? 0));
  const out: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const acc = new Float32Array(length);
    for (const p of parts) {
      const ch = p[Math.min(c, p.length - 1)];
      if (ch) for (let i = 0; i < ch.length; i++) acc[i] += ch[i];
    }
    out.push(acc);
  }
  return out;
}

export function toAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  const buf = audioContext().createBuffer(Math.max(1, channels.length), length, sampleRate);
  channels.forEach((ch, c) => buf.getChannelData(c).set(ch));
  return buf;
}

// Encode one or more Float32 channels as an interleaved 16-bit PCM WAV blob.
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const blockAlign = numChannels * 2;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function formatTime(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
