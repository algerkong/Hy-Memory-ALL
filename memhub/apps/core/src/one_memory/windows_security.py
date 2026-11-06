"""Current-user NTFS permissions. chmod alone cannot protect a Windows token."""

import ctypes
import os
import re
import sys
from contextlib import ExitStack
from functools import lru_cache
from pathlib import Path
from typing import Any

from one_memory.windows_files import is_reparse_point, open_windows_path

_SYSTEM_SID = "S-1-5-18"
_ADMINISTRATORS_SID = "S-1-5-32-544"
_FULL_CONTROL = 0x1F01FF


def assert_private_acl(value: object) -> None:
    if not isinstance(value, dict):
        raise OSError("private_storage_unsafe")
    sid = value.get("current_sid")
    rules = value.get("rules")
    if (
        not isinstance(sid, str)
        or re.fullmatch(r"S-1-\d+(?:-\d+)+", sid) is None
        or value.get("owner_sid") not in (sid, _SYSTEM_SID, _ADMINISTRATORS_SID)
        or value.get("reparse") is not False
        or value.get("current_user_full_control") is not True
        or not isinstance(rules, list)
        or not rules
    ):
        raise OSError("private_storage_unsafe")
    for rule in rules:
        if (
            not isinstance(rule, dict)
            or not isinstance(rule.get("sid"), str)
            or not isinstance(rule.get("allow"), bool)
            or type(rule.get("rights")) is not int
            or rule["rights"] < 0
            or (not rule["allow"] and rule["rights"] != 0)
            or (
                rule["allow"]
                and rule["rights"] != 0
                and rule["sid"] not in (sid, _SYSTEM_SID, _ADMINISTRATORS_SID)
            )
        ):
            raise OSError("private_storage_unsafe")


def protect_private_path(target: Path, *, directory: bool) -> None:
    if sys.platform == "win32":
        _check_path(target, directory=directory, protect=True)


def assert_private_path(target: Path, *, directory: bool, allow_hardlinks: bool = False) -> None:
    if sys.platform == "win32":
        _check_path(target, directory=directory, protect=False, allow_hardlinks=allow_hardlinks)


def _check_path(
    target: Path, *, directory: bool, protect: bool, allow_hardlinks: bool = False
) -> None:
    if (
        not target.is_absolute()
        or any(c in str(target) for c in "\0\r\n")
        or (protect and target == Path(target.anchor))
    ):
        raise OSError("private_storage_path_invalid")
    before = target.lstat()
    if (not target.is_dir() if directory else not target.is_file()) or (
        not directory and not allow_hardlinks and before.st_nlink != 1
    ):
        raise OSError("private_storage_unsafe")
    with ExitStack() as pins:
        for component in (*reversed(target.parents), target):
            if is_reparse_point(component.lstat()):
                raise OSError("private_storage_reparse_point")
            descriptor = open_windows_path(component, directory=component != target or directory)
            pins.callback(os.close, descriptor)
            if component == target:
                opened = os.fstat(descriptor)
                if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                    raise OSError("private_storage_changed")
        api = _windows_api()
        if protect:
            owner = api.inspect(target)["owner_sid"]
            if owner not in (api.current_sid, _SYSTEM_SID, _ADMINISTRATORS_SID):
                raise OSError("private_storage_unsafe")
            api.protect(target, directory=directory)
        assert_private_acl(api.inspect(target))
        after = target.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise OSError("private_storage_changed")


@lru_cache(maxsize=1)
def _windows_api() -> "_WindowsAclApi":
    return _WindowsAclApi()


