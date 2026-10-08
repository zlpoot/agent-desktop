"""Bounded read-only Windows installation discovery. No shell, COM Resolve, or input APIs."""
import ctypes
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time

WRAPPERS = {'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe',
            'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'python.exe', 'pythonw.exe',
            'node.exe', 'bash.exe', 'wsl.exe'}
SOURCES = ('start-menu-user', 'start-menu-public', 'app-paths-hkcu', 'app-paths-hklm-64', 'app-paths-hklm-32')


def limits_value(value):
    if not isinstance(value, dict) or set(value) != {'maxEntries', 'maxDepth', 'timeoutMs'}:
        raise ValueError('invalid-app-scan-limits')
    for key, low, high in [('maxEntries', 1, 2000), ('maxDepth', 0, 10), ('timeoutMs', 10, 30000)]:
        if type(value[key]) is not int or not low <= value[key] <= high:
            raise ValueError('invalid-app-scan-limits')
    return value


def windows_cli_json(value):
    """Keep subprocess JSON ASCII-safe across Windows stdout code pages.

    JSON decoders restore the escaped Unicode text; raw stdout encoding can vary
    with the Windows console/locale code page even when Node reads bytes as UTF-8.
    """
    return json.dumps(value, ensure_ascii=True)


def local_path(value):
    if (not isinstance(value, str) or len(value) > 4096 or value != value.strip() or
            not re.match(r'^[A-Za-z]:[\\/]', value) or re.search(r'[<>"|?*\x00-\x1f]', value) or ':' in value[2:]):
        raise ValueError('unsupported-local-app-path')
    return ntpath.normpath(value)


