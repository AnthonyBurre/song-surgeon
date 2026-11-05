"""HTTP API for local engines, plus the built UI.

Wire protocol (consumed by src/engine/http.ts):

  GET    /api/engines                 → [EngineInfo, ...]
  POST   /api/jobs                    multipart: engine, options (JSON), audio (WAV)
                                      → 202 {"id": ...}
  GET    /api/jobs/{id}/events        Server-Sent Events:
                                        progress {fraction, stage}
                                        done     {sampleRate, parts: [{label, kind, energy}]}
                                        error    {message}
  GET    /api/jobs/{id}/parts/{n}.wav → 32-bit float WAV of part n
  DELETE /api/jobs/{id}               cancel (if running) and free the job

Jobs run one at a time on a single background thread, so two requests queue
rather than fighting over GPU memory.
"""

import asyncio
import io
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .engines import Engine, JobCancelled, Part

# Finished jobs nobody collected are dropped after this long.
JOB_TTL_SECONDS = 15 * 60


class UIFiles(StaticFiles):
    """The built UI. index.html names the current build's hashed asset files, so it
    must be revalidated on every load; otherwise a rebuild leaves the browser
    requesting assets that no longer exist."""

    async def get_response(self, path: str, scope: Any) -> Response:
        response = await super().get_response(path, scope)
        if path in (".", "index.html"):
            response.headers["Cache-Control"] = "no-cache"
        return response


@dataclass
class Job:
    id: str
    created: float = field(default_factory=time.time)
    # (event name, payload) in order; the SSE stream replays from its own cursor.
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    parts: list[Part] = field(default_factory=list)
    sample_rate: int = 0
    cancelled: threading.Event = field(default_factory=threading.Event)
    finished: bool = False

    def emit(self, event: str, data: dict[str, Any]) -> None:
        self.events.append((event, data))


def create_app(engines: list[Engine], dist: Path | None) -> FastAPI:
    app = FastAPI(title="Song Surgeon engine server")
    # Only answer requests addressed to this machine by name. Blocks DNS-rebinding
    # attacks, where a web page tricks the browser into calling a local server.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])

    by_id = {e.id: e for e in engines}
    jobs: dict[str, Job] = {}
    runner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="engine")

    def expire_old_jobs() -> None:
        now = time.time()
        for job_id in [j.id for j in jobs.values() if now - j.created > JOB_TTL_SECONDS]:
            jobs[job_id].cancelled.set()
            del jobs[job_id]

    def run_job(job: Job, engine: Engine, audio: Any, sample_rate: int, options: dict[str, Any]) -> None:
        def progress(fraction: float, stage: str) -> None:
            if job.cancelled.is_set():
                raise JobCancelled()
            job.emit("progress", {"fraction": fraction, "stage": stage})

        try:
            progress(0.01, "Starting")
            job.parts = engine.separate(audio, sample_rate, options, progress)
            job.sample_rate = sample_rate
            job.emit(
                "done",
                {
                    "sampleRate": sample_rate,
                    "parts": [{"label": p.label, "kind": p.kind, "energy": p.energy} for p in job.parts],
                },
            )
        except JobCancelled:
            job.emit("error", {"message": "Cancelled"})
        except Exception as exc:  # surfaced to the UI rather than crashing the worker
            job.emit("error", {"message": f"{type(exc).__name__}: {exc}"})
        finally:
            job.finished = True

    @app.get("/api/engines")
    def list_engines() -> list[dict[str, Any]]:
        return [e.info() for e in engines]

    @app.post("/api/jobs", status_code=202)
    async def create_job(
        engine: str = Form(...),
        options: str = Form("{}"),
        audio: UploadFile = File(...),
    ) -> dict[str, str]:
        if engine not in by_id:
            raise HTTPException(404, f"Unknown engine {engine!r}")
        try:
            data, sample_rate = sf.read(io.BytesIO(await audio.read()), dtype="float32", always_2d=True)
        except Exception as exc:
            raise HTTPException(400, f"Could not read audio: {exc}") from exc
        try:
            opts = json.loads(options)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, "options must be JSON") from exc

        expire_old_jobs()
        job = Job(id=uuid.uuid4().hex)
        jobs[job.id] = job
        if any(not j.finished for j in jobs.values() if j is not job):
            job.emit("progress", {"fraction": 0.0, "stage": "Queued"})
        # soundfile gives (samples, channels); engines take (channels, samples).
        runner.submit(run_job, job, by_id[engine], data.T.copy(), int(sample_rate), opts)
        return {"id": job.id}

    def get_job(job_id: str) -> Job:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "No such job")
        return job

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str) -> StreamingResponse:
        job = get_job(job_id)

        async def stream():
            cursor = 0
            while True:
                while cursor < len(job.events):
                    event, data = job.events[cursor]
                    cursor += 1
                    yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
                    if event in ("done", "error"):
                        return
                # The engine runs on another thread; poll its event list.
                await asyncio.sleep(0.1)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/api/jobs/{job_id}/parts/{index}.wav")
    def job_part(job_id: str, index: int) -> Response:
        job = get_job(job_id)
        if not 0 <= index < len(job.parts):
            raise HTTPException(404, "No such part")
        buf = io.BytesIO()
        sf.write(buf, job.parts[index].audio.T, job.sample_rate, format="WAV", subtype="FLOAT")
        return Response(buf.getvalue(), media_type="audio/wav")

    @app.delete("/api/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str) -> None:
        job = jobs.pop(job_id, None)
        if job is not None:
            job.cancelled.set()

    if dist is not None and dist.is_dir():
        # Registered last so /api routes win; html=True serves index.html at "/".
        app.mount("/", UIFiles(directory=dist, html=True), name="ui")

    return app
