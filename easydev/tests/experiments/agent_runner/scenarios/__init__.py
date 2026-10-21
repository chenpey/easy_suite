"""Scenario registry for the behavior runner.

The registry is the single source for ``runner.py list`` and for the
``--scenario`` choices, so a scenario cannot be listed without being loadable.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Callable, Dict


Prepare = Callable[[Path, Path], None]
Evaluate = Callable[[Path, list, str, object], Dict[str, object]]
SCENARIO_MODULES = {
    "b01": "b01",
    "b02": "b02",
    "b16": "b16",
    "public-contract-callers": "public_contract_callers",
}


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    title: str
    prompt: str
    prepare: Prepare
    evaluate: Evaluate


def _module(scenario_id: str) -> ModuleType:
    module_name = SCENARIO_MODULES.get(scenario_id)
    if module_name is None:
        raise SystemExit(f"unknown scenario: {scenario_id}")
    return importlib.import_module(f"scenarios.{module_name}")


def load_scenario(scenario_id: str) -> Scenario:
    module = _module(scenario_id)
    return Scenario(
        scenario_id=scenario_id,
        title=module.TITLE,
        prompt=module.PROMPT,
        prepare=module.prepare,
        evaluate=module.evaluate,
    )


def all_scenarios() -> Dict[str, Scenario]:
    scenarios = {
        scenario_id: load_scenario(scenario_id)
        for scenario_id in SCENARIO_MODULES
    }
    for scenario_id, scenario in scenarios.items():
        if scenario.scenario_id != scenario_id:
            raise SystemExit(f"scenario id mismatch: {scenario_id}")
        if not scenario.title or not scenario.prompt:
            raise SystemExit(f"scenario {scenario_id} is missing title or prompt")
    return scenarios
