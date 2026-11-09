# Lantern Share on Linux Mint

Linux Mint can run Lantern Share as a local-network host. The service uses the included Node.js server, stores files on the Mint computer, and does not need a cloud account or public address.

## Install the host

1. Copy the complete `InternalSharing` folder to the Mint computer. Keep `server.js`, `host-backup.js`, `public/`, and `linux/` together.
2. Install Node.js 20 or newer from the [official Node.js downloads page](https://nodejs.org/en/download), then open Terminal and check `node --version`.
3. In Terminal, change into the project folder and run:

   ```sh
   chmod +x linux/install-server.sh linux/uninstall-server.sh
   ./linux/install-server.sh
   ```

   The installer creates a per-user systemd service and starts it. It may ask for your Linux password once to enable systemd **linger**, which lets the service start at boot before you sign in. If you decline, the service still starts when you sign in.
4. Open `http://127.0.0.1:8787` on Mint. Read the six-digit PIN with `cat ~/.lantern-share/join-pin.txt`; the server's private IPv4 address appears in `journalctl --user -u lantern-share.service -n 40`. Other devices on the same trusted Wi-Fi or Ethernet network open `http://<Mint-private-IP>:8787` and enter the PIN.

Lantern Share stores its data in `~/.lantern-share/` by default. Uploaded files are in `files/`; `items.json` holds the shelf index and `join-pin.txt` holds the PIN. The app's host transfer feature displays the data path and the addresses to use.

## Join an existing Windows or Mac room

On the existing host, open Lantern Share on that computer and choose **? > Room devices > Create pairing code**. On this new empty Mint host, open `http://localhost:8787`, sign in with its current PIN, and enter the existing host's local address and temporary code under **Pair this host**. Pairing shares the room PIN but does not copy any data.

Use **? > Room devices** from any signed-in browser or Android client to see paired hosts. Tap **Sync now** for one host or **Sync all devices now** to copy the current room data. Nothing copies in the background. Mint retains its last synced copy until someone requests another sync. When both hosts are online, a manual sync exchanges new notes, files, and deletions.

## Allow connections through UFW, if it is enabled

The app accepts devices only from the host's local private subnet. Check Mint's network address and subnet, then allow port 8787 from that subnet only. Replace `YOUR_LAN_SUBNET` below with your router's private subnet:

```sh
sudo ufw allow from YOUR_LAN_SUBNET to any port 8787 proto tcp
```

Replace the example subnet with the one used by your router. Do not forward port 8787 on the router or expose the service to the public internet.

## Move an existing room to Linux Mint

On the current host, open Lantern Share **on that host computer**, choose **? > Move this sharing room**, and pause sharing. Choose a backup passphrase of at least 12 characters and create the encrypted `.lshare` backup. Copy that backup to the Mint computer using a USB drive or a trusted local file share.

On Mint, install and start the host as above. Open `http://127.0.0.1:8787`, sign in with Mint's temporary PIN, open **? > Move this sharing room**, select the `.lshare` file, enter the backup passphrase, and import. Import is allowed only on an empty host. It verifies the encrypted archive and file hashes before replacing the temporary PIN with the previous room's PIN.

After import, devices connect to Mint's new private IPv4 address and use the existing room PIN. Verify that the room and files appear on Mint before stopping the old host. The old host remains paused until you resume it from that host's local browser. Keep only one host accepting writes to this room.

## Check or remove automatic startup

```sh
systemctl --user status lantern-share.service
journalctl --user -u lantern-share.service -n 40
```

To remove the service while leaving shared files and the PIN intact:

```sh
./linux/uninstall-server.sh
```

The uninstall script does not turn off systemd linger because another service on your account might use it. If you enabled UFW, remove the exact subnet rule later with `sudo ufw delete allow from <your-LAN-subnet> to any port 8787 proto tcp`.

## Network and availability

Use the same trusted non-guest network on each device. Guest Wi-Fi or client isolation can block local connections. Keep the Mint computer awake and connected when others need the share. The default transport is HTTP on the LAN; the app does not encrypt traffic against someone monitoring that network. Protect the Wi-Fi and host computer accordingly.
