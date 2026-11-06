"""Windows desktop ACL, authorized reads, snapshots and clean shutdown contracts."""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from one_memory import file_imports
from one_memory.config import Settings
from one_memory.database_access import main_database
from one_memory.file_imports import (
    FileImportOperationUnavailable,
    FileImportStore,
    _read_private_record,
)
from one_memory.imports import access
from one_memory.imports.access import AuthorizedSourceRoot, SourceAccessError
from one_memory.imports.snapshots import SnapshotLimits, SnapshotMode, SourceSnapshotStore
from one_memory.imports.sqlite_access import open_sqlite_readonly
from one_memory.parent_watchdog import StopRequestWatchdog
from one_memory.runtime import CoreRuntime
from one_memory.windows_security import (
    assert_private_acl,
    assert_private_path,
    protect_private_path,
)
from tests.test_chat_exports import chatgpt_export

pytestmark = pytest.mark.contract
windows = pytest.mark.skipif(sys.platform != "win32", reason="native Windows required")
SID = "S-1-5-21-123-456-789-1001"


def _acl():
    return {
        "current_sid": SID,
        "owner_sid": SID,
        "reparse": False,
        "current_user_full_control": True,
        "rules": [{"sid": SID, "allow": True, "rights": 0x1F01FF}],
    }


def test_private_acl_validation_does_not_accept_other_account_access():
    assert_private_acl(_acl())
    for value in (
        None,
        {},
        _acl() | {"reparse": True},
        _acl() | {"rules": [None]},
        _acl() | {"rules": [{"sid": "S-1-1-0", "allow": True, "rights": 1}]},
        _acl() | {"rules": [{"sid": SID, "allow": False, "rights": 1}]},
    ):
        with pytest.raises(OSError):
            assert_private_acl(value)


def _grant(root: Path):
    return AuthorizedSourceRoot.grant(
        source_id="fixture", root=root, user_confirmed=True, home=root.parent / "other-home"
    )


def test_windows_open_algorithm_binds_the_authorized_file(tmp_path, monkeypatch):
    root = tmp_path / "source"
    root.mkdir()
    target = root / "history.jsonl"
    target.write_bytes(b"approved\n")
    source = _grant(root).authorize_file(Path(target.name))
    if sys.platform != "win32":

        def native_open(path, *, directory, follow_leaf=False):
            flags = os.O_RDONLY | (0 if follow_leaf else os.O_NOFOLLOW)
            if directory:
                flags |= os.O_DIRECTORY
            return os.open(path, flags)

        monkeypatch.setattr(access, "open_windows_path", native_open)
    with access._open_windows_relative_file(source) as stream:
        assert stream.read() == b"approved\n"
    target.rename(root / "old.jsonl")
    target.write_bytes(b"replaced\n")
    with pytest.raises(SourceAccessError):
        access._open_windows_relative_file(source)


@pytest.mark.parametrize("changed_path", [False, True])
def test_windows_private_record_compares_each_metadata_api_independently(
    tmp_path, monkeypatch, changed_path
):
    target = tmp_path / "credential"
    target.write_bytes(b"private")
    details = target.stat()
    values = {
        key: getattr(details, key)
        for key in (
            "st_dev",
            "st_ino",
            "st_size",
            "st_mode",
            "st_nlink",
            "st_uid",
            "st_mtime_ns",
            "st_ctime_ns",
        )
    }
    handle_info = SimpleNamespace(**(values | {"st_ctime_ns": details.st_ctime_ns + 1}))
    current = SimpleNamespace(**(values | {"st_ctime_ns": details.st_ctime_ns + int(changed_path)}))
    path = Mock(spec=Path)
    path.lstat.side_effect = [details, current]
    monkeypatch.setattr(file_imports, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        file_imports, "os", SimpleNamespace(**(vars(os) | {"fstat": lambda _: handle_info}))
    )
    monkeypatch.setattr(file_imports, "assert_private_path", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        file_imports, "open_windows_path", lambda *args, **kwargs: os.open(target, os.O_RDONLY)
    )
    if changed_path:
        with pytest.raises(ValueError, match="changed_import_operation_file"):
            _read_private_record(path)
    else:
        assert _read_private_record(path) == b"private"


@windows
def test_native_private_paths_and_root_refusal(tmp_path):
    directory = tmp_path / "memory \u6d4b\u8bd5"
    directory.mkdir()
    protect_private_path(directory, directory=True)
    token = directory / "credential"
    token.write_text("private", encoding="utf-8")
    protect_private_path(token, directory=False)
    assert_private_path(directory, directory=True)
    assert_private_path(token, directory=False)
    assert _read_private_record(token) == b"private"
    with pytest.raises(OSError, match="path_invalid"):
        protect_private_path(Path(directory.anchor), directory=True)