def split_arguments(value):
    """Windows quote/backslash rules; return argv data, never a shell command."""
    if not isinstance(value, str) or len(value) > 8192 or re.search(r'[\x00\r\n]', value):
        raise ValueError('invalid-shortcut-arguments')
    args, i = [], 0
    while i < len(value):
        while i < len(value) and value[i] in ' \t':
            i += 1
        if i == len(value):
            break
        part, quoted = '', False
        while i < len(value) and (quoted or value[i] not in ' \t'):
            if value[i] == '\\':
                start = i
                while i < len(value) and value[i] == '\\':
                    i += 1
                count = i - start
                if i < len(value) and value[i] == '"':
                    part += '\\' * (count // 2)
                    if count % 2:
                        part += '"'
                    else:
                        quoted = not quoted
                    i += 1
                else:
                    part += '\\' * count
            elif value[i] == '"':
                quoted = not quoted
                i += 1
            else:
                part += value[i]
                i += 1
        if quoted or len(part) > 4096:
            raise ValueError('invalid-shortcut-arguments')
        args.append(part)
        if len(args) > 32:
            raise ValueError('too-many-shortcut-arguments')
    return args


def parse_shortcut(data):
    """MS-SHLLINK local LinkInfo + StringData only. Never repair/resolve a target."""
    if len(data) < 76 or len(data) > 131072 or data[:20] != bytes.fromhex('4c0000000114020000000000c000000000000046'):
        raise ValueError('invalid-shortcut-header')
    flags = struct.unpack_from('<I', data, 20)[0]
    if flags & ~0xff or not flags & 2:  # advanced resolution, advertised/expandable links are unsupported
        raise ValueError('unsupported-shortcut-resolution')
    offset = 76
    if flags & 1:
        if offset + 2 > len(data):
            raise ValueError('invalid-shortcut-id-list')
        offset += 2 + struct.unpack_from('<H', data, offset)[0]
    if offset + 28 > len(data):
        raise ValueError('invalid-shortcut-link-info')
    size, header, info_flags, volume, base, network, suffix = struct.unpack_from('<7I', data, offset)
    if size < header or (header != 28 and header < 36) or offset + size > len(data) or info_flags != 1 or network != 0:
        raise ValueError('unsupported-shortcut-network-or-link-info')
    block = data[offset:offset + size]
    if volume < header or volume + 16 > size:
        raise ValueError('invalid-shortcut-volume')
    volume_size, drive_type = struct.unpack_from('<2I', block, volume)
    if volume_size < 16 or volume + volume_size > size or drive_type != 3:
        raise ValueError('unsupported-shortcut-volume')
    unicode_base, unicode_suffix = (struct.unpack_from('<2I', block, 28) if header >= 36 else (0, 0))

    def string_at(at, unicode=False):
        if not header <= at < size:
            raise ValueError('invalid-shortcut-string-offset')
        step = 2 if unicode else 1
        end = at
        while end + step <= size and block[end:end + step] != b'\0' * step:
            end += step
        if end + step > size:
            raise ValueError('unterminated-shortcut-string')
        return block[at:end].decode('utf-16le' if unicode else ('mbcs' if os.name == 'nt' else 'ascii'))

    target = string_at(unicode_base or base, bool(unicode_base)) + string_at(unicode_suffix or suffix, bool(unicode_suffix))
    offset += size
    strings = {}
    for bit, name in [(4, 'name'), (8, 'relative'), (16, 'workingDirectory'), (32, 'arguments'), (64, 'icon')]:
        if flags & bit:
            if offset + 2 > len(data):
                raise ValueError('invalid-shortcut-string-data')
            count = struct.unpack_from('<H', data, offset)[0]
            length = count * (2 if flags & 128 else 1)
            offset += 2
            if count > 4096 or offset + length > len(data):
                raise ValueError('invalid-shortcut-string-data')
            strings[name] = data[offset:offset + length].decode('utf-16le' if flags & 128 else ('mbcs' if os.name == 'nt' else 'ascii'))
            offset += length
    if data[offset:] not in (b'', b'\0\0\0\0'):
        raise ValueError('unsupported-shortcut-extra-data')
    return local_path(target), split_arguments(strings.get('arguments', '')), strings.get('workingDirectory') or None


def installation_scope_id():
    """Stable machine + executing user's SID, independent of Worker/process/desktop restart."""
    if os.name != 'nt':
        raise OSError('windows-discovery-unavailable')
    import winreg
    import win32api
    import win32security
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography', 0,
                        winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        machine = winreg.QueryValueEx(key, 'MachineGuid')[0]
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32security.TOKEN_QUERY)
    try:
        sid = win32security.ConvertSidToStringSid(win32security.GetTokenInformation(token, win32security.TokenUser)[0])
    finally:
        token.Close()
    return 'windows:' + hashlib.sha256((machine + '\0' + sid).encode()).hexdigest()


