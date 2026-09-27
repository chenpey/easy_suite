from __future__ import annotations

import pytest

from easytest.snapshots.comparison import compare, format_differences


def test_compare_normalizes_ignored_fields_decimals_and_unordered_lists() -> None:
    rule = {
        "ignore_paths": ["$.rows[*].request_id"],
        "normalizers": [
            {"path": "$.rows[*].amount", "type": "decimal"},
        ],
        "unordered_lists": [
            {"path": "$.rows", "keys": ["type"]},
        ],
    }
    expected = {
        "rows": [
            {"type": "fee", "amount": "1.00", "request_id": "old-1"},
            {"type": "principal", "amount": "20.0", "request_id": "old-2"},
        ]
    }
    actual = {
        "rows": [
            {"type": "principal", "amount": 20, "request_id": "new-2"},
            {"type": "fee", "amount": "1", "request_id": "new-1"},
        ]
    }

    assert compare(expected, actual, rule).equal is True


def test_compare_reports_field_paths_and_missing_values() -> None:
    result = compare(
        {"body": {"status": "ACTIVE", "balance": "10"}},
        {"body": {"status": "CLOSED", "currency": "USD"}},
    )

    assert result.equal is False
    assert [item.path for item in result.differences] == [
        "$.body.balance",
        "$.body.currency",
        "$.body.status",
    ]
    message = format_differences(result)
    assert "$.body.status [changed]" in message
    assert "$.body.balance [missing_actual]" in message


def test_compare_supports_key_suffix_ignore_with_exclusions() -> None:
    result = compare(
        {"request_id": "old", "merchant_id": "merchant-1"},
        {"request_id": "new", "merchant_id": "merchant-2"},
        {
            "ignore_key_suffixes": ["_id"],
            "ignore_key_exclusions": ["merchant_id"],
        },
    )

    assert len(result.differences) == 1
    assert result.differences[0].path == "$.merchant_id"


@pytest.mark.parametrize(("expected", "actual"), [(True, 1), (False, 0)])
def test_boolean_to_number_is_a_difference(expected, actual) -> None:
    result = compare({"flag": expected}, {"flag": actual})

    assert result.equal is False
    assert result.differences[0].path == "$.flag"
    assert result.differences[0].category == "type_changed"


def test_difference_categories_and_json_types() -> None:
    result = compare(
        {"removed": None, "type": 1, "number": 1, "text": "a", "value": True},
        {"added": None, "type": "1", "number": 2, "text": "b", "value": False},
    )
    assert {d.path: d.category for d in result.differences} == {
        "$.added": "added",
        "$.removed": "removed",
        "$.type": "type_changed",
        "$.number": "number_changed",
        "$.text": "text_changed",
        "$.value": "value_changed",
    }
    added = result.as_dict()["differences"][0]
    assert (added["expected_type"], added["actual_type"]) == ("missing", "null")
    assert compare(1, 1.0).equal


def test_order_change_preserves_duplicates_and_respects_unordered_rule() -> None:
    before = {"rows": [{"n": 1}, {"n": 1}, {"n": 2}]}
    after = {"rows": [{"n": 2}, {"n": 1}, {"n": 1}]}
    result = compare(before, after)
    assert [(d.path, d.category) for d in result.differences] == [
        ("$.rows", "order_changed")
    ]
    assert compare(before, after, {"unordered_lists": [{"path": "$.rows"}]}).equal
    changed = compare([1, 1, 2], [1, 2, 2])
    assert [d.category for d in changed.differences] == ["number_changed"]
    assert compare([None, ""], ["", None], {"ignore_empty": True}).equal
