from pathlib import Path


def get_root_path(root: str | Path | None = None) -> Path:
    return Path.cwd().resolve() if root is None else Path(root).resolve()


def _under_root(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Path escapes configured root: {path}") from exc
    return resolved


def find_dir_path(target: str | Path | None = None, *, root: str | Path | None = None) -> Path:
    """Resolve one directory below an explicit project root without parent traversal."""
    if not target or not isinstance(target, (str, Path)):
        raise ValueError("Target directory name cannot be None or empty")
    base = get_root_path(root)
    target_path = _under_root(base / target, base)
    if target_path.is_dir():
        return target_path
    raise FileNotFoundError(f"Cannot find directory: {target}")


def get_path(
    directory_name: str,
    file_name: str | None = None,
    create: bool = False,
    *,
    root: str | Path | None = None,
) -> Path:
    """Resolve a file or directory relative to an explicit project root."""
    if not directory_name or not isinstance(directory_name, str):
        raise ValueError("Directory name must be a non-empty string")

    if file_name is None:
        try:
            return find_dir_path(directory_name, root=root)
        except FileNotFoundError:
            if create:
                base = get_root_path(root)
                dir_path = _under_root(base / directory_name, base)
                dir_path.mkdir(parents=True, exist_ok=True)
                return dir_path
            raise

    if not isinstance(file_name, str):
        raise ValueError("File name must be a string")

    try:
        dir_path = find_dir_path(directory_name, root=root)
    except FileNotFoundError as e:
        raise FileNotFoundError(f"Cannot find directory '{directory_name}': {e}")

    file_path = _under_root(dir_path / file_name, dir_path)
    if Path(file_name).suffix:
        if file_path.exists() and file_path.is_file():
            return file_path
    else:
        matching_files = sorted(dir_path.glob(f"{file_name}.*"))
        if matching_files:
            return matching_files[0]

    if file_path.exists() and file_path.is_file():
        return file_path

    if create:
        file_path.touch()
        return file_path
    raise FileNotFoundError(
        f"Cannot find file '{file_name}' in directory '{directory_name}' at '{dir_path}'"
    )
