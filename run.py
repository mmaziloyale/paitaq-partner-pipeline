"""Start the Paitaq Partner Development Dashboard:  python run.py   then open http://localhost:8000

The website is pre-built (frontend/dist), so only Python is needed.
"""

import os
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if sys.version_info < (3, 10):
    sys.exit("Python 3.10 or newer is needed.")
try:
    import uvicorn  # noqa: F401
    import pydantic_ai  # noqa: F401
    import multipart  # noqa: F401
except ImportError:
    sys.exit("Packages are missing. Run:  pip install -r requirements.txt")

os.chdir(ROOT / "backend")
sys.path.insert(0, str(ROOT / "backend"))
PORT = int(os.getenv("PORT", "8000"))

if __name__ == "__main__":
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    print(f"\n  Paitaq Partner Development Dashboard -> http://localhost:{PORT}   (Ctrl+C to stop)\n")
    uvicorn.run("main:app", host="127.0.0.1", port=PORT, log_level="info")
