from copy import copy

import pytest

from easytest.util.dict_obj import DictObject, dict_to_obj, obj_to_dict


def test_dict_object_converts_nested_data_and_round_trips() -> None:
    source = {"a": 1, "b": [{"c": 2}, {"d": [{"value": "old"}]}]}

    result = dict_to_obj(source)

    assert isinstance(result, DictObject)
    assert result.b[1].d[0].value == "old"
    result.b[1].d[0].value = "new"
    assert obj_to_dict(result) == {"a": 1, "b": [{"c": 2}, {"d": [{"value": "new"}]}]}


def test_dict_to_obj_leaves_other_values_and_existing_objects_unchanged() -> None:
    existing = DictObject(value=1)

    for value in ("hello", 42, [1, 2, 3], None, existing):
        assert dict_to_obj(value) is value


def test_dict_object_uses_standard_constructor_get_and_update_semantics() -> None:
    result = DictObject(default="value", max_depth={"nested": 1})

    assert result.default == "value"
    assert result.max_depth.nested == 1
    assert result.get("missing") is None
    assert result.get("missing", "fallback") == "fallback"

    with pytest.raises(TypeError):
        result.update({"a": 1}, {"b": 2})


def test_dict_object_supports_attribute_set_delete_and_missing_protocol() -> None:
    result = DictObject(temp="value")

    result.nested = {"value": 1}
    result._private = {"value": 2}
    del result.temp

    assert result.nested.value == 1
    assert result._private.value == 2
    assert not hasattr(result, "temp")
    assert getattr(result, "temp", "fallback") == "fallback"
    with pytest.raises(AttributeError):
        _ = result.temp


def test_mutating_dict_methods_convert_nested_values() -> None:
    result = DictObject()

    inserted = result.setdefault("from_default", {"value": 1})
    result |= {"from_union": {"value": 2}}
    result.update(from_update={"value": 3})

    assert inserted is result.from_default
    assert result.from_default.value == 1
    assert result.from_union.value == 2
    assert result.from_update.value == 3


def test_copy_is_shallow_and_union_preserves_dict_object() -> None:
    result = DictObject({"nested": {"value": 1}})

    copied = result.copy()
    protocol_copied = copy(result)
    merged = result | {"right": {"value": 2}}
    reverse_merged = {"left": {"value": 0}} | result

    assert isinstance(copied, DictObject)
    assert copied.nested is result.nested
    assert protocol_copied.nested is result.nested
    assert isinstance(merged, DictObject)
    assert merged.right.value == 2
    assert isinstance(reverse_merged, DictObject)
    assert reverse_merged.left.value == 0


def test_fromkeys_preserves_shared_default_reference() -> None:
    result = DictObject.fromkeys(["first", "second"], {"value": 1})

    assert isinstance(result.first, DictObject)
    assert result.first is result.second


def test_conversion_preserves_shared_and_circular_references() -> None:
    shared = {"value": 1}
    source = {"first": shared, "second": shared}
    source["self"] = source

    result = DictObject(source)
    plain = obj_to_dict(result)

    assert result.first is result.second
    assert result.self is result
    assert plain["first"] is plain["second"]
    assert plain["self"] is plain


def test_method_name_collisions_remain_available_by_item_access() -> None:
    result = DictObject({"items": 1, 2: "two"})

    assert callable(result.items)
    assert result["items"] == 1
    assert 2 in result
    assert isinstance(dir(result), list)
