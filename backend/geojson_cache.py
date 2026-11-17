"""
Pre-compressed, validator-carrying delivery of large GeoJSON files.

The MTG hexagon files are 49-176 MB. Compressing them per request (GZipMiddleware) burns CPU for
every load and, with `Cache-Control: no-store`, the browser could never reuse its copy. Here the
gzip representation is built once per (path, mtime, size) into a dedicated cache directory and
served as is; ETag / Last-Modified let the browser revalidate with a 304.

The cache holds byte-for-byte compressed copies of files the route would serve anyway, keyed by the
source file -- never by session -- so it cannot hand one session something the route would not.

Cache directory: $SWARM_GEOJSON_CACHE_DIR, default <system temp dir>/swarm-geojson-cache. It is
created on demand; if it cannot be written, ensure_gzip() returns None and the caller serves the
plain file (GZipMiddleware then compresses on the fly, as before).
"""

import gzip
import hashlib
import os
import shutil
import tempfile
import threading
import uuid
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from typing import Dict, Optional, Tuple

GZIP_LEVEL = int(os.environ.get("SWARM_GEOJSON_GZIP_LEVEL", "6"))
_CHUNK = 1024 * 1024

_build_locks: Dict[str, threading.Lock] = {}
_build_locks_guard = threading.Lock()


def cache_dir() -> Path:
    return Path(os.environ.get("SWARM_GEOJSON_CACHE_DIR") or Path(tempfile.gettempdir()) / "swarm-geojson-cache")


def source_signature(src: Path) -> Tuple[str, int, int]:
    """(absolute path, mtime_ns, size) of the source file."""
    st = src.stat()
    return str(src.resolve()), st.st_mtime_ns, st.st_size


def etag_for(src: Path, gzipped: bool) -> str:
    """Strong validator for one representation. The gzip and identity bodies differ, so they get
    different ETags (the response also carries `Vary: Accept-Encoding`)."""
    path, mtime_ns, size = source_signature(src)
    digest = hashlib.sha256(f"{path}|{mtime_ns}|{size}".encode()).hexdigest()[:24]
    return f'"{digest}-gz"' if gzipped else f'"{digest}"'


def last_modified_for(src: Path) -> str:
    return formatdate(src.stat().st_mtime, usegmt=True)


def _lock_for(key: str) -> threading.Lock:
    with _build_locks_guard:
        return _build_locks.setdefault(key, threading.Lock())


def ensure_gzip(src: Path) -> Optional[Path]:
    """Path of the gzip copy of `src`, building it if needed; None if that is not possible.
    Blocking (reads and compresses the file): call from a worker thread."""
    try:
        path, mtime_ns, size = source_signature(src)
        path_hash = hashlib.sha256(path.encode()).hexdigest()[:16]
        target_dir = cache_dir()
        target = target_dir / f"{path_hash}-{mtime_ns}-{size}.geojson.gz"
        if target.is_file():
            return target

        target_dir.mkdir(parents=True, exist_ok=True)
        with _lock_for(path_hash):
            if target.is_file():  # built by a concurrent request while we waited
                return target
            tmp = target_dir / f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
            try:
                # Streamed: one chunk in memory at a time, never the whole 176 MB body
                with open(src, "rb") as fin, open(tmp, "wb") as raw_out:
                    with gzip.GzipFile(fileobj=raw_out, mode="wb", compresslevel=GZIP_LEVEL, mtime=0) as gz:
                        shutil.copyfileobj(fin, gz, _CHUNK)
                # The source may have been rewritten while we read it: do not publish a copy that
                # no longer matches its key
                if source_signature(src) != (path, mtime_ns, size):
                    return None
                os.replace(tmp, target)  # atomic: readers see the old state or the complete file
            finally:
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass
            _drop_stale(target_dir, path_hash, target.name)
        return target
    except Exception as e:  # unwritable dir, disk full, file vanished ...
        print(f"[geojson_cache] cannot build gzip copy of {src}: {type(e).__name__}: {e}")
        return None


def _drop_stale(target_dir: Path, path_hash: str, keep: str) -> None:
    """Remove superseded copies of the same source file (other mtime/size)."""
    try:
        for entry in target_dir.iterdir():
            if entry.name.startswith(f"{path_hash}-") and entry.name != keep and entry.name.endswith(".geojson.gz"):
                entry.unlink(missing_ok=True)
    except OSError:
        pass


def _etag_matches(header: str, etag: str) -> bool:
    if header.strip() == "*":
        return True
    weak_free = etag[2:] if etag.startswith("W/") else etag
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate.startswith("W/"):  # weak comparison is what If-None-Match uses
            candidate = candidate[2:]
        if candidate == weak_free:
            return True
    return False


def is_not_modified(if_none_match: Optional[str], if_modified_since: Optional[str], etag: str, mtime: float) -> bool:
    """RFC 9110 precedence: If-None-Match wins; If-Modified-Since is only consulted without it."""
    if if_none_match:
        return _etag_matches(if_none_match, etag)
    if if_modified_since:
        try:
            since = parsedate_to_datetime(if_modified_since).timestamp()
        except (TypeError, ValueError):
            return False
        return int(mtime) <= since
    return False


def accepts_gzip(accept_encoding: Optional[str]) -> bool:
    if not accept_encoding:
        return False
    for part in accept_encoding.split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() in ("gzip", "x-gzip", "*"):
            q = params.replace(" ", "").lower()
            return q not in ("q=0", "q=0.0", "q=0.00", "q=0.000")
    return False
