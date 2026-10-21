#!/usr/bin/env python3
"""Fixed-patch re-verification for the public-contract-callers fixture.

The sequence is fixed and runs entirely in temporary directories:
initial probe is red, the repository check fails for the expected reason, the
reference patch turns both green, independent acceptance passes, every listed
pseudo-fix is rejected by that same acceptance, and no bytecode artifacts are
written.  Any deviation exits non-zero with the failing step.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List


HERE = Path(__file__).resolve().parent
INITIAL = HERE / "initial"
SOLUTION = HERE / "solution.patch"
ACCEPTANCE = HERE / "acceptance.py"


def run(
    step: str,
    args: List[str],
    cwd: Path,
    *,
    expect: int = 0,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        args,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=120,
    )
    if completed.returncode != expect:
        print(f"FAIL: {step}: exit {completed.returncode}, expected {expect}")
        print(completed.stdout)
        raise SystemExit(1)
    return completed


def python(step: str, script: Path, cwd: Path, *args: str, expect: int = 0):
    return run(
        step,
        [sys.executable, "-B", str(script), *args],
        cwd,
        expect=expect,
    )


IDENTITY_OMITTING_ORDERS = """from app.db import find_order


def get_order(order_id, current_user_id=None):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id is not None and order["owner_id"] != current_user_id:
        raise PermissionError("order is not owned by the current user")
    return order
"""
IDENTITY_OMITTING_API = """from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
"""
EXPORT_HELPER = """

def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
"""
EXPORT_ADMIN = """from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
"""
STRICT_API = """from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except (KeyError, PermissionError):
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
"""
MISSING_IDENTITY_LABELS = [
    "missing identity does not read order",
    "none identity does not read order",
    "missing request identity does not read order",
    "none request identity does not read order",
]
EMPTY_IDENTITY_LABELS = MISSING_IDENTITY_LABELS + [
    "empty identity does not read order",
    "empty request identity does not read order",
]

PSEUDO_FIXES = (
    {
        "name": "identity-omitting",
        "files": {
            "app/orders.py": IDENTITY_OMITTING_ORDERS,
            "app/api.py": IDENTITY_OMITTING_API,
        },
        "labels": MISSING_IDENTITY_LABELS,
    },
    {
        "name": "scalar-leak",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n"
                "_MISSING = object()\n\n\n"
                "def get_order(order_id, current_user_id=_MISSING):\n"
                "    order = find_order(order_id)\n"
                "    if current_user_id is _MISSING or current_user_id in (None, ''):\n"
                "        return order['total'] if order is not None else None\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": IDENTITY_OMITTING_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": EMPTY_IDENTITY_LABELS,
    },
    {
        "name": "transformed-leak",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id=None):\n"
                "    order = find_order(order_id)\n"
                "    if not current_user_id:\n"
                "        return {'total': order['total'] + 1} if order is not None else None\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": IDENTITY_OMITTING_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": EMPTY_IDENTITY_LABELS,
    },
    {
        "name": "text-leak",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id=None):\n"
                "    if not current_user_id:\n"
                "        return {'message': 'denied for o1 total 120'}\n"
                "    order = find_order(order_id)\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": IDENTITY_OMITTING_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": EMPTY_IDENTITY_LABELS,
    },
    {
        "name": "error-text-leak",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id=None):\n"
                "    order = find_order(order_id)\n"
                "    if current_user_id in (None, ''):\n"
                "        if order is None:\n"
                "            raise PermissionError('missing identity')\n"
                "        raise PermissionError(\n"
                "            f\"denied for {order['id']} owner {order['owner_id']} total {order['total']}\"\n"
                "        )\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": """from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError as error:
        return {"status": 403, "message": str(error)}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
""",
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": EMPTY_IDENTITY_LABELS,
    },
    {
        "name": "other-user-error-text-leak",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id):\n"
                "    order = find_order(order_id)\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError(repr(order))\n"
                + EXPORT_HELPER
            ),
            "app/api.py": STRICT_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": [
            "other user denied",
            "first user denied on second order",
            "dynamic other user denied",
            "previous owner denied after ownership change",
        ],
    },
    {
        "name": "admin-user-id",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id):\n"
                "    order = find_order(order_id)\n"
                "    if order is None:\n"
                "        return None\n"
                "    if current_user_id == 'admin' or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": STRICT_API,
            "app/admin.py": """from app.orders import get_order


def export_order(order_id, operator):
    return get_order(order_id, operator.get("role"))