class WindowsAppScanner:
    def __init__(self, menu_roots=None, registry_reader=None, clock=time.monotonic):
        # Test seams accept only trusted infrastructure, never fields from a remote request.
        self.menu_roots = menu_roots
        self.registry_reader = registry_reader or self._registry
        self.clock = clock

    def _check_file(self, path, directory=False):
        path = local_path(path)
        if os.name != 'nt':
            raise OSError('windows-discovery-unavailable')
        if ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(path[:3])) != 3:
            raise ValueError('unsupported-nonlocal-drive')
        current = Path(path)
        for part in [current, *current.parents]:
            value = part.stat(follow_symlinks=False)
            if getattr(value, 'st_file_attributes', 0) & 0x400 or stat.S_ISLNK(value.st_mode):
                raise ValueError('unsupported-reparse-path')
        if directory != current.is_dir() or (not directory and not current.is_file()):
            raise ValueError('app-path-is-directory' if current.is_dir() else 'app-path-not-file')
        return current

    def inspect(self, path, source, deadline, name=None):
        file = self._check_file(path)
        suffix = file.suffix.lower()
        if suffix == '.lnk':
            with file.open('rb') as stream:
                executable, args, working = parse_shortcut(stream.read(131073))
            spec = {'kind': 'shortcut', 'shortcutPath': str(file), 'executable': executable, 'args': args}
            if working:
                spec['workingDirectory'] = str(self._check_file(working, True))
        elif suffix == '.exe':
            executable = str(file)
            spec = {'kind': 'exe', 'executable': executable, 'args': []}
        else:
            raise ValueError('unsupported-app-file-type')
        if ntpath.basename(executable).lower() in WRAPPERS or not executable.lower().endswith('.exe'):
            raise ValueError('unsupported-app-wrapper-or-target')
        target = self._check_file(executable)
        if target.stat().st_size > 67108864:
            raise ValueError('app-target-exceeds-read-limit')
        fingerprint = hashlib.sha256()
        with target.open('rb') as stream:
            if stream.read(2) != b'MZ':
                raise ValueError('invalid-executable-header')
            stream.seek(0)
            while True:
                if self.clock() >= deadline:
                    raise TimeoutError('app-scan-timeout')
                chunk = stream.read(1048576)
                if not chunk:
                    break
                fingerprint.update(chunk)
        entry = {'displayName': name or file.stem, 'aliases': [], 'launchSpec': spec,
                 'source': source, 'contentFingerprint': fingerprint.hexdigest()}
        # Metadata is descriptive only; no fabricated product identity or verified state.
        try:
            import win32api
            translation = win32api.GetFileVersionInfo(str(target), r'\VarFileInfo\Translation')[0]
            prefix = '\\StringFileInfo\\%04x%04x\\' % translation
            for field, key in [('FileVersion', 'version'), ('CompanyName', 'publisher')]:
                value = win32api.GetFileVersionInfo(str(target), prefix + field)
                if value and not re.search(r'[\x00-\x1f]', value):
                    entry[key] = value.strip()
        except Exception:
            pass
        return entry

    def _menu(self, root, limits, deadline):
        root = self._check_file(str(root), True)
        pending = [(root, 0)]
        while pending:
            folder, depth = pending.pop()
            self._check_file(str(folder), True)
            with os.scandir(folder) as items:
                for item in items:
                    if self.clock() >= deadline:
                        raise TimeoutError('app-scan-timeout')
                    if item.is_dir(follow_symlinks=False):
                        if depth >= limits['maxDepth']:
                            raise OverflowError('menu-depth-limit')
                        pending.append((Path(item.path), depth + 1))
                        yield item.name, None  # directory enumeration also consumes the shared entry budget
                    else:
                        yield item.name, item.path if item.name.lower().endswith('.lnk') else None

    def _registry(self, source):
        import winreg
        hive = winreg.HKEY_CURRENT_USER if source == 'app-paths-hkcu' else winreg.HKEY_LOCAL_MACHINE
        view = winreg.KEY_WOW64_32KEY if source.endswith('-32') else winreg.KEY_WOW64_64KEY
        try:
            key = winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 0, winreg.KEY_READ | view)
        except FileNotFoundError:
            return
        with key:
            count = winreg.QueryInfoKey(key)[0]
            for i in range(count):
                name = winreg.EnumKey(key, i)
                with winreg.OpenKey(key, name) as app:
                    value, kind = winreg.QueryValueEx(app, '')
                if kind not in (winreg.REG_SZ, winreg.REG_EXPAND_SZ):
                    yield name, None
                else:
                    yield ntpath.splitext(name)[0], os.path.expandvars(value) if kind == winreg.REG_EXPAND_SZ else value

    def collect(self, limits, manual_path=None):
        limits = limits_value(limits)
        deadline = self.clock() + limits['timeoutMs'] / 1000
        entries, coverage, total = [], [], 0
        roots = self.menu_roots
        if roots is None:
            roots = {'start-menu-user': Path(os.environ.get('APPDATA', '')) / 'Microsoft/Windows/Start Menu/Programs',
                     'start-menu-public': Path(os.environ.get('ProgramData', '')) / 'Microsoft/Windows/Start Menu/Programs'}
        sources = ('manual-path',) if manual_path is not None else SOURCES
        for source in sources:
            status, inspected, rejected, reasons = 'complete', 0, 0, []
            try:
                if self.clock() >= deadline:
                    raise TimeoutError('app-scan-timeout')
                if source == 'manual-path':
                    rows = [(None, manual_path)]
                elif source.startswith('start-menu'):
                    rows = self._menu(roots[source], limits, deadline)
                else:
                    rows = self.registry_reader(source)
                for name, path in rows:
                    if self.clock() >= deadline:
                        raise TimeoutError('app-scan-timeout')
                    if total >= limits['maxEntries']:
                        raise OverflowError('scan-entry-limit')
                    total += 1
                    inspected += 1
                    if path is None:
                        continue
                    try:
                        entries.append(self.inspect(path, source, deadline, None if source.startswith('start-menu') else name))
                    except (ValueError, OSError) as error:
                        if isinstance(error, TimeoutError):
                            raise
                        rejected += 1
                        if len(reasons) < 8:
                            reasons.append(str(error) if isinstance(error, ValueError) else type(error).__name__)
            except TimeoutError:
                status = 'timeout'
                reasons.append('app-scan-timeout')
            except OverflowError as error:
                status = 'truncated'
                reasons.append(str(error))
            except (OSError, ValueError, KeyError, ImportError) as error:
                status = 'unavailable'
                reasons.append(type(error).__name__ if isinstance(error, OSError) else str(error))
            # Rejected/unreadable candidates prevent a false comprehensive negative result.
            if rejected and status == 'complete':
                status = 'unavailable' if inspected == rejected else 'truncated'
            record = {'source': source, 'status': status, 'inspected': inspected, 'rejected': rejected}
            if reasons:
                record['reason'] = ';'.join(dict.fromkeys(reasons))[:4096]
            coverage.append(record)
        return {'entries': entries, 'coverage': coverage}


