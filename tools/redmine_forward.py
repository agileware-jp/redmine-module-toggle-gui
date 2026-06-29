#!/usr/bin/env python3
"""
Mac の Docker 上 Redmine (127.0.0.1:13000) を、Parallels の Windows VM から
到達できるよう全インターフェース(0.0.0.0:13001)で中継する簡易TCPフォワーダ。

Docker Desktop for Mac は公開ポートを実質 localhost 経由でしか転送しないため、
VM から直接 10.211.55.2:13000 に繋いでも届かない。本スクリプトを Mac で起動し、
VM のアプリでは http://<MacのParallels IP>:13001 を指定する。

使い方:  python3 redmine_forward.py [listen_port=13001] [target_port=13000]
"""
import socket
import sys
import threading

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 13001
TARGET_HOST = "127.0.0.1"
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 13000


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    try:
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT))
    except OSError as e:
        print(f"upstream connect failed: {e}", flush=True)
        client.close()
        return
    t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    client.close()
    upstream.close()


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((LISTEN_HOST, LISTEN_PORT))
    s.listen(128)
    print(f"forwarding {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        client, _addr = s.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
