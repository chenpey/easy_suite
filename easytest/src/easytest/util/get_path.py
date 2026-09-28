from pathlib import Path


def find_dir_path(target=None) -> Path:
    """
    查找指定目录的路径，优先从当前工作目录向上查找，再检查安装包路径
    Args:
        target (str): 要查找的目录名称
    Returns:
        Path: 找到的目录路径
    Raises:
        FileNotFoundError: 当找不到指定目录时
    """
    if not target:
        raise ValueError("Target directory name cannot be None or empty")

    search_starts = (Path.cwd().resolve(), Path(__file__).resolve().parent)
    visited: set[Path] = set()
    for current_dir in search_starts:
        for parent in (current_dir, *current_dir.parents):
            if parent in visited:
                continue
            visited.add(parent)
            target_path = parent / target
            if target_path.is_dir():
                return target_path

    raise FileNotFoundError(f"Cannot find directory: {target}")


def get_path(directory_name: str, file_name: str = None, create=False) -> Path:
    """
    获取指定目录下指定文件的路径
    Args:
        directory_name (str): 目录名称
        file_name (str): 文件名（可以带扩展名，也可以不带），可选
        create (bool): 如果为True，在找不到文件的情况下创建新文件，默认为False
    Returns:
        Path: 文件的完整路径
    Raises:
        FileNotFoundError: 当找不到指定目录或文件时
        ValueError: 当参数无效时
    """
    # 参数验证
    if not directory_name or not isinstance(directory_name, str):
        raise ValueError("Directory name must be a non-empty string")

    # 如果没有提供文件名，直接返回目录路径
    if file_name is None:
        try:
            return find_dir_path(directory_name)
        except FileNotFoundError:
            if create:
                # 支持 'data/kline' 这类多段路径，相对根目录创建
                dir_path = get_root_path() / directory_name
                dir_path.mkdir(parents=True, exist_ok=True)
                return dir_path
            raise

    if not isinstance(file_name, str):
        raise ValueError("File name must be a string")

    try:
        dir_path = find_dir_path(directory_name)
    except FileNotFoundError as e:
        raise FileNotFoundError(f"Cannot find directory '{directory_name}': {e}")

    # 检查文件名是否已经包含扩展名
    if Path(file_name).suffix:
        # 如果文件名包含扩展名，直接查找
        file_path = dir_path / file_name
        if file_path.exists() and file_path.is_file():
            return file_path
    else:
        # 如果文件名不包含扩展名，尝试查找所有可能的扩展名
        matching_files = list(dir_path.glob(f"{file_name}.*"))
        if matching_files:
            # 如果找到多个匹配文件，返回第一个
            return matching_files[0]

    # 如果仍然找不到文件，尝试直接查找（不带扩展名的情况）
    file_path = dir_path / file_name
    if file_path.exists() and file_path.is_file():
        return file_path

    # 如果create参数为True，创建新文件
    if create:
        file_path.touch()
        return file_path

    # 如果create参数不为True，抛出错误
    else:
        raise FileNotFoundError(
            f"Cannot find file '{file_name}' in directory '{directory_name}' at '{dir_path}'"
        )


def get_root_path() -> Path:
    return Path.cwd().resolve()