""",
        },
        "labels": [
            "admin user_id is not owner in get_order",
            "admin user_id 403 in handle_show_order",
        ],
    },
    {
        "name": "hardcoded-u1",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id):\n"
                "    order = find_order(order_id)\n"
                "    if order is None:\n"
                "        return None\n"
                "    if current_user_id == 'u1':\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": STRICT_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": [
            "second owner reads own order",
            "first user denied on second order",
            "second owner 200",
            "first user 403 on second order",
        ],
    },
    {
        "name": "hardcoded-owner-map",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n"
                "OWNERS = {'o1': 'u1', 'o2': 'u2'}\n\n\n"
                "def get_order(order_id, current_user_id=None):\n"
                "    if not current_user_id:\n"
                "        raise PermissionError('missing identity')\n"
                "    if order_id not in OWNERS:\n"
                "        return None\n"
                "    if OWNERS[order_id] != current_user_id:\n"
                "        raise PermissionError('order is not owned by the current user')\n"
                "    return find_order(order_id)\n"
                + EXPORT_HELPER
            ),
            "app/api.py": IDENTITY_OMITTING_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": [
            "dynamic owner reads own order",
            "dynamic other user denied",
            "dynamic owner 200",
            "dynamic other user 403",
            "previous owner denied after ownership change",
        ],
    },
    {
        "name": "empty-identity",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id):\n"
                "    order = find_order(order_id)\n"
                "    if order is None:\n"
                "        return None\n"
                "    if current_user_id == '':\n"
                "        return order\n"
                "    if order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n"
                + EXPORT_HELPER
            ),
            "app/api.py": STRICT_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": [
            "empty identity does not read order",
            "empty request identity does not read order",
        ],
    },
    {
        "name": "missing-role-export",
        "files": {
            "app/orders.py": (
                "from app.db import find_order\n\n\n"
                "def get_order(order_id, current_user_id):\n"
                "    order = find_order(order_id)\n"
                "    if order is None or order['owner_id'] == current_user_id:\n"
                "        return order\n"
                "    raise PermissionError('order is not owned by the current user')\n\n\n"
                "def get_order_for_export(order_id, operator_role):\n"
                "    if operator_role and operator_role != 'admin':\n"
                "        raise PermissionError('export requires admin role')\n"
                "    return find_order(order_id)\n"
            ),
            "app/api.py": STRICT_API,
            "app/admin.py": EXPORT_ADMIN,
        },
        "labels": ["missing role export denied", "none role export denied"],
    },
)


def write_files(root: Path, files: Dict[str, str]) -> None:
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def expect_rejected(root: Path, name: str, files: Dict[str, str], labels: Iterable[str]) -> None:
    workspace = root / "bypass" / name
    shutil.copytree(INITIAL, workspace)
    write_files(workspace, files)
    completed = python(
        f"pseudo-fix {name}",
        ACCEPTANCE,
        workspace,
        str(workspace),
        expect=1,
    )
    for label in labels:
        if label not in completed.stdout:
            print(f"FAIL: pseudo-fix {name}: missing rejection label {label!r}")
            print(completed.stdout)
            raise SystemExit(1)
    print(f"== rejected: {name}")


def verify() -> None:
    root = Path(tempfile.mkdtemp(prefix="easydev-public-contract-"))
    try:
        workspace = root / "repo"
        shutil.copytree(INITIAL, workspace)
        run("git init", ["git", "init", "-q"], workspace)
        run("git config email", ["git", "config", "user.email", "fixture@example.com"], workspace)
        run("git config name", ["git", "config", "user.name", "fixture"], workspace)
        run("git config gpgsign", ["git", "config", "commit.gpgsign", "false"], workspace)
        run("git add", ["git", "add", "-A"], workspace)
        run("git commit", ["git", "commit", "-qm", "public contract initial"], workspace)

        print("== red: initial code returns 200 for another user")
        python("initial probe", workspace / "probe.py", workspace, "200")

        print("== red: repository contract check fails for the expected reason")
        red = python(
            "initial check_orders", workspace / "check_orders.py", workspace, expect=1
        )
        failure_lines = len(re.findall(r"^- ", red.stdout, re.MULTILINE))
        type_errors = red.stdout.count("got 'TypeError'")
        if failure_lines != 3 or type_errors != 3:
            print(
                "FAIL: initial check_orders: expected 3 TypeError failures, got "
                f"{failure_lines} failure lines and {type_errors} TypeErrors"
            )
            print(red.stdout)
            raise SystemExit(1)

        print("== apply reference patch")
        run("git apply", ["git", "apply", str(SOLUTION)], workspace)

        print("== green: fixed code returns 403 for another user")
        python("fixed probe", workspace / "probe.py", workspace, "403")
        green = python("fixed check_orders", workspace / "check_orders.py", workspace)
        if "PASS: 7/7" not in green.stdout:
            print("FAIL: fixed check_orders did not report the 7-check contract")
            print(green.stdout)
            raise SystemExit(1)

        print("== green: independent acceptance")
        accepted = python(
            "independent acceptance", ACCEPTANCE, workspace, str(workspace)
        )
        if not re.search(r"^PASS: \d+/\d+ independent acceptance checks$", accepted.stdout, re.MULTILINE):
            print("FAIL: independent acceptance did not report PASS")
            print(accepted.stdout)
            raise SystemExit(1)

        for pseudo_fix in PSEUDO_FIXES:
            expect_rejected(
                root,
                pseudo_fix["name"],
                pseudo_fix["files"],
                pseudo_fix["labels"],
            )

        leftovers = [
            path
            for path in root.rglob("*")
            if path.name == "__pycache__" or path.suffix == ".pyc"
        ]
        if leftovers:
            print(f"FAIL: bytecode artifacts were created: {leftovers[:5]}")
            raise SystemExit(1)
        print("== no __pycache__ or .pyc left behind")
        print(
            "PASS: fixed patch red/green, independent acceptance, "
            f"{len(PSEUDO_FIXES)} pseudo-fix rejections"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    verify()