class GuestAppDiscovery:
    protocol_version = 1

    def __init__(self, vm_id, scanner=None, identity=installation_scope_id):
        self.vm_id, self.scanner, self.identity = vm_id, scanner or WindowsAppScanner(), identity

    def scope(self):
        if not self.vm_id:
            raise ValueError('guest-app-identity-unavailable')
        return {'providerId': 'hyper-v', 'environmentId': 'vm:' + self.vm_id.lower(), 'installationScopeId': self.identity()}

    def handle(self, request):
        if not isinstance(request, dict) or set(request) - {'protocolVersion', 'scope', 'operation', 'limits', 'path'}:
            raise ValueError('invalid-app-query-fields')
        scope = self.scope()
        if request.get('protocolVersion') != 1 or request.get('scope') != scope:
            raise ValueError('guest-app-identity-or-version-mismatch')
        operation = request.get('operation')
        if operation not in ('scan', 'inspect') or (operation == 'scan' and 'path' in request):
            raise ValueError('invalid-app-query-operation')
        path = local_path(request.get('path')) if operation == 'inspect' else None
        result = self.scanner.collect(limits_value(request.get('limits')), path)
        # Revalidate installation identity after reading, before returning any candidates.
        if self.scope() != scope:
            raise ValueError('guest-app-identity-changed')
        return {'protocolVersion': 1, 'scope': scope, **result}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(16385))
        if not isinstance(request, dict) or set(request) - {'operation', 'path', 'limits', 'installationScopeId'}:
            raise ValueError('invalid-app-query-fields')
        operation = request.get('operation')
        if operation not in ('scan', 'inspect') or (operation == 'scan' and 'path' in request):
            raise ValueError('invalid-app-query-operation')
        identity = installation_scope_id()
        if request.get('installationScopeId') != identity:
            raise ValueError('host-app-installation-identity-mismatch')
        result = WindowsAppScanner().collect(limits_value(request.get('limits')),
                                             local_path(request.get('path')) if operation == 'inspect' else None)
        if installation_scope_id() != identity:
            raise ValueError('host-app-identity-changed')
        print(windows_cli_json({'installationScopeId': identity, **result}))
    except Exception as error:
        print(windows_cli_json({'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        sys.exit(1)