class _WindowsAclApi:
    """Use the documented Win32 security APIs without spawning a shell."""

    def __init__(self) -> None:
        from ctypes import wintypes

        self.security: Any = ctypes.WinDLL("advapi32", use_last_error=True)  # type: ignore[attr-defined]
        self.kernel: Any = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        pointer = ctypes.c_void_p
        pointer_out = ctypes.POINTER(pointer)
        self.kernel.LocalFree.argtypes = (pointer,)
        self.kernel.LocalFree.restype = pointer
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.security.OpenProcessToken.argtypes = (
            wintypes.HANDLE,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.HANDLE),
        )
        self.security.OpenProcessToken.restype = wintypes.BOOL
        self.security.GetTokenInformation.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            pointer,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        )
        self.security.GetTokenInformation.restype = wintypes.BOOL
        self.security.GetNamedSecurityInfoW.argtypes = (
            wintypes.LPWSTR,
            ctypes.c_int,
            wintypes.DWORD,
            pointer_out,
            pointer_out,
            pointer_out,
            pointer_out,
            pointer_out,
        )
        self.security.GetNamedSecurityInfoW.restype = wintypes.DWORD
        self.security.SetNamedSecurityInfoW.argtypes = (
            wintypes.LPWSTR,
            ctypes.c_int,
            wintypes.DWORD,
            pointer,
            pointer,
            pointer,
            pointer,
        )
        self.security.SetNamedSecurityInfoW.restype = wintypes.DWORD
        self.security.ConvertSidToStringSidW.argtypes = (pointer, ctypes.POINTER(wintypes.LPWSTR))
        self.security.ConvertSidToStringSidW.restype = wintypes.BOOL
        self.security.GetAce.argtypes = (pointer, wintypes.DWORD, pointer_out)
        self.security.GetAce.restype = wintypes.BOOL
        self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (
            wintypes.LPCWSTR,
            wintypes.DWORD,
            pointer_out,
            ctypes.POINTER(wintypes.DWORD),
        )
        self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
        self.security.GetSecurityDescriptorOwner.argtypes = (
            pointer,
            pointer_out,
            ctypes.POINTER(wintypes.BOOL),
        )
        self.security.GetSecurityDescriptorOwner.restype = wintypes.BOOL
        self.security.GetSecurityDescriptorDacl.argtypes = (
            pointer,
            ctypes.POINTER(wintypes.BOOL),
            pointer_out,
            ctypes.POINTER(wintypes.BOOL),
        )
        self.security.GetSecurityDescriptorDacl.restype = wintypes.BOOL
        token = wintypes.HANDLE()
        if not self.security.OpenProcessToken(
            self.kernel.GetCurrentProcess(), 0x8, ctypes.byref(token)
        ):
            raise OSError("private_storage_sid_unavailable")
        try:
            size = wintypes.DWORD()
            self.security.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            if not 0 < size.value <= 65536:
                raise OSError("private_storage_sid_unavailable")
            buffer = ctypes.create_string_buffer(size.value)
            if not self.security.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
                raise OSError("private_storage_sid_unavailable")
            sid = ctypes.cast(buffer, ctypes.POINTER(pointer)).contents
            self.current_sid = self._sid_string(sid)
        finally:
            self.kernel.CloseHandle(token)

    def _sid_string(self, sid: ctypes.c_void_p) -> str:
        text = ctypes.c_wchar_p()
        if not self.security.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise OSError("private_storage_sid_unavailable")
        try:
            if text.value is None:
                raise OSError("private_storage_sid_unavailable")
            return text.value
        finally:
            self.kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    def inspect(self, target: Path) -> dict[str, object]:
        owner, acl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        status = self.security.GetNamedSecurityInfoW(
            str(target),
            1,
            0x5,
            ctypes.byref(owner),
            None,
            ctypes.byref(acl),
            None,
            ctypes.byref(descriptor),
        )
        if status != 0 or not descriptor.value:
            raise OSError("private_storage_acl_unavailable")
        try:
            if not acl.value:
                raise OSError("private_storage_unsafe")
            # ACL header's AceCount is a WORD at offset 4. Standard allow/deny
            # ACEs hold AccessMask at offset 4 and the SID at offset 8.
            count = ctypes.c_ushort.from_address(acl.value + 4).value
            rules: list[dict[str, object]] = []
            full_control = False
            for index in range(count):
                ace = ctypes.c_void_p()
                if not self.security.GetAce(acl, index, ctypes.byref(ace)) or not ace.value:
                    raise OSError("private_storage_acl_unavailable")
                kind = ctypes.c_ubyte.from_address(ace.value).value
                flags = ctypes.c_ubyte.from_address(ace.value + 1).value
                size = ctypes.c_ushort.from_address(ace.value + 2).value
                if kind not in (0, 1) or size < 16:
                    raise OSError("private_storage_unsafe")
                rights = ctypes.c_uint32.from_address(ace.value + 4).value
                sid = self._sid_string(ctypes.c_void_p(ace.value + 8))
                allowed = kind == 0
                rules.append({"sid": sid, "allow": allowed, "rights": rights})
                full_control |= (
                    allowed
                    and not flags & 0x8  # INHERIT_ONLY_ACE does not authorize this node.
                    and sid == self.current_sid
                    and rights & _FULL_CONTROL == _FULL_CONTROL
                )
            return {
                "current_sid": self.current_sid,
                "owner_sid": self._sid_string(owner),
                "reparse": False,
                "current_user_full_control": full_control,
                "rules": rules,
            }
        finally:
            self.kernel.LocalFree(descriptor)

    def protect(self, target: Path, *, directory: bool) -> None:
        flags = "OICI" if directory else ""
        sddl = f"O:{self.current_sid}D:P(A;{flags};FA;;;{self.current_sid})(A;{flags};FA;;;SY)"
        descriptor = ctypes.c_void_p()
        if not self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, 1, ctypes.byref(descriptor), None
        ):
            raise OSError("private_storage_acl_unavailable")
        try:
            owner, acl = ctypes.c_void_p(), ctypes.c_void_p()
            present, defaulted = ctypes.c_int(), ctypes.c_int()
            if not self.security.GetSecurityDescriptorOwner(
                descriptor, ctypes.byref(owner), ctypes.byref(defaulted)
            ) or not self.security.GetSecurityDescriptorDacl(
                descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)
            ):
                raise OSError("private_storage_acl_unavailable")
            if (
                self.security.SetNamedSecurityInfoW(
                    str(target), 1, 0x80000005, owner, None, acl, None
                )
                != 0
            ):
                raise OSError("private_storage_acl_unavailable")
        finally:
            self.kernel.LocalFree(descriptor)
