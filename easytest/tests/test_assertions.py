import pytest

from easytest.runtime.assertions import assert_expectations


@pytest.mark.parametrize("actual,expected", [
    (1, True), (0, False), ({"ok": 1}, {"ok": True}),
    ([0], [False]), ({"items": [{"ok": 1}]}, {"items": [{"ok": True}]}),
    ("null", None), ("1", 1),
])
@pytest.mark.parametrize("operator", ["equals", "contains", "in"])
def test_assert_expectations_rejects_json_type_mismatch(actual, expected, operator):
    output = [actual] if operator == "contains" else actual
    wanted = [expected] if operator == "in" else expected
    with pytest.raises(AssertionError):
        assert_expectations(output, {"path": "$", operator: wanted})


@pytest.mark.parametrize("actual,expected", [
    (True, True), (False, False), (1, 1.0), ({"ok": True}, {"ok": True}),
    ([{"value": 1.0}], [{"value": 1}]), (None, None),
])
@pytest.mark.parametrize("operator", ["equals", "contains", "in"])
def test_assert_expectations_accepts_equal_json_values(actual, expected, operator):
    output = [actual] if operator == "contains" else actual
    wanted = [expected] if operator == "in" else expected
    assert_expectations(output, {"path": "$", operator: wanted})


def test_assert_expectations_preserves_string_and_object_membership():
    assert_expectations("hello world", {"path": "$", "contains": "world"})
    assert_expectations("hello", {"path": "$", "in": "hello world"})
    assert_expectations({"ok": 7}, {"path": "$", "contains": "ok"})
    assert_expectations("ok", {"path": "$", "in": {"ok": 7}})
