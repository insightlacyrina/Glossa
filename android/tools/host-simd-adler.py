"""New, isolated host diagnostic of the exact Android ELF's leaf Adler SIMD code.

Does not dlopen the Android ELF, apply its relocations, alter it, change CPU flags,
or run application acceptance tests. Hard guards reject all other ELF/payloads.
"""
import argparse
import ctypes
import hashlib
import json
import mmap
import pathlib
import platform
import re
import resource
import struct
import subprocess
import sys
import zipfile
import zlib

ELF_SHA = 'e154b524119b6670b824d3e11a1794bf32e4a497aef18ed5d76fbe6e01d4eded'
BUILD_ID = '68dabd72c6088238cbfc9a5fbfe211f916771df5'
SNAPSHOT_SHA = 'f10aada9cfd5446cb0036ecb879f7262189e0ddeadaaeef33e1b236d49da6d48'
START, END = 0x1797790, 0x1797998
CONSTANTS = {0xcff770: 16, 0xcfb3b0: 8, 0xd029b0: 16}


def insist(condition, reason):
    if not condition:
        raise ValueError(reason)


def inspect_elf(data):
    insist(hashlib.sha256(data).hexdigest() == ELF_SHA, 'Exact ELF SHA256 mismatch')
    insist(data[:7] == b'\x7fELF\x02\x01\x01', 'Expected ELF64 little-endian')
    insist(struct.unpack_from('<HH', data, 16) == (3, 62), 'Expected x86_64 ET_DYN')
    phoff = struct.unpack_from('<Q', data, 32)[0]
    phsize, phnum = struct.unpack_from('<HH', data, 54)
    insist(phsize == 56 and 0 < phnum < 32, 'Unexpected program headers')
    programs = [struct.unpack_from('<IIQQQQQQ', data, phoff + i * phsize)
                for i in range(phnum)]
    ids = []
    for kind, flags, off, va, pa, size, memsize, align in programs:
        if kind != 4:
            continue
        pos, end = off, off + size
        while pos + 12 <= end:
            namesz, descsz, typ = struct.unpack_from('<III', data, pos)
            name = pos + 12
            desc = name + ((namesz + 3) & ~3)
            nxt = desc + ((descsz + 3) & ~3)
            insist(nxt <= end and nxt > pos, 'Malformed ELF note')
            if typ == 3 and data[name:name + namesz] == b'GNU\x00':
                ids.append(data[desc:desc + descsz].hex())
            pos = nxt
    insist(ids == [BUILD_ID], 'Exact GNU Build ID mismatch')
    loads = [p for p in programs if p[0] == 1]
    insist(loads and min(p[3] for p in loads) == 0, 'Unexpected PT_LOAD layout')
    for _, flags, off, va, _, size, memsize, align in loads:
        insist(off + size <= len(data) and size <= memsize, 'Invalid load range')
        insist(va + memsize < 128 * 1024 * 1024, 'Unexpected mapping size')
    for va, size in {START: END - START, **CONSTANTS}.items():
        insist(any(p[3] <= va and va + size <= p[3] + p[5] and p[1] & 4
                   for p in loads), 'Required code/constant outside file-backed readable PT_LOAD')
    # This exact library uses ordinary RELA sections. Refuse any relocation in the
    # executed code or read constants rather than applying Android relocations.
    shoff = struct.unpack_from('<Q', data, 40)[0]
    shsize, shnum = struct.unpack_from('<HH', data, 58)
    insist(shsize == 64, 'Unexpected section headers')
    relocation_count = 0
    for i in range(shnum):
        section = struct.unpack_from('<IIQQQQIIQQ', data, shoff + i * shsize)
        kind, off, size, stride = section[1], section[4], section[5], section[9]
        if kind not in (4, 9):
            continue
        insist(stride in (16, 24) and size % stride == 0, 'Invalid relocation section')
        for entry in range(off, off + size, stride):
            target = struct.unpack_from('<Q', data, entry)[0]
            relocation_count += 1
            insist(not any(va <= target < va + n for va, n in
                           {START: END - START, **CONSTANTS}.items()),
                   'Executed code or constant needs relocation')
    return loads, relocation_count


