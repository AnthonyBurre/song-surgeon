"""Separation engines, mirroring the TypeScript contract in src/engine/types.ts.

An engine describes itself with `info()` (serialized to the same JSON shape as
the TS `EngineInfo`) and turns audio into labelled parts with `separate()`.
Loop trimming and key estimation are *not* done here: the browser applies them
to every engine's output (src/engine/finish.ts), so results stay comparable.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

# Reports (fraction, stage). The job runner's implementation raises JobCancelled
# when the client has cancelled, so engines get cancellation for free by calling
# it often.
Progress = Callable[[float, str], None]


class JobCancelled(Exception):
    pass


@dataclass
class Part:
    # Shape (channels, samples), float32, at the input sample rate.
    audio: np.ndarray
    # 'percussive' | 'harmonic' — what the browser's matcher keys on.
    kind: str
    label: str
    energy: float


class Engine(Protocol):
    id: str

    def info(self) -> dict[str, Any]: ...

    def separate(self, audio: np.ndarray, sample_rate: int, options: dict[str, Any], progress: Progress) -> list[Part]: ...


def pick_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class DemucsEngine:
    """Hybrid Transformer Demucs: fixed instrument stems from a pretrained model.

    Weights download on first use (~80 MB per model) into the torch hub cache.
    """

    id = "demucs"

    # Longest selection accepted, in seconds. Demucs processes in chunks so it
    # copes with whole songs; this bounds upload size and memory (5 min of stereo
    # float audio is ~100 MB each way).
    MAX_SECONDS = 300

    MODELS = [
        ("htdemucs", "4 stems (drums, bass, vocals, other)"),
        ("htdemucs_6s", "6 stems (adds guitar, piano)"),
        ("htdemucs_ft", "4 stems, fine-tuned (slower, cleaner)"),
    ]

    def __init__(self, device: str):
        self.device = device
        self._models: dict[str, Any] = {}

    def info(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": f"Demucs stems (local, {self.device.upper()})",
            "description": "Splits the selection into instrument stems with a neural network running on this computer.",
            "runtime": "local-server",
            "maxSeconds": self.MAX_SECONDS,
            "canSplit": False,
            "options": [
                {
                    "kind": "choice",
                    "key": "model",
                    "label": "Model",
                    "choices": [{"value": v, "label": label} for v, label in self.MODELS],
                    "default": "htdemucs",
                },
                {
                    "kind": "number",
                    "key": "shifts",
                    "label": "Quality passes",
                    "min": 0,
                    "max": 5,
                    "step": 1,
                    "default": 1,
                },
            ],
        }

    def _model(self, name: str, progress: Progress) -> Any:
        if name not in self._models:
            from demucs.pretrained import get_model

            progress(0.05, "Loading model (first run downloads it)")
            model = get_model(name)
            model.eval()
            self._models[name] = model
        return self._models[name]

    def separate(self, audio: np.ndarray, sample_rate: int, options: dict[str, Any], progress: Progress) -> list[Part]:
        import julius
        import torch
        from demucs.apply import apply_model

        valid = {v for v, _ in self.MODELS}
        name = options.get("model") if options.get("model") in valid else "htdemucs"
        shifts = int(np.clip(int(options.get("shifts", 1)), 0, 5))
        # One second of slack: the browser appends a short loop-crossfade tail.
        if audio.shape[1] > (self.MAX_SECONDS + 1) * sample_rate:
            raise ValueError(f"Selection is longer than {self.MAX_SECONDS // 60} minutes")
        model = self._model(name, progress)

        progress(0.15, "Separating stems")
        in_channels = audio.shape[0]
        wav = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))
        # The model expects stereo at its own rate (44.1 kHz).
        if in_channels == 1:
            wav = wav.repeat(2, 1)
        elif in_channels > 2:
            wav = wav[:2]
        if sample_rate != model.samplerate:
            wav = julius.resample_frac(wav, sample_rate, model.samplerate)

        # apply_model calls back as each model chunk starts/ends. Counting chunk
        # ends gives real progress; the estimate of the total is approximate
        # (shifts pad the input a little), so it is clamped below 1.
        overlap = 0.25
        stride = (1 - overlap) * float(getattr(model, "segment", 7.8))
        seconds = wav.shape[-1] / model.samplerate
        chunks = int(np.ceil(seconds / stride)) * max(1, shifts) * len(getattr(model, "models", [model]))
        done = 0

        def on_chunk(event: dict[str, Any]) -> None:
            nonlocal done
            if event.get("state") == "end":
                done += 1
            progress(0.15 + 0.75 * min(done / max(1, chunks), 0.99), "Separating stems")

        # Normalize loudness for the model, then undo it. Pure gain (no offset),
        # so the stems still sum to the input.
        scale = float(wav.std()) or 1.0
        with torch.no_grad():
            out = apply_model(
                model,
                (wav / scale)[None],
                shifts=shifts,
                split=True,
                overlap=overlap,
                device=self.device,
                callback=on_chunk,
            )[0]
        out = out * scale

        progress(0.9, "Encoding stems")
        if sample_rate != model.samplerate:
            out = julius.resample_frac(out, model.samplerate, sample_rate)
        length = audio.shape[1]
        out = out[..., :length]
        if out.shape[-1] < length:
            out = torch.nn.functional.pad(out, (0, length - out.shape[-1]))

        parts = []
        for source, stem in zip(model.sources, out):
            stem = stem.mean(0, keepdim=True) if in_channels == 1 else stem
            data = stem.cpu().numpy().astype(np.float32)
            parts.append(
                Part(
                    audio=data,
                    kind="percussive" if source == "drums" else "harmonic",
                    label=source.capitalize(),
                    energy=float(np.sqrt(np.mean(data[0] ** 2))),
                )
            )
        # Percussive first, then loudest first — the same order the built-in engine uses.
        parts.sort(key=lambda p: (p.kind != "percussive", -p.energy))
        progress(1.0, "Done")
        return parts
