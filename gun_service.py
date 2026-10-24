#!/usr/bin/env python3
"""
Shooty - AR Gun Hardware Bridge & WebSocket Server
Connects to an explicitly configured iPega/BLE ARGunGame and streams input.
"""

import asyncio
import argparse
import json
import logging
import os
from pathlib import Path
from bleak import BleakScanner, BleakClient
import websockets
from hardware.ipega_protocol import IpegaDecoder
from server.transport import serve_application

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("GunBridge")

TARGET_MAC = os.environ.get("SHOOTY_GUN_MAC", "")
CHAR_NOTIFY_1 = "0000fff1-0000-1000-8000-00805f9b34fb"
CHAR_NOTIFY_3 = "0000fff3-0000-1000-8000-00805f9b34fb"
CHAR_WRITE_5  = "0000fff5-0000-1000-8000-00805f9b34fb"

connected_clients = set()
ble_client = None
controller_ready = False
controller_decoder = IpegaDecoder()
APP_ROOT = Path(__file__).resolve().parent
WEB_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/web/icons/icon-192.png": ("web/icons/icon-192.png", "image/png"),
    "/web/icons/icon-512.png": ("web/icons/icon-512.png", "image/png"),
    "/web/style.css": ("web/style.css", "text/css; charset=utf-8"),
    "/web/game-core.js": ("web/game-core.js", "text/javascript; charset=utf-8"),
    "/web/audio.js": ("web/audio.js", "text/javascript; charset=utf-8"),
    "/web/audio/pistol-1911.wav": ("web/audio/pistol-1911.wav", "audio/wav"),
    "/web/audio/pistol-reload-start.wav": ("web/audio/pistol-reload-start.wav", "audio/wav"),
    "/web/audio/pistol-reload-complete.wav": ("web/audio/pistol-reload-complete.wav", "audio/wav"),
    "/web/app.js": ("web/app.js", "text/javascript; charset=utf-8"),
    "/web/duel-client.js": ("web/duel-client.js", "text/javascript; charset=utf-8"),
    "/web/vision-client.js": ("web/vision-client.js", "text/javascript; charset=utf-8"),
    "/web/wallet-client.js": ("web/wallet-client.js", "text/javascript; charset=utf-8"),
}

async def broadcast(event_data):
    if connected_clients:
        message = json.dumps(event_data)
        logger.info(f"Broadcast ke {len(connected_clients)} client: {message}")
        await asyncio.gather(
            *[client.send(message) for client in tuple(connected_clients)],
            return_exceptions=True
        )

def controller_packet(characteristic, data):
    event = controller_decoder.decode(characteristic, data)
    if event is not None:
        event["controller_id"] = TARGET_MAC
        logger.info("[INPUT] %s", event)
        asyncio.create_task(broadcast(event))


def on_fff1(sender, data: bytearray):
    controller_packet(CHAR_NOTIFY_1, data)

def on_fff3(sender, data: bytearray):
    controller_packet(CHAR_NOTIFY_3, data)

async def ws_handler(websocket):
    connected_clients.add(websocket)
    logger.info(f"[WS] Client terhubung dari {websocket.remote_address}")
    try:
        await websocket.send(json.dumps({
            "event": "SYSTEM_INFO",
            "gun_mac": TARGET_MAC,
            "status": "connected" if (controller_ready and ble_client and ble_client.is_connected) else "searching"
        }))
        async for message in websocket:
            try:
                data = json.loads(message)
                if data.get("action") == "RUMBLE" and ble_client and ble_client.is_connected:
                    logger.info("Mengirim sinyal haptic ke pistol...")
                    await ble_client.write_gatt_char(CHAR_WRITE_5, bytes([0x01, 0x01]))
            except Exception as e:
                logger.error(f"Error handling ws message: {e}")
    finally:
        connected_clients.discard(websocket)
        logger.info("[WS] Client terputus")

async def ble_worker():
    global ble_client, controller_ready
    if not TARGET_MAC:
        raise RuntimeError("Set SHOOTY_GUN_MAC for the optional laptop bridge, or use --web-only")
    logger.info(f"[*] BLE Worker aktif. Mencari ARGunGame ({TARGET_MAC})...")

    while True:
        try:
            device = await BleakScanner.find_device_by_address(TARGET_MAC, timeout=5.0)
            if not device:
                await asyncio.sleep(1.0)
                continue

            logger.info(f"[+] Device ditemukan: {device.name} ({device.address}). Menghubungkan...")
            async with BleakClient(device, timeout=15.0) as client:
                controller_decoder.reset()
                ble_client = client
                logger.info(f"[+] TERHUBUNG KE PISTOL! Status: {client.is_connected}")

                # fff1 is unclassified telemetry, never an unconditional shot.
                try:
                    await client.start_notify(CHAR_NOTIFY_1, on_fff1)
                    logger.info("[+] Hook fff1 (telemetry) AKTIF")
                except Exception as e:
                    logger.warning(f"Hook fff1 gagal: {e}")

                # The user's measured trigger and button protocol lives on fff3.
                await client.start_notify(CHAR_NOTIFY_3, on_fff3)
                controller_ready = True
                logger.info("[+] Hook fff3 (pelatuk dan tombol) AKTIF")

                await broadcast({"event": "GUN_CONNECTED", "mac": TARGET_MAC})

                while client.is_connected:
                    await asyncio.sleep(1.0)

        except Exception as e:
            logger.warning(f"BLE loop: {e}")
            await asyncio.sleep(1.5)
        finally:
            if ble_client is not None:
                controller_ready = False
                ble_client = None
                controller_decoder.reset()
                await broadcast({"event": "GUN_DISCONNECTED"})

async def main(web_only=False, host="0.0.0.0", http_port=8080, chain=False, chain_settings=None):
    async with serve_application(APP_ROOT, WEB_FILES, host, http_port,chain=chain,chain_settings=chain_settings):
        logger.info("[HTTP + DUEL] http://localhost:%s/?input=%s · room realtime /ws/duel", http_port, "bluetooth" if web_only else "bridge")
        if web_only:
            logger.info("[WEB ONLY] Tidak membuka BLE laptop. Di Chrome Android buka /?input=bluetooth")
            await asyncio.Event().wait()
            return
        async with websockets.serve(ws_handler, "0.0.0.0", 8765):
            logger.info("[WS] WebSocket Server berjalan di: ws://0.0.0.0:8765")
            await ble_worker()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-only", action="store_true", help="Serve the page for direct browser Bluetooth; do not connect the laptop to the gun")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--duration", type=float, default=0, help="Stop after this many seconds; zero runs until Ctrl+C")
    parser.add_argument('--chain',action='store_true',help='Enable Monad Testnet funding and the local signer worker')
    parser.add_argument('--chain-key-file',default='.env',help='Local signer configuration path; never served to browsers')
    args = parser.parse_args()
    if not 1 <= args.http_port <= 65535 or args.duration < 0:
        parser.error("Use a valid TCP port and a nonnegative duration")

    async def run():
        operation = main(args.web_only, args.host, args.http_port,chain=args.chain,chain_settings={'SHOOTY_KEY_FILE':str((APP_ROOT/args.chain_key_file).resolve())})
        if args.duration:
            await asyncio.wait_for(operation, timeout=args.duration)
        else:
            await operation

    try:
        asyncio.run(run())
    except TimeoutError:
        logger.info("Durasi tes selesai; server ditutup.")
    except KeyboardInterrupt:
        logger.info("Shutting down.")
