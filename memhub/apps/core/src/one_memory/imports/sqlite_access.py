import hashlib
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

from one_memory.imports.access import (
    AuthorizedSourceFile,
    SourceAccessError,
    SourceAccessErrorCode,
    _changed_ns,
    _same_file,
)
from one_memory.windows_files import is_reparse_point
from one_memory.windows_security import protect_private_path


@contextmanager
def open_sqlite_readonly(
    source_file: AuthorizedSourceFile,
    *,
    timeout: float = 5.0,
) -> Iterator[sqlite3.Connection]:
    if sys.platform == "win32":
        with _open_windows_sqlite_readonly(source_file, timeout) as connection:
            yield connection
        return
    # Keep a no-follow descriptor open while SQLite uses the same validated path.
    # Percent-encode "%" so SQLite's URI parser cannot turn a literal filename
    # such as "%2e%2e%2fsecret.db" into path traversal.
    with source_file.open_binary() as source:
        encoded_path = quote(source_file.path.as_posix(), safe="/:")
        wal = source_file.path.with_name(source_file.path.name + "-wal")
        # A plain mode=ro open updates the host's -shm even when only reading.
        # Read the main file plus committed WAL bytes from a private mirror so
        # the host database and its shared-memory file stay byte-for-byte
        # untouched. A missing WAL is a normal single-file snapshot.
        if os.path.lexists(wal):
            with tempfile.TemporaryDirectory(prefix="one-memory-sqlite-read-") as directory:
                mirror = Path(directory) / "store.db"
                with mirror.open("wb") as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                _copy_sidecar(wal, mirror.with_name(mirror.name + "-wal"))
                # Apply the copied WAL to the private mirror before exposing a
                # cursor. Reading a live WAL directly can observe only the
                # first committed frame under load; checkpointing the copy is
                # safe and gives the parser one stable database image without
                # ever opening or modifying the host's -shm file.
                connection = sqlite3.connect(
                    mirror,
                    timeout=timeout,
                    # The async bridge serializes batches from one iterator,
                    # but its bounded shared pool may resume that iterator on
                    # another worker thread. No two threads use this private
                    # read snapshot concurrently.
                    check_same_thread=False,
                )
                connection.row_factory = sqlite3.Row
                try:
                    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    connection.execute("PRAGMA query_only = ON")
                    yield connection
                finally:
                    connection.close()
            return
        connection = sqlite3.connect(
            f"file:{encoded_path}?mode=ro",
            uri=True,
            timeout=timeout,
            # See the private-WAL branch above: iterator batches are serial,
            # though the reusable reader pool does not promise thread affinity.
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        try:
            try:
                details = os.lstat(source_file.path)
            except OSError:
                raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE) from None
            if (
                stat.S_ISLNK(details.st_mode)
                or not stat.S_ISREG(details.st_mode)
                or not _same_file(
                    details,
                    file_identity=source_file.file_identity,
                    changed_ns=source_file.changed_ns,
                )
            ):
                raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE)
            connection.execute("PRAGMA query_only = ON")
            yield connection
        finally:
            connection.close()


@contextmanager
def _open_windows_sqlite_readonly(
    source_file: AuthorizedSourceFile, timeout: float
) -> Iterator[sqlite3.Connection]:
    wal = source_file.path.with_name(source_file.path.name + "-wal")
    journal = source_file.path.with_name(source_file.path.name + "-journal")
    if os.path.lexists(journal):
        raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE)
    sources = [source_file]
    if os.path.lexists(wal):
        info = wal.lstat()
        if not stat.S_ISREG(info.st_mode) or is_reparse_point(info):
            raise SourceAccessError(SourceAccessErrorCode.SYMLINK_NOT_ALLOWED)
        if info.st_size > source_file.max_bytes:
            raise SourceAccessError(SourceAccessErrorCode.FILE_TOO_LARGE)
        sources.append(
            replace(
                source_file,
                path=wal,
                relative_path=source_file.relative_path.with_name(wal.name),
                file_identity=f"{info.st_dev}:{info.st_ino}",
                size=info.st_size,
                modified_ns=info.st_mtime_ns,
                changed_ns=_changed_ns(info),
            )
        )

    def hash_extent(item: AuthorizedSourceFile, destination: Path | None = None) -> str:
        digest = hashlib.sha256()
        with item.open_binary() as source:
            sink = destination.open("wb") if destination is not None else None
            try:
                remaining = item.size
                while remaining:
                    chunk = os.read(source.fileno(), min(remaining, 1024 * 1024))
                    if not chunk:
                        raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE)
                    digest.update(chunk)
                    if sink is not None:
                        sink.write(chunk)
                    remaining -= len(chunk)
                current = os.fstat(source.fileno())
                if current.st_size != item.size or current.st_mtime_ns != item.modified_ns:
                    raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE)
            finally:
                if sink is not None:
                    sink.close()
        return digest.hexdigest()

    with tempfile.TemporaryDirectory(prefix="memhub-sqlite-read-") as directory:
        private = Path(directory)
        protect_private_path(private, directory=True)
        mirror = private / "store.db"
        hashes = [
            hash_extent(item, mirror if index == 0 else private / "store.db-wal")
            for index, item in enumerate(sources)
        ]
        if (
            os.path.lexists(journal)
            or os.path.lexists(wal) != (len(sources) == 2)
            or any(
                hash_extent(item) != digest for item, digest in zip(sources, hashes, strict=True)
            )
        ):
            raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE)
        connection = sqlite3.connect(mirror, timeout=timeout, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("PRAGMA query_only=ON")
            yield connection
        finally:
            connection.close()


def _copy_sidecar(source: Path, target: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(source, flags)
    except OSError:
        raise SourceAccessError(SourceAccessErrorCode.SOURCE_UNAVAILABLE) from None
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise SourceAccessError(SourceAccessErrorCode.NOT_REGULAR_FILE)
        with os.fdopen(descriptor, "rb") as payload, target.open("wb") as destination:
            descriptor = -1
            shutil.copyfileobj(payload, destination, length=1024 * 1024)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
