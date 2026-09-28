from collections.abc import Iterable
from types import NotImplementedType
from typing import Any, Self


class DictObject(dict[Any, Any]):
    """支持点号访问和嵌套转换的 ``dict`` 子类。

    除嵌套 ``dict``/``list`` 会被转换外，构造、查询和更新语义遵循标准
    ``dict``。点号访问只适用于不与类属性或 ``dict`` 方法冲突的字符串键；
    任意键始终可以通过下标访问。
    """

    __slots__ = ()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """使用与标准 ``dict`` 相同的参数初始化，并转换嵌套容器。"""
        dict.__init__(self, *args, **kwargs)

        memo: dict[int, Any] = {}
        if len(args) == 1 and isinstance(args[0], dict):
            memo[id(args[0])] = self
        self._convert_values(memo)

    @classmethod
    def _new_empty(cls) -> Self:
        """不经过公开构造器创建空实例，供递归转换和浅复制使用。"""
        result = dict.__new__(cls)
        dict.__init__(result)
        return result

    def _convert_values(self, memo: dict[int, Any]) -> None:
        """原地转换值，替换值时不改变键集合和插入顺序。"""
        for key, value in dict.items(self):
            dict.__setitem__(self, key, self._convert(value, memo))

    def _convert(self, value: Any, memo: dict[int, Any]) -> Any:
        """转换嵌套 dict/list，并通过 memo 保留共享引用和循环引用。"""
        if value is None or isinstance(value, (str, int, float, bool, DictObject)):
            return value

        if isinstance(value, dict):
            obj_id = id(value)
            if obj_id in memo:
                return memo[obj_id]

            result = type(self)._new_empty()
            memo[obj_id] = result
            dict.__init__(result, value)
            result._convert_values(memo)
            return result

        if isinstance(value, list):
            obj_id = id(value)
            if obj_id in memo:
                return memo[obj_id]

            result: list[Any] = []
            memo[obj_id] = result
            result.extend(self._convert(item, memo) for item in value)
            return result

        return value

    def __getattr__(self, attr: str) -> Any:
        """读取同名键；键不存在时遵循属性协议抛出 ``AttributeError``。"""
        try:
            return dict.__getitem__(self, attr)
        except KeyError:
            raise AttributeError(
                f"'{type(self).__name__}' object has no attribute '{attr}'"
            ) from None

    def __setattr__(self, key: str, value: Any) -> None:
        """将点号赋值映射为字典项赋值。"""
        self[key] = value

    def __delattr__(self, attr: str) -> None:
        """删除同名键；键不存在时遵循属性协议抛出 ``AttributeError``。"""
        try:
            dict.__delitem__(self, attr)
        except KeyError:
            raise AttributeError(
                f"'{type(self).__name__}' object has no attribute '{attr}'"
            ) from None

    def __dir__(self) -> list[str]:
        """在标准属性列表中加入可通过属性语法表达的字符串键。"""
        return list(super().__dir__()) + [key for key in self if isinstance(key, str)]

    def __setitem__(self, key: Any, value: Any, /) -> None:
        """设置字典项，并转换新值中的嵌套容器。"""
        dict.__setitem__(self, key, self._convert(value, {}))

    def update(self, other: Any = (), /, **kwargs: Any) -> None:
        """按标准 ``dict.update`` 参数规则更新，并转换所有新值。"""
        if other is self:
            incoming = dict(kwargs)
            memo: dict[int, Any] = {id(self): self}
        else:
            incoming = dict(other)
            incoming.update(kwargs)
            memo = {id(other): self} if isinstance(other, dict) else {}

        for key, value in incoming.items():
            dict.__setitem__(self, key, self._convert(value, memo))

    def setdefault(self, key: Any, default: Any = None, /) -> Any:
        """返回已有值，或转换并插入默认值。"""
        try:
            return dict.__getitem__(self, key)
        except KeyError:
            converted = self._convert(default, {})
            dict.__setitem__(self, key, converted)
            return converted

    def copy(self) -> Self:
        """返回保持嵌套值引用不变的浅复制。"""
        result = type(self)._new_empty()
        dict.__init__(result, self)
        return result

    def __copy__(self) -> Self:
        return self.copy()

    @classmethod
    def fromkeys(cls, iterable: Iterable[Any], value: Any = None, /) -> Self:
        """创建新对象，并与 ``dict.fromkeys`` 一样让所有键共享同一个值。"""
        result = cls._new_empty()
        converted = result._convert(value, {})
        for key in iterable:
            dict.__setitem__(result, key, converted)
        return result

    def __ior__(self, other: Any) -> Self:
        self.update(other)
        return self

    def __or__(self, other: Any) -> Self | NotImplementedType:
        if not isinstance(other, dict):
            return NotImplemented
        result = self.copy()
        result.update(other)
        return result

    def __ror__(self, other: Any) -> Self | NotImplementedType:
        if not isinstance(other, dict):
            return NotImplemented
        result = type(self)(other)
        result.update(self)
        return result


def dict_to_obj(value: Any) -> Any:
    """将普通字典转换为 ``DictObject``，其他类型原样返回。"""
    if isinstance(value, DictObject):
        return value
    if isinstance(value, dict):
        return DictObject(value)
    return value


def obj_to_dict(obj: Any) -> Any:
    """递归转换为普通字典，并保留共享引用和循环引用。"""
    return _obj_to_dict(obj, {})


def _obj_to_dict(obj: Any, memo: dict[int, Any]) -> Any:
    if isinstance(obj, dict):
        obj_id = id(obj)
        if obj_id in memo:
            return memo[obj_id]

        result: dict[Any, Any] = {}
        memo[obj_id] = result
        result.update((key, _obj_to_dict(value, memo)) for key, value in obj.items())
        return result

    if isinstance(obj, list):
        obj_id = id(obj)
        if obj_id in memo:
            return memo[obj_id]

        result_list: list[Any] = []
        memo[obj_id] = result_list
        result_list.extend(_obj_to_dict(item, memo) for item in obj)
        return result_list

    return obj