def inspect_code(elf):
    dump = subprocess.check_output(['objdump', '-d', '--no-show-raw-insn',
        '--start-address=' + hex(START), '--stop-address=' + hex(END), str(elf)], text=True)
    instructions, rip_refs, branches = [], set(), []
    for line in dump.splitlines():
        match = re.match(r'\s*([0-9a-f]+):\s+(\S+)(?:\s+(.*))?$', line)
        if not match:
            continue
        address, mnemonic, operand = int(match[1], 16), match[2], match[3] or ''
        instructions.append((address, mnemonic, operand))
        insist(not mnemonic.startswith('call') and mnemonic not in
               ('syscall', 'sysenter', 'int', 'int3', 'ud2', 'iret', 'iretq'),
               'Unresolved call or system/trap instruction: ' + line)
        insist('%fs' not in operand and '%gs' not in operand, 'TLS dependency: ' + line)
        if mnemonic.startswith('j'):
            target = re.match(r'([0-9a-f]+)', operand)
            insist(target is not None, 'Indirect/unresolved branch: ' + line)
            target = int(target[1], 16)
            insist(START <= target < END, 'Branch leaves inspected function: ' + line)
            branches.append(target)
        if '%rip' in operand:
            target = re.search(r'#\s*([0-9a-f]+)', operand)
            insist(target is not None, 'Unresolved RIP reference: ' + line)
            target = int(target[1], 16)
            insist(target in CONSTANTS, 'Unexpected RIP/global dependency: ' + line)
            rip_refs.add(target)
    addresses = {i[0] for i in instructions}
    insist(instructions and instructions[0][0] == START, 'Missing entry instruction')
    insist(all(b in addresses for b in branches), 'Branch not at decoded instruction boundary')
    insist(rip_refs == set(CONSTANTS), 'Unexpected static constant set')
    insist(any(m == 'ret' for _, m, _ in instructions), 'No inspected return')
    insist(any(m == 'pmovsxbw' for _, m, _ in instructions), 'Expected SSE4.1 instruction absent')
    return dump, len(instructions)


def host_cpu():
    insist(platform.machine() == 'x86_64', 'Host is not x86_64')
    lines = pathlib.Path('/proc/cpuinfo').read_text().splitlines()
    flags = [set(l.split(':', 1)[1].split()) for l in lines if l.startswith('flags')]
    insist(flags and all({'ssse3', 'sse4_1'} <= f for f in flags),
           'Every visible host CPU must support SSSE3 and SSE4.1')
    return {'architecture': platform.machine(), 'all_visible_cpus_ssse3_sse4_1': True,
            'model': next((l.split(':', 1)[1].strip() for l in lines if l.startswith('model name')), 'unknown')}


def scalar(payload):
    a = b = 0
    for c in payload:
        a = (a + c) % 65521
        b = (b + a) % 65521
    return (b << 16) | a


