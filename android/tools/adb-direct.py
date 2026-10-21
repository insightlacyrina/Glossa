#!/usr/bin/env python3
"""Minimal ADB transport for the local, auth-disabled test emulator only.

The managed sandbox's adb binary tries to create ~/.android even with Android
cache selectors. This test utility avoids changing HOME or writing outside the
workspace. Real device development should use the standard Android adb client.
"""
import argparse
import pathlib
import socket
import struct
import sys
import time


class LocalEmulator:
    def __init__(self, port=5555, timeout=90):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.send(b"CNXN", 0x01000001, 4096, b"host::\0")
        command, _, maximum, _ = self.receive()
        if command != b"CNXN":
            raise RuntimeError("Local emulator is not ready or requires ADB authentication")
        self.maximum = min(maximum, 65536)

    def send(self, command, arg0, arg1, payload=b""):
        value = struct.unpack("<I", command)[0]
        self.socket.sendall(struct.pack("<6I", value, arg0, arg1, len(payload), 0, value ^ 0xFFFFFFFF) + payload)

    def exact(self, size):
        data = bytearray()
        while len(data) < size:
            part = self.socket.recv(size - len(data))
            if not part:
                raise EOFError("ADB transport closed")
            data.extend(part)
        return bytes(data)

    def receive(self):
        command, arg0, arg1, size, _, _ = struct.unpack("<6I", self.exact(24))
        if size > 16 * 1024 * 1024:
            raise RuntimeError("Unexpected ADB packet size")
        return struct.pack("<I", command), arg0, arg1, self.exact(size)

    def execute(self, command, source=None):
        self.send(b"OPEN", 1, 0, ("exec:" + command + "\0").encode())
        kind, remote, _, payload = self.receive()
        if kind != b"OKAY":
            raise RuntimeError("ADB service rejected: " + repr((kind, payload)))
        output = bytearray()

        def consume(packet):
            kind, arg0, _, payload = packet
            if kind == b"WRTE":
                output.extend(payload)
                self.send(b"OKAY", 1, arg0)
            elif kind == b"CLSE":
                self.send(b"CLSE", 1, remote)
                return False
            return True

        if source:
            with source.open("rb") as stream:
                while data := stream.read(self.maximum):
                    self.send(b"WRTE", 1, remote, data)
                    while True:
                        packet = self.receive()
                        if packet[0] == b"OKAY":
                            break
                        if not consume(packet):
                            return bytes(output)
        while consume(self.receive()):
            pass
        self.socket.close()
        return bytes(output)

    def push(self, source, destination):
        self.send(b"OPEN", 1, 0, b"sync:\0")
        kind, remote, _, _ = self.receive()
        if kind != b"OKAY":
            raise RuntimeError("ADB sync service rejected")
        response = bytearray()

        def write(payload):
            self.send(b"WRTE", 1, remote, payload)
            while True:
                kind, sender, _, data = self.receive()
                if kind == b"OKAY":
                    return
                if kind == b"WRTE":
                    response.extend(data)
                    self.send(b"OKAY", 1, sender)
                if kind == b"CLSE":
                    raise RuntimeError("ADB sync service closed: " + repr(response))

        target = (destination + ",33188").encode()
        write(b"SEND" + struct.pack("<I", len(target)) + target)
        with source.open("rb") as stream:
            while chunk := stream.read(self.maximum - 8):
                write(b"DATA" + struct.pack("<I", len(chunk)) + chunk)
        write(b"DONE" + struct.pack("<I", int(time.time())))
        while len(response) < 8:
            kind, sender, _, data = self.receive()
            if kind == b"WRTE":
                response.extend(data)
                self.send(b"OKAY", 1, sender)
            elif kind == b"CLSE":
                raise RuntimeError("ADB sync service closed before status")
        self.send(b"CLSE", 1, remote)
        self.socket.close()
        if response[:4] != b"OKAY":
            raise RuntimeError("ADB push failed: " + repr(response))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--output", type=pathlib.Path)
    sub = parser.add_subparsers(dest="action", required=True)
    shell = sub.add_parser("shell")
    shell.add_argument("command")
    install = sub.add_parser("install")
    install.add_argument("apk", type=pathlib.Path)
    args = parser.parse_args()
    emulator = LocalEmulator(args.port, args.timeout)
    if args.action == "install":
        target = "/data/local/tmp/" + args.apk.name
        emulator.push(args.apk, target)
        result = LocalEmulator(args.port, args.timeout).execute("cmd package install -r -t " + target)
    else:
        result = emulator.execute(args.command)
    if args.output:
        args.output.write_bytes(result)
    else:
        sys.stdout.buffer.write(result)


if __name__ == "__main__":
    main()
