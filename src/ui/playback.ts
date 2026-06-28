import { audioContext } from '../audio/audioUtils';

interface Track {
  buffer: AudioBuffer;
  gain: GainNode;
  mute: boolean;
  solo: boolean;
}

// Synchronized multi-buffer player: every component starts at the same time and
// (optionally) loops together, with live solo/mute mixing. Because all buffers
// share the crop length, they stay phase-locked across loops.
export class PlaybackEngine {
  private ctx = audioContext();
  private master = this.ctx.createGain();
  private sources: AudioBufferSourceNode[] = [];
  private startTime = 0;

  tracks: Track[] = [];
  playing = false;
  loop = true;
  onState?: () => void;

  constructor() {
    this.master.connect(this.ctx.destination);
  }

  setTracks(buffers: AudioBuffer[]): void {
    this.stop();
    this.tracks = buffers.map((buffer) => {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      return { buffer, gain, mute: false, solo: false };
    });
    this.applyGains();
  }

  private applyGains(): void {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const audible = anySolo ? t.solo : !t.mute;
      t.gain.gain.value = audible ? 1 : 0;
    }
  }

  toggleMute(i: number): void {
    this.tracks[i].mute = !this.tracks[i].mute;
    this.applyGains();
    this.onState?.();
  }

  toggleSolo(i: number): void {
    this.tracks[i].solo = !this.tracks[i].solo;
    this.applyGains();
    this.onState?.();
  }

  setLoop(v: boolean): void {
    this.loop = v;
    if (this.playing) void this.play();
    else this.onState?.();
  }

  async play(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopSources();
    const t0 = this.ctx.currentTime + 0.05;
    this.sources = this.tracks.map((t) => {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.loop = this.loop;
      src.connect(t.gain);
      src.start(t0);
      return src;
    });
    this.startTime = t0;
    this.playing = true;
    if (!this.loop && this.sources[0]) {
      this.sources[0].onended = () => {
        if (this.playing) {
          this.playing = false;
          this.onState?.();
        }
      };
    }
    this.onState?.();
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
  }

  stop(): void {
    this.stopSources();
    this.playing = false;
    this.onState?.();
  }

  /** Current transport position in seconds (for drawing a playhead). */
  positionSec(): number {
    const len = this.tracks[0]?.buffer.duration ?? 0;
    if (!this.playing || len <= 0) return 0;
    const elapsed = this.ctx.currentTime - this.startTime;
    if (elapsed < 0) return 0;
    return this.loop ? elapsed % len : Math.min(elapsed, len);
  }
}
