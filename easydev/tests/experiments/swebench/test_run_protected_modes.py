#!/usr/bin/env python3
"""Behavior contracts for the protected experiment paths.

Coverage gap: an interrupted run leaves dataset.json and task-baselines locked
at mode 0, so the next start must reopen them before reading anything. Recovery
must stay limited to those mode-0 markers, must fail loudly on a damaged
record, and a completed run must drop the record file. Because the record is
the only way back, protection that would hide the record itself is refused, and
so is a record entry that only resolves through `..`. A record path that is
already a symlink is refused as well: the write replaces the link, not the
file it points at.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from run import (
    lock_protected_paths,
    reject_record_inside_protected_paths,
    restore_protected_modes,
    run_experiment,
)


def write_dataset(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "instance_id": "task",
                    "FAIL_TO_PASS": json.dumps(["test_f2p"]),
                    "PASS_TO_PASS": json.dumps(["test_p2p"]),
                }
            ]
        ),
        encoding="utf-8",
    )


def mode_of(path: Path) -> int:
    return path.stat().st_mode & 0o777


class ProtectedModesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.experiment = Path(self.temporary.name)
        self.record = self.experiment / "protected-modes.json"
        self.dataset = self.experiment / "dataset.json"
        write_dataset(self.dataset)
        self.dataset.chmod(0o644)

    def write_record(self, payload: str) -> None:
        self.record.write_text(payload, encoding="utf-8")

    def chdir_to(self, path: Path) -> None:
        previous = os.getcwd()
        os.chdir(path)
        self.addCleanup(os.chdir, previous)

    def make_nested(self) -> tuple[Path, Path, Path]:
        private = self.experiment / "private"
        nested = private / "data"
        nested.mkdir(parents=True)
        locked = nested / "dataset.json"
        write_dataset(locked)
        private.chmod(0o755)
        nested.chmod(0o750)
        locked.chmod(0o640)
        return private, nested, locked

    def test_restores_paths_left_locked_by_interrupted_run(self) -> None:
        self.write_record(json.dumps({str(self.dataset): 0o644}))
        self.dataset.chmod(0)

        restore_protected_modes(self.record)

        self.assertEqual(mode_of(self.dataset), 0o644)

    def test_keeps_a_mode_the_user_tightened_after_interruption(self) -> None:
        self.write_record(json.dumps({str(self.dataset): 0o644}))
        self.dataset.chmod(0o600)

        restore_protected_modes(self.record)

        self.assertEqual(mode_of(self.dataset), 0o600)

    def test_missing_record_changes_nothing(self) -> None:
        self.dataset.chmod(0o640)

        restore_protected_modes(self.record)

        self.assertEqual(mode_of(self.dataset), 0o640)

    def test_damaged_record_fails_with_an_actionable_error(self) -> None:
        cases = {
            "invalid JSON": "{not json",
            "not an object": json.dumps([str(self.dataset)]),
            "non-integer mode": json.dumps({str(self.dataset): "0644"}),
            "out-of-range mode": json.dumps({str(self.dataset): 0o1000}),
        }
        for name, payload in cases.items():
            with self.subTest(name=name):
                self.write_record(payload)
                with self.assertRaises(RuntimeError) as context:
                    restore_protected_modes(self.record)
                self.assertIn("protected-modes.json", str(context.exception))
                self.assertIn("chmod", str(context.exception))
        self.assertEqual(mode_of(self.dataset), 0o644)

    def test_relative_protect_paths_are_recorded_as_absolute(self) -> None:
        self.chdir_to(self.experiment)
        self.dataset.chmod(0o640)

        with lock_protected_paths([Path("dataset.json")], self.record):
            recorded = json.loads(self.record.read_text(encoding="utf-8"))

        self.assertEqual(list(recorded), [str(self.dataset.resolve())])
        self.assertEqual(mode_of(self.dataset), 0o640)

    def test_relative_record_entry_is_rejected(self) -> None:
        self.write_record(json.dumps({"dataset.json": 0o644}))
        self.dataset.chmod(0)

        with self.assertRaises(RuntimeError) as context:
            restore_protected_modes(self.record)

        message = str(context.exception)
        self.assertIn("'dataset.json'", message)
        self.assertIn(str(self.record), message)
        self.assertIn("chmod", message)
        self.assertEqual(mode_of(self.dataset), 0)

    def test_ancestor_lock_covers_the_descendant(self) -> None:
        private, nested, locked = self.make_nested()

        with lock_protected_paths([nested, private], self.record):
            recorded = json.loads(self.record.read_text(encoding="utf-8"))
            self.assertEqual(list(recorded), [str(private.resolve())])
            self.assertEqual(mode_of(private), 0)

        self.assertEqual(mode_of(private), 0o755)
        self.assertEqual(mode_of(nested), 0o750)
        self.assertEqual(mode_of(locked), 0o640)

    def test_restore_reopens_ancestors_before_descendants(self) -> None:
        private, nested, locked = self.make_nested()
        # An old or hand-edited record can list the descendant first; recovering
        # it first cannot traverse the mode-0 ancestor.
        self.write_record(
            json.dumps({str(nested): 0o750, str(private): 0o755})
        )
        nested.chmod(0)
        private.chmod(0)

        restore_protected_modes(self.record)

        self.assertEqual(mode_of(private), 0o755)
        self.assertEqual(mode_of(nested), 0o750)
        self.assertEqual(mode_of(locked), 0o640)

    def assert_protection_refused(self, protected: Path) -> None:
        self.dataset.chmod(0o640)

        with self.assertRaises(RuntimeError) as context:
            with lock_protected_paths([protected], self.record):
                pass

        message = str(context.exception)
        self.assertIn(str(self.experiment.resolve()), message)
        self.assertIn(str(self.record.resolve()), message)
        self.assertIn("mode 0", message)
        self.assertIn("subpath", message)
        self.assertEqual(mode_of(self.dataset), 0o640)
        self.assertFalse(self.record.exists())

    def test_protecting_the_experiment_directory_is_refused(self) -> None:
        self.assert_protection_refused(self.experiment)

    def test_protecting_an_ancestor_of_the_experiment_is_refused(self) -> None:
        self.assert_protection_refused(self.experiment.parent)

    def test_protecting_a_symlink_to_the_experiment_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as aliases:
            alias = Path(aliases) / "experiment-link"
            alias.symlink_to(self.experiment)

            self.assert_protection_refused(alias)

    def test_protecting_a_subpath_of_the_experiment_is_allowed(self) -> None:
        baselines = self.experiment / "task-baselines"
        baselines.mkdir()
        baseline = baselines / "task.json"
        baseline.write_text("{}", encoding="utf-8")
        baseline.chmod(0o640)

        with lock_protected_paths([baselines], self.record):
            self.assertEqual(mode_of(baselines), 0)
            self.assertTrue(self.record.exists())

        self.assertEqual(mode_of(baselines), 0o755)
        self.assertEqual(mode_of(baseline), 0o640)
        self.assertFalse(self.record.exists())

    def make_outside_directory(self) -> Path:
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside)
        return outside

    def assert_symlinked_record_refused(self, protected: Path) -> None:
        """The record link survives untouched and no mode is changed."""
        target = self.make_outside_directory() / "external-protected-modes.json"
        target.write_text("{}\n", encoding="utf-8")
        target.chmod(0o640)
        self.record.symlink_to(target)

        self.assert_record_link_refused(protected, target)

        self.assertEqual(target.read_text(encoding="utf-8"), "{}\n")
        self.assertEqual(mode_of(target), 0o640)

    def assert_record_link_refused(self, protected: Path, target: Path) -> None:
        self.dataset.chmod(0o640)
        experiment_mode = mode_of(self.experiment)
        entries = sorted(entry.name for entry in self.experiment.iterdir())

        with self.assertRaises(RuntimeError) as context:
            with lock_protected_paths([protected], self.record):
                pass

        message = str(context.exception)
        self.assertIn(str(self.record), message)
        self.assertIn("symlink", message)
        self.assertIn("delete", message)
        self.assertTrue(self.record.is_symlink())
        self.assertEqual(os.readlink(self.record), str(target))
        self.assertEqual(mode_of(self.dataset), 0o640)
        self.assertEqual(mode_of(self.experiment), experiment_mode)
        self.assertEqual(
            sorted(entry.name for entry in self.experiment.iterdir()), entries
        )

    def test_symlinked_record_is_refused_when_protecting_the_experiment(
        self,
    ) -> None:
        # The link resolves outside the experiment, so a containment check that
        # follows it would let the write land inside the directory it protects.
        self.assert_symlinked_record_refused(self.experiment)

    def test_symlinked_record_is_refused_when_protecting_a_subpath(self) -> None:
        # The write would still replace the link itself, which the subpath does
        # not cover, so the leaf rule refuses it independently of containment.
        baselines = self.experiment / "task-baselines"
        baselines.mkdir()

        self.assert_symlinked_record_refused(baselines)

    def test_plain_record_path_still_protects_a_subpath(self) -> None:
        # Control for the cases above: the same tree without a link at the
        # record path locks, restores and cleans up as usual.
        baselines = self.experiment / "task-baselines"
        baselines.mkdir()
        baseline = baselines / "task.json"
        baseline.write_text("{}", encoding="utf-8")
        baseline.chmod(0o640)
        self.dataset.chmod(0o640)
        self.assertFalse(os.path.lexists(self.record))

        with lock_protected_paths([baselines], self.record):
            self.assertEqual(mode_of(baselines), 0)
            self.assertEqual(
                json.loads(self.record.read_text(encoding="utf-8")),
                {str(baselines.resolve()): 0o755},
            )

        self.assertEqual(mode_of(baselines), 0o755)
        self.assertEqual(mode_of(baseline), 0o640)
        self.assertFalse(os.path.lexists(self.record))

    def test_dangling_symlinked_record_is_refused(self) -> None:
        target = self.make_outside_directory() / "missing-protected-modes.json"
        self.record.symlink_to(target)

        self.assert_record_link_refused(self.experiment, target)

        self.assertFalse(target.exists())

    def test_containment_check_uses_the_landing_spot_of_a_symlinked_record(
        self,
    ) -> None:
        # The leaf rule refuses this path before the containment check runs, so
        # the landing spot needs its own contract: following the link would
        # place the record outside the protected directory and pass.
        target = self.make_outside_directory() / "external-protected-modes.json"
        target.write_text("{}\n", encoding="utf-8")
        self.record.symlink_to(target)

        with self.assertRaises(RuntimeError) as context:
            reject_record_inside_protected_paths(
                [self.experiment.resolve()], self.record
            )

        self.assertIn(str(self.experiment.resolve()), str(context.exception))
        self.assertTrue(self.record.is_symlink())
        self.assertEqual(target.read_text(encoding="utf-8"), "{}\n")

    def test_record_entry_with_a_parent_component_is_rejected(self) -> None:
        (self.experiment / "pad1" / "pad2").mkdir(parents=True)
        devious = (
            str(self.experiment / "pad1" / "pad2" / ".." / "..") + "/private"
        )
        # The valid entry is listed first; validation must finish for every
        # entry before any chmod, so it must still be at mode 0 afterwards.
        self.write_record(json.dumps({str(self.dataset): 0o644, devious: 0o755}))
        self.dataset.chmod(0)

        with self.assertRaises(RuntimeError) as context:
            restore_protected_modes(self.record)

        message = str(context.exception)
        self.assertIn(devious, message)
        self.assertIn(str(self.record), message)
        self.assertIn("chmod", message)
        self.assertEqual(mode_of(self.dataset), 0)

    def test_completed_run_restores_modes_and_drops_the_record(self) -> None:
        self.dataset.chmod(0o640)

        with lock_protected_paths([self.dataset], self.record):
            self.assertEqual(mode_of(self.dataset), 0)
            self.assertTrue(self.record.exists())

        self.assertEqual(mode_of(self.dataset), 0o640)
        self.assertFalse(self.record.exists())

    def test_failed_run_restores_modes_and_keeps_the_record(self) -> None:
        self.dataset.chmod(0o640)

        with self.assertRaises(SystemExit):
            with lock_protected_paths([self.dataset], self.record):
                raise SystemExit("run failures")

        self.assertEqual(mode_of(self.dataset), 0o640)
        self.assertTrue(self.record.exists())


class InterruptedRestartTest(unittest.TestCase):
    def make_directory(self) -> Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return Path(temporary.name)

    def test_restart_in_another_directory_recovers_the_recorded_paths(self) -> None:
        first = self.make_directory()
        second = self.make_directory()
        locked = first / "dataset.json"
        write_dataset(locked)
        locked.chmod(0o640)
        record = first / "protected-modes.json"
        decoy = second / "dataset.json"
        write_dataset(decoy)
        decoy.chmod(0o600)
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        # Simulate a run killed after locking: the context manager is entered
        # but never reaches its restore step, so only the record and the
        # mode-0 paths survive.
        os.chdir(first)
        locker = lock_protected_paths([Path("dataset.json")], record)
        locker.__enter__()
        try:
            self.assertEqual(mode_of(locked), 0)

            os.chdir(second)
            restore_protected_modes(record)
            os.chdir(first)

            self.assertEqual(mode_of(locked), 0o640)
            self.assertEqual(mode_of(decoy), 0o600)
        finally:
            # Close the suspended context manager from the locked directory so
            # its restore step still finds the paths it recorded.
            locker.gen.close()
            os.chdir(previous)

    def test_run_experiment_restores_locked_dataset_before_reading_it(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            experiment = Path(name)
            dataset = experiment / "dataset.json"
            write_dataset(dataset)
            dataset.chmod(0o644)
            record = experiment / "protected-modes.json"
            record.write_text(json.dumps({str(dataset): 0o644}), encoding="utf-8")
            (experiment / "task-baselines").mkdir()
            dataset.chmod(0)
            args = argparse.Namespace(experiment=experiment, tasks=["task"])

            with self.assertRaises(SystemExit) as context:
                run_experiment(args)

            self.assertIn("missing calibrated assets", str(context.exception))
            self.assertEqual(mode_of(dataset), 0o644)


if __name__ == "__main__":
    unittest.main()
