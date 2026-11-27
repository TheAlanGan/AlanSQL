"""Build a zip of DBCentral to copy to another PC.

    .venv\\Scripts\\python.exe tools\\make_dist.py              # dist\\DBCentral-<version>.zip, with offline packages
    .venv\\Scripts\\python.exe tools\\make_dist.py --no-wheels  # smaller zip; setup downloads the packages

The zip holds the app without the .venv folder. On the other PC, unzip it anywhere and run DBCentral.bat:
the first start creates a fresh .venv with that PC's Python (3.10 or newer). With the bundled "wheels"
folder, setup works offline for 64-bit Python 3.10-3.14.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["launch.py", "requirements.txt", "setup.bat", "DBCentral.bat", "README.md", "LICENSE"]
DIRS = ["dbcentral", "static", "tools"]
SKIP_DIRS = {"__pycache__", ".venv", "dist", "build", ".git", ".claude"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".log"}
PY_VERSIONS = ["3.10", "3.11", "3.12", "3.13", "3.14"]



def version():
    text = (ROOT / "dbcentral" / "__init__.py").read_text(encoding="utf-8")
    return re.search(r'__version__\s*=\s*"([^"]+)"', text).group(1)


def app_files():
    for name in FILES:
        yield ROOT / name
    for d in DIRS:
        for dirpath, dirnames, filenames in os.walk(ROOT / d):
            dirnames[:] = sorted(x for x in dirnames if x not in SKIP_DIRS)
            for f in sorted(filenames):
                p = Path(dirpath) / f
                if p.suffix.lower() not in SKIP_SUFFIXES:
                    yield p


def _pip_download(dest, v, *reqs):
    subprocess.run([sys.executable, "-m", "pip", "download", "--disable-pip-version-check", "-q", *reqs,
                    "-d", str(dest), "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp",
                    "--python-version", v], check=True)


def _missing(dest, v):
    """Dependencies that the target Python version needs but pip skipped.

    pip download evaluates environment markers (like python_version < "3.12") for the Python running it,
    not for --python-version, so packages that only older versions need would be left out."""
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name
    env = {"python_version": v, "python_full_version": v + ".0", "sys_platform": "win32", "os_name": "nt",
           "platform_system": "Windows", "platform_machine": "AMD64", "implementation_name": "cpython",
           "platform_python_implementation": "CPython", "extra": ""}
    have = {canonicalize_name(w.name.split("-")[0]) for w in dest.glob("*.whl")}
    need = set()
    for w in dest.glob("*.whl"):
        with zipfile.ZipFile(w) as z:
            meta = next((n for n in z.namelist() if n.endswith(".dist-info/METADATA")), None)
            text = z.read(meta).decode("utf-8", "replace") if meta else ""
        for line in text.splitlines():
            if not line.startswith("Requires-Dist:"):
                continue
            req = Requirement(line.split(":", 1)[1].strip())
            if req.marker is not None and not req.marker.evaluate(env):
                continue
            if canonicalize_name(req.name) not in have:
                need.add(f"{req.name}{req.specifier}")
    return sorted(need)


def download_wheels(dest):
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for v in PY_VERSIONS:
        print(f"Downloading packages for Python {v}...")
        _pip_download(dest, v, "-r", str(ROOT / "requirements.txt"))
        for _ in range(5):
            extra = _missing(dest, v)
            if not extra:
                break
            print(f"  plus {', '.join(extra)}")
            _pip_download(dest, v, *extra)
    return sorted(dest.iterdir())


def main():
    ap = argparse.ArgumentParser(description="Build a distributable DBCentral zip.")
    ap.add_argument("--no-wheels", action="store_true", help="don't bundle the Python packages for offline setup")
    ap.add_argument("--out", default=str(ROOT / "dist"), help="output folder (default: dist)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"DBCentral-{version()}"
    zip_path = out_dir / f"{name}.zip"
    wheels = [] if args.no_wheels else download_wheels(ROOT / "build" / "wheels")

    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in app_files():
            z.write(p, f"{name}/{p.relative_to(ROOT).as_posix()}")
            count += 1
        for w in wheels:
            z.write(w, f"{name}/wheels/{w.name}")
            count += 1
    size = zip_path.stat().st_size / 1024 / 1024
    print(f"Created {zip_path} ({count} files, {size:.1f} MB)")
    if wheels:
        shutil.rmtree(ROOT / "build", ignore_errors=True)


if __name__ == "__main__":
    main()
