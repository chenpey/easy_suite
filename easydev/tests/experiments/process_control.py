"""Wait for and stop agent process trees without relying on external tools."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import time
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


ProcessIdentity = Tuple[int, ...]


def _linux_snapshot() -> Dict[int, Tuple[int, ProcessIdentity]]:
    snapshot: Dict[int, Tuple[int, ProcessIdentity]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text(encoding="utf-8").rsplit(
                ") ", 1
            )[1].split()
            snapshot[int(entry.name)] = (int(fields[1]), (int(fields[19]),))
        except (IndexError, OSError, ValueError):
            continue
    return snapshot


class _DarwinProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


@lru_cache(maxsize=1)
def _darwin_library() -> ctypes.CDLL:
    library = ctypes.CDLL("libproc.dylib")
    library.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.proc_listallpids.restype = ctypes.c_int
    library.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    library.proc_pidinfo.restype = ctypes.c_int
    return library


def _darwin_snapshot() -> Dict[int, Tuple[int, ProcessIdentity]]:
    library = _darwin_library()
    count = library.proc_listallpids(None, 0)
    if count <= 0:
        raise RuntimeError("cannot enumerate processes with libproc")
    pids = (ctypes.c_int * count)()
    actual = library.proc_listallpids(pids, ctypes.sizeof(pids))
    if actual <= 0:
        raise RuntimeError("cannot enumerate processes with libproc")

    snapshot: Dict[int, Tuple[int, ProcessIdentity]] = {}
    for pid in pids[:actual]:
        info = _DarwinProcBsdInfo()
        size = library.proc_pidinfo(
            pid,
            3,  # PROC_PIDTBSDINFO
            0,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if size <= 0:
            continue
        snapshot[int(info.pbi_pid)] = (
            int(info.pbi_ppid),
            (int(info.pbi_start_tvsec), int(info.pbi_start_tvusec)),
        )
    return snapshot


def _process_snapshot() -> Dict[int, Tuple[int, ProcessIdentity]]:
    if os.name != "posix":
        return {}
    if Path("/proc/self/stat").exists():
        return _linux_snapshot()
    if os.uname().sysname == "Darwin":
        return _darwin_snapshot()
    raise RuntimeError("cannot enumerate processes on this POSIX host")


def _descendants(
    root_pids: Set[int],
    snapshot: Dict[int, Tuple[int, ProcessIdentity]],
) -> Dict[int, ProcessIdentity]:
    children: Dict[int, Set[int]] = {}
    for pid, (ppid, _) in snapshot.items():
        children.setdefault(ppid, set()).add(pid)
    found: Dict[int, ProcessIdentity] = {}
    pending = list(root_pids)
    while pending:
        parent = pending.pop()
        for child in children.get(parent, set()):
            if child in found:
                continue
            found[child] = snapshot[child][1]
            pending.append(child)
    return found


def wait_for_process(
    process: subprocess.Popen,
    timeout: float,
    *,
    poll_interval: float = 0.25,
) -> Tuple[Optional[int], Dict[int, ProcessIdentity]]:
    """Wait while retaining identities for descendants that later daemonize."""
    deadline = time.monotonic() + timeout
    tracked: Dict[int, ProcessIdentity] = {}
    while True:
        try:
            snapshot = _process_snapshot()
            root = snapshot.get(process.pid)
            if root is not None:
                tracked.setdefault(process.pid, root[1])
            for pid, identity in _descendants({process.pid}, snapshot).items():
                tracked.setdefault(pid, identity)
        except (OSError, RuntimeError):
            pass
        returncode = process.poll()
        if returncode is not None:
            return returncode, tracked
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, tracked
        time.sleep(min(poll_interval, remaining))


def _identity_alive(
    pid: int,
    identity: ProcessIdentity,
    snapshot: Dict[int, Tuple[int, ProcessIdentity]],
) -> bool:
    return snapshot.get(pid, (0, ()))[1] == identity


def _signal_pid(pid: int, sig: int) -> None:
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise RuntimeError(f"cannot signal process {pid}") from error


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise RuntimeError(f"cannot signal process group {pgid}") from error


def _signal_known(
    known: Dict[int, ProcessIdentity],
    sig: int,
) -> None:
    try:
        snapshot = _process_snapshot()
    except (OSError, RuntimeError):
        return
    for pid, identity in known.items():
        if _identity_alive(pid, identity, snapshot):
            _signal_pid(pid, sig)


def _reap_leader(process: subprocess.Popen, timeout: float) -> bool:
    if process.poll() is not None:
        return True
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return False
    return True


def terminate_process(
    process: subprocess.Popen,
    *,
    grace_seconds: float = 5.0,
    tracked: Optional[Dict[int, ProcessIdentity]] = None,
) -> None:
    """Terminate the direct child, its process group, and known descendants."""
    known = dict(tracked or {})
    root_identity = known.pop(process.pid, None)
    if os.name != "posix":
        if process.poll() is None:
            process.terminate()
            if not _reap_leader(process, grace_seconds):
                process.kill()
                if not _reap_leader(process, grace_seconds):
                    raise RuntimeError(
                        f"process {process.pid} did not terminate after signals"
                    )
        return

    try:
        snapshot = _process_snapshot()
        for pid, identity in _descendants({process.pid}, snapshot).items():
            known.setdefault(pid, identity)
    except (OSError, RuntimeError):
        snapshot = {}

    if root_identity is None:
        root_identity = snapshot.get(process.pid, (0, ()))[1]
    root_alive = bool(root_identity) and _identity_alive(
        process.pid,
        root_identity,
        snapshot,
    )
    if not snapshot:
        root_alive = process.poll() is None
    if root_alive:
        _signal_group(process.pid, signal.SIGTERM)
        _signal_pid(process.pid, signal.SIGTERM)
    _signal_known(known, signal.SIGTERM)

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        _reap_leader(process, 0.05)
        try:
            snapshot = _process_snapshot()
            for pid, identity in _descendants(
                set(known) | {process.pid},
                snapshot,
            ).items():
                known.setdefault(pid, identity)
        except (OSError, RuntimeError):
            snapshot = {}
        alive = {
            pid
            for pid, identity in known.items()
            if _identity_alive(pid, identity, snapshot)
        }
        if process.poll() is not None and not alive:
            return
        time.sleep(0.05)

    try:
        snapshot = _process_snapshot()
    except (OSError, RuntimeError):
        snapshot = {}
    if (
        snapshot
        and root_identity
        and _identity_alive(process.pid, root_identity, snapshot)
    ) or (not snapshot and process.poll() is None):
        _signal_group(process.pid, signal.SIGKILL)
        _signal_pid(process.pid, signal.SIGKILL)
    _signal_known(known, signal.SIGKILL)
    if not _reap_leader(process, grace_seconds):
        raise RuntimeError(
            f"process {process.pid} did not terminate after signals"
        )

    try:
        snapshot = _process_snapshot()
    except (OSError, RuntimeError):
        snapshot = {}
    alive: List[int] = [
        pid
        for pid, identity in known.items()
        if _identity_alive(pid, identity, snapshot)
    ]
    if not alive:
        return
    kill_deadline = time.monotonic() + grace_seconds
    while time.monotonic() < kill_deadline:
        try:
            snapshot = _process_snapshot()
        except (OSError, RuntimeError):
            snapshot = {}
        alive = [
            pid
            for pid, identity in known.items()
            if _identity_alive(pid, identity, snapshot)
        ]
        if not alive:
            return
        time.sleep(0.05)
    raise RuntimeError(f"descendant processes survived SIGKILL: {sorted(alive)}")
