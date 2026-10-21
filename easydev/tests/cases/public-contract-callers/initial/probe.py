#!/usr/bin/env python3
"""Print the status another user gets when reading order o1."""

import sys

from app.api import handle_show_order

expected = int(sys.argv[1])
status = handle_show_order({"user_id": "u2"}, "o1").get("status")
print(f"probe: u2 reads o1 -> {status} (expected {expected})")
raise SystemExit(0 if status == expected else 1)