def child(elf, apk):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    cpu = host_cpu()
    data = elf.read_bytes()
    loads, relocation_count = inspect_elf(data)
    _, instruction_count = inspect_code(elf)
    with zipfile.ZipFile(apk) as archive:
        snapshot = archive.read('assets/snapshot_blob_64.bin')
    insist(hashlib.sha256(snapshot).hexdigest() == SNAPSHOT_SHA, 'Exact snapshot SHA256 mismatch')
    insist(len(snapshot) == 74109, 'Unexpected snapshot size')
    payload = snapshot[12:]
    expected = struct.unpack_from('<I', snapshot, 8)[0]
    scalar_value = scalar(payload)
    zlib_value = zlib.adler32(payload, 0)
    insist(expected == scalar_value == zlib_value == 0x882b7eae, 'Host references disagree')

    page = mmap.PAGESIZE
    up = lambda x: (x + page - 1) & ~(page - 1)
    down = lambda x: x & ~(page - 1)
    span = up(max(p[3] + p[6] for p in loads))
    image = mmap.mmap(-1, span, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
                      prot=mmap.PROT_READ | mmap.PROT_WRITE)
    base = ctypes.addressof(ctypes.c_char.from_buffer(image))
    for _, flags, off, va, _, size, memsize, align in loads:
        image[va:va + size] = data[off:off + size]
    # This opens host libc only for mprotect, never dlopens the Android library.
    libc = ctypes.CDLL(None, use_errno=True)
    mprotect = libc.mprotect
    mprotect.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)
    mprotect.restype = ctypes.c_int
    insist(mprotect(base, span, 0) == 0, 'mprotect reserve failed: ' + str(ctypes.get_errno()))
    for _, flags, off, va, _, size, memsize, align in loads:
        prot = (mmap.PROT_READ if flags & 4 else 0) | (mmap.PROT_WRITE if flags & 2 else 0) | (mmap.PROT_EXEC if flags & 1 else 0)
        insist(mprotect(base + down(va), up(va + memsize) - down(va), prot) == 0,
               'mprotect PT_LOAD failed: ' + str(ctypes.get_errno()))
    # Leaf function uses no Android ABI services, relocations, GOT, TLS or calls.
    array = ctypes.create_string_buffer(payload, len(payload))
    fn = ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_size_t)(base + START)
    simd_value = fn(0, ctypes.addressof(array), len(payload))
    result = {'scope': 'new host CPU execution diagnostic, not application acceptance',
        'elf_sha256': ELF_SHA, 'gnu_build_id': BUILD_ID, 'snapshot_sha256': SNAPSHOT_SHA,
        'entry': hex(START), 'function_end_exclusive': hex(END),
        'corrected_requested_entry': '0x1798a90 is not the Adler entry and was never executed',
        'static_instruction_count': instruction_count, 'relocations_checked': relocation_count,
        'static_constants': [hex(x) for x in CONSTANTS], 'android_external_calls': 0,
        'mapped_bytes': span, 'payload_bytes': len(payload), 'host_cpu': cpu,
        'header': hex(expected), 'python_scalar_seed0': hex(scalar_value),
        'host_zlib_seed0': hex(zlib_value), 'same_elf_simd_on_host_seed0': hex(simd_value),
        'simd_equals_scalar': simd_value == scalar_value,
        'android_whole_payload_reference': '0xb2987c76',
        'android_chunk32_reference': '0x882b7eae',
        'limitations': 'Host leaf-function result does not validate Android WebView UI or identify the exact failing TCG instruction.'}
    print(json.dumps(result, indent=2), flush=True)
    image.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--elf', required=True, type=pathlib.Path,
                        help='Exact original x86_64 libwebviewchromium.so (SHA256/Build ID guarded)')
    parser.add_argument('--apk', required=True, type=pathlib.Path,
                        help='Original provider APK containing the exact guarded snapshot64 asset')
    parser.add_argument('--output-dir', required=True, type=pathlib.Path,
                        help='Directory for JSON, static disassembly and isolated-child stderr')
    parser.add_argument('--child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    elf = args.elf.resolve(strict=True)
    apk = args.apk.resolve(strict=True)
    output_dir = args.output_dir.resolve()
    script = pathlib.Path(__file__).resolve()
    if args.child:
        child(elf, apk)
    else:
        host_cpu()
        inspect_elf(elf.read_bytes())
        disassembly, _ = inspect_code(elf)
        for filename in ('host-simd-static-disassembly.txt', 'host-simd-child.stderr', 'host-simd-adler.json'):
            insist((output_dir / filename).resolve() not in (elf, apk, script),
                   'Diagnostic output would overwrite an input or this tool')
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / 'host-simd-static-disassembly.txt').write_text(disassembly)
        process = subprocess.run([sys.executable, str(script), '--elf', str(elf),
                                 '--apk', str(apk), '--output-dir', str(output_dir), '--child'],
                                 text=True, capture_output=True, timeout=30)
        (output_dir / 'host-simd-child.stderr').write_text(process.stderr)
        insist(process.returncode == 0, 'Isolated child failed: ' + str(process.returncode) + '\n' + process.stderr)
        result = json.loads(process.stdout)
        (output_dir / 'host-simd-adler.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
