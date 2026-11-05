"""Entry point: `uv run song-surgeon` (from server/) starts the local engine server."""

import argparse
import os
from pathlib import Path

# Let PyTorch fall back to CPU for any op Apple's GPU backend lacks. Must be set
# before torch is imported.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# server/song_surgeon_server/__main__.py → repo root is two levels up.
DEFAULT_DIST = Path(__file__).resolve().parents[2] / "dist"


def main() -> None:
    parser = argparse.ArgumentParser(description="Song Surgeon local engine server")
    parser.add_argument("--port", type=int, default=8000)
    # Loopback only by default: the API runs heavy jobs on request, so it should
    # not be reachable from other machines on the network.
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST, help="built UI to serve (npm run build)")
    parser.add_argument("--device", choices=["cuda", "mps", "cpu"], help="override the auto-picked torch device")
    args = parser.parse_args()

    import uvicorn

    from .app import create_app
    from .engines import DemucsEngine, pick_device

    device = args.device or pick_device()
    dist = args.dist if (args.dist / "index.html").is_file() else None
    app = create_app([DemucsEngine(device)], dist)

    print(f"Song Surgeon engine server — device: {device}")
    if dist:
        print(f"Open http://localhost:{args.port}")
    else:
        print(f"No built UI at {args.dist} (run `npm run build`); serving the API only.")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