@windows
def test_native_authorized_reads_refuse_junctions_and_alternate_streams(tmp_path):
    root = tmp_path / "source"
    nested = root / "nested"
    nested.mkdir(parents=True)
    target = nested / "history.jsonl"
    target.write_bytes(b"approved\n")
    source = _grant(root).authorize_file(Path("nested/history.jsonl"))
    with source.open_binary() as stream:
        assert stream.read() == b"approved\n"
    moved = tmp_path / "outside"
    nested.rename(moved)
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(nested), str(moved)],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    try:
        with pytest.raises(SourceAccessError, match="symlink_not_allowed"):
            source.open_binary()
    finally:
        nested.rmdir()
    with pytest.raises(SourceAccessError, match="path_outside_root"):
        replace(source, relative_path=Path("history.jsonl:secret")).open_binary()


@windows
def test_native_sqlite_snapshot_does_not_write_the_host_wal_or_shm(tmp_path):
    private = tmp_path / "private"
    private.mkdir()
    protect_private_path(private, directory=True)
    root = tmp_path / "source"
    root.mkdir()
    database = root / "state.vscdb"
    writer = sqlite3.connect(database, autocommit=True)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE messages (body TEXT)")
        writer.execute("INSERT INTO messages VALUES ('approved')")
        originals = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.iterdir()
        }
        grant = _grant(root)
        with open_sqlite_readonly(grant.authorize_file(Path(database.name))) as connection:
            assert connection.execute("SELECT body FROM messages").fetchall()[0][0] == "approved"
        store = SourceSnapshotStore(private, limits=SnapshotLimits(min_free_bytes=0))
        snapshot = store.capture(
            snapshot_id="windows-snapshot",
            source_id="fixture",
            grant=grant,
            selection_id="windows:v1",
            suffix_modes={".vscdb": SnapshotMode.SQLITE_BACKUP},
            file_predicate=lambda _: True,
        )
        with sqlite3.connect(snapshot.root / database.name) as connection:
            assert connection.execute("SELECT body FROM messages").fetchall() == [("approved",)]
        assert originals == {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.iterdir()
        }
        reopened = store.reopen(
            snapshot_id="windows-snapshot",
            source_id="fixture",
            grant=grant,
            selection_id="windows:v1",
            suffix_modes={".vscdb": SnapshotMode.SQLITE_BACKUP},
        )
        with reopened.grant.authorize_file(Path(database.name)).open_binary() as stream:
            assert stream.read(16) == b"SQLite format 3\0"
    finally:
        writer.close()
        for path in private.rglob("*"):
            if path.is_file():
                path.chmod(0o600)


@windows
def test_native_file_import_keeps_operation_receipts_across_confirmation(tmp_path):
    store = FileImportStore(tmp_path / "imports")
    operation = str(uuid4())
    payload = json.dumps(chatgpt_export()).encode()
    try:
        receipt = store.prepare(payload, "chat.json", operation_id=operation)
    except FileImportOperationUnavailable as error:
        # This fixture is synthetic; expose its original error in native CI.
        raise error.__context__ or error from None
    assert receipt.state == "completed"
    assert receipt.upload_id is not None
    assert store.commit(receipt.upload_id).committed
    assert store.lookup_operation(operation).upload_state == "committed"


@windows
def test_native_database_backup_and_restore_flush_private_files(tmp_path):
    data = tmp_path / "memory \u6d4b\u8bd5"
    data.mkdir()
    protect_private_path(data, directory=True)
    database = main_database(data / "one-memory.sqlite3")
    backup = data / "backups" / "windows.sqlite3"
    try:
        with database.write() as connection:
            connection.execute("CREATE TABLE evidence (body TEXT)")
            connection.execute("INSERT INTO evidence VALUES ('approved')")
            connection.commit()
        database.back_up(backup)
        assert_private_path(backup, directory=False)
        with database.write() as connection:
            connection.execute("DELETE FROM evidence")
            connection.commit()
        database.restore_from(backup, required_tables=frozenset({"evidence"}))
        with database.read() as connection:
            assert connection.execute("SELECT body FROM evidence").fetchall() == [("approved",)]
    finally:
        database.close()


@windows
def test_native_runtime_token_and_shutdown_request_are_private_and_instance_bound(tmp_path):
    private = tmp_path / "data"
    settings = Settings(
        data_dir=private,
        host="127.0.0.1",
        port=28785,
        instance_id="windows-core",
    )
    with CoreRuntime(settings):
        assert_private_path(private / "runtime-token", directory=False)
        watcher = StopRequestWatchdog(private, settings.instance_id)
        watcher.path.write_text(
            json.dumps(
                {
                    "pid": watcher.pid,
                    "instance_id": "previous",
                }
            ),
            encoding="utf-8",
        )
        assert watcher.check_once() is False
        watcher.path.write_text(
            json.dumps(
                {
                    "pid": watcher.pid,
                    "instance_id": settings.instance_id,
                }
            ),
            encoding="utf-8",
        )
        assert watcher.check_once() is True
