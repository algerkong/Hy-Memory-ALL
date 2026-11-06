"""No-follow Windows reads with handles that prevent namespace replacement."""

import ctypes
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


class WindowsReparsePointError(OSError):
    pass


def is_reparse_point(details: os.stat_result) -> bool:
    return bool(getattr(details, "st_file_attributes", 0) & 0x400)


def open_windows_path(target: Path, *, directory: bool, follow_leaf: bool = False) -> int:
    """Transfer a Win32 disk handle to a Python descriptor.

    Callers pin ancestor directories before opening descendants. Omitting
    FILE_SHARE_DELETE prevents those names being moved while the read opens.
    Only an explicitly approved root alias may use follow_leaf.
    """
    if not target.is_absolute() or any(c in str(target) for c in "\0\r\n"):
        raise OSError("windows_file_path_invalid")
    return _windows_api().open(target, directory=directory, follow_leaf=follow_leaf)


@lru_cache(maxsize=1)
def _windows_api() -> "_WindowsFileApi":
    return _WindowsFileApi()


class _WindowsFileApi:
    def __init__(self) -> None:
        from ctypes import wintypes

        self.kernel: Any = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        self.kernel.CreateFileW.argtypes = (
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        )
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.GetFileInformationByHandleEx.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        )
        self.kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        self.kernel.GetFileType.argtypes = (wintypes.HANDLE,)
        self.kernel.GetFileType.restype = wintypes.DWORD
        self.kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def open(self, target: Path, *, directory: bool, follow_leaf: bool) -> int:
        import msvcrt

        value = str(target)
        if not value.startswith("\\\\?\\"):
            value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
        flags = (0x02000000 if directory else 0) | (0 if follow_leaf else 0x00200000)
        handle = self.kernel.CreateFileW(
            value,
            0x80 if directory else 0x80000000,
            0x3,
            None,
            3,
            flags,
            None,
        )
        if handle is None or handle == ctypes.c_void_p(-1).value:
            raise OSError("windows_file_unavailable")
        try:
            # FileAttributeTagInfo contains two DWORDs: attributes and reparse tag.
            attributes = (ctypes.c_uint32 * 2)()
            if not self.kernel.GetFileInformationByHandleEx(
                handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)
            ):
                raise OSError("windows_file_unavailable")
            if attributes[0] & 0x400:
                raise WindowsReparsePointError("windows_file_reparse_point")
            if bool(attributes[0] & 0x10) != directory or self.kernel.GetFileType(handle) != 1:
                raise OSError("windows_file_kind_invalid")
            open_handle = getattr(msvcrt, "open_osfhandle", None)
            binary_flag = getattr(os, "O_BINARY", None)
            if not callable(open_handle) or not isinstance(binary_flag, int):
                raise OSError("windows_file_api_unavailable")
            descriptor = int(open_handle(handle, os.O_RDONLY | binary_flag))
            handle = None
            return descriptor
        finally:
            if handle is not None:
                self.kernel.CloseHandle(handle)
