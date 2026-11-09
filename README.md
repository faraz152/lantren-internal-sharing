# Lantern Share

![Lantern Share logo](public/brand/lantern-lockup.svg)

## Install the Windows app

Lantern Share is an installable web app with its own name and lantern icon. On the host PC, open `http://127.0.0.1:8787` in Microsoft Edge, enter the PIN if asked, and choose the **App available** icon in the address bar. If that icon is not shown, use **Settings and more (…) > More tools > Apps > Install this site as an app**. Name it **Lantern Share**, then choose **Pin to taskbar** in Edge's install/manage app options. The app manifest supplies the branded icon; pin the installed app rather than a browser tab or generic website shortcut.

The server must already be running; the startup task starts it at sign-in. This PWA uses the installed Edge runtime and the local server; no cloud account or public web service is involved. The older `install-windows-app.ps1` shortcut is available as a fallback. Run `uninstall-windows-app.ps1` to remove those shortcuts only; it does not uninstall the Edge PWA or remove share data.

## Light and dark themes

Use the sun/moon button in the login screen or app header. The preference is saved in that browser's local storage; new browsers default to the operating system's appearance setting. The PWA service worker passes requests through to the LAN server and does not cache shared content.

## Create the Mac app

See [MAC_APP_GUIDE.md](MAC_APP_GUIDE.md) for the Safari Add to Dock option, standalone Mac `.dmg` builder, optional Mac-hosted setup, and its per-user automatic startup agent.

## Host on Linux Mint

See [LINUX_MINT_GUIDE.md](LINUX_MINT_GUIDE.md) for Node.js setup, the systemd user service, startup at boot, and local firewall guidance. The `linux/install-server.sh` script starts Lantern Share as your user and stores data in `~/.lantern-share/`.

## Add and manually sync multiple hosts

Windows, Mac, and Linux Mint hosts can join one paired room. On the existing host, open Lantern Share on that computer and choose **? > Room devices > Create pairing code**. On a new, empty host, enter the existing host's local address and temporary code under **Pair this host**. Pairing links the hosts and copies the room PIN; it does not copy any notes or files.

The **Room devices** list is available from any signed-in browser or the Android app. Choose **Sync now** beside one host, or **Sync all devices now**. Data and deletions move only during a sync that someone starts. Until then, every host keeps and displays the last copy it received. To update a Mac while Windows is off, first sync the room to the Mac; it can then serve that saved copy independently. New changes made while devices are apart will move the next time you manually sync with those devices online.

Sync stays within the same private wired/Wi-Fi network. Pair every host with the same room, use a non-guest network that allows device-to-device traffic, and keep both ends of a sync online until it finishes.

## Android app

The Android APK is a native client for connecting to a Windows, Mac, or Linux Mint host. It supports the shared web app's notes, media previews, file selection, downloads, and manual host sync controls. It does not run a background host server on Android. See [ANDROID_APP_GUIDE.md](ANDROID_APP_GUIDE.md) for installing the APK and building it from this project.

## Lantern logo

The same lantern mark is used for the Windows PWA, Android APK, and Mac DMG app. See [LOGO_GUIDE.md](LOGO_GUIDE.md) for the reusable SVG and PNG variants.

## Move the sharing room to another host

On the current host computer, open the app locally and choose **? > Move this sharing room**. Pause writes, create the encrypted `.lshare` backup with a passphrase of at least 12 characters, and copy it to the destination computer. Install and start Lantern Share on the new Windows, Mac, or Linux Mint host, open it on that computer, then import the backup from the same menu. Import checks the passphrase, archive integrity, and file hashes. It is allowed only when the destination shelf is empty.

The imported host receives the original shelf and PIN. Other devices must open the new host's private network address. The source stays paused until resumed locally so it cannot receive changes during the one-time move. After import, pair hosts through **Room devices** if you want multiple hosts and manual sync. The `.lshare` backup contains the PIN and shared files in encrypted form; keep its passphrase private. The backup needs room on the source device, and the destination may need several times the share size free while it verifies and imports it.

Phones and tablets can join as clients. Android hosting needs a native companion app to keep a server running; this web app does not make a phone host by itself.

Lantern Share is a small, private sharing room for devices on the same home or office network. One or more Windows, Mac, or Linux Mint computers can run paired hosts; phones, tablets, and other computers join from a browser or Android app using a host's local network address and the room PIN.

There are no cloud accounts, hosted servers, upload services, analytics, external JavaScript packages, or third-party runtime libraries. The server uses only built-in Node.js modules and serves the app itself.

## Start the host

Install Node.js 20 or newer on the computer that will hold the shared files. Then open PowerShell in this project folder and run:

```powershell
node server.js
```

The terminal prints a six-digit **Join PIN** and one or more local addresses. On each other device connected to the same Wi-Fi or wired network, open the printed address in a browser and enter the PIN. The PIN is saved in `%LOCALAPPDATA%\.lantern-share\join-pin.txt` and stays the same across restarts. The host computer can use the `localhost` address printed in the terminal.

Windows may ask whether Node.js can accept connections. Allow it on **Private networks only**. Do not add a router port-forwarding rule, and do not put this app behind a public tunnel or public DNS name.

## Start automatically on this Windows PC

From an elevated PowerShell window opened in this project folder, run:

```powershell
.\install-startup-task.ps1
```

This starts Lantern Share in the background now and again when your Windows account signs in. It creates a Windows Firewall rule for TCP port `8787` from the local subnet on **Private** networks only. A rebooted PC must reach the Windows sign-in screen and have your account signed in before this logon task starts. Keep the PC awake and connected to Wi-Fi or Ethernet for other devices to use the share. The installer prints the local addresses to open on other devices. The join PIN and logs are in `%LOCALAPPDATA%\.lantern-share\`.

To remove automatic startup and the firewall rule later, run `uninstall-startup-task.ps1` from an elevated PowerShell window. It leaves shared files and history in place.

## What it can share

- Notes, snippets, and links as text
- Multiple files in one selection or drag and drop
- Photos, video, audio, documents, and other file types
- Image previews and browser-supported video/audio previews
- Downloads, text copy, search, filtering, and deletion

Uploads have no size limit configured by this app and stream to disk. The actual limit is the free space and file-system limit on the host. Files and the shared shelf persist across server restarts until they are deleted. The default storage folder is `%LOCALAPPDATA%\.lantern-share`; set `SHARE_DIR` to choose another location.

## Network and privacy boundary

The server refuses requests unless they come from the host itself or an IP on the same private IPv4 subnet as one of the host's private network interfaces. It also rejects unexpected Host headers, requires a room PIN, rate-limits failed PIN attempts, and checks the request origin for changes. The app doesn't have a public domain or a connection to an outside service.

By default, browser-to-host traffic uses HTTP. This keeps traffic on the local network and out of cloud storage, but HTTP does not encrypt traffic against another device that can monitor that local network. On an untrusted network, use a trusted HTTPS certificate by setting `HTTPS_CERT` and `HTTPS_KEY` before starting the server. Client devices must trust that certificate; a browser certificate warning is not equivalent to a trusted private connection.

The LAN restriction assumes the router or access point isolates its private network from the internet and that the host's firewall is enabled. It is not a substitute for a trusted Wi-Fi password. Some guest Wi-Fi networks block devices from reaching one another; use the same non-guest network or disable client isolation for that trusted network. Files are stored as ordinary files on the host; use operating-system disk encryption if you need protection when that device is powered off or its drive is removed.

## Settings

Settings can be supplied as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Local web server port |
| `SHARE_PIN` | Random six-digit PIN saved on first launch | Set a fixed PIN if you need one |
| `SHARE_DIR` | `%LOCALAPPDATA%\.lantern-share` on Windows | Persistent files and share history |
| `HTTPS_CERT` | Unset | Path to a certificate PEM file |
| `HTTPS_KEY` | Unset | Path to its private key PEM file |

Example in PowerShell:

```powershell
$env:SHARE_DIR = 'D:\SharedFiles\Lantern'
node server.js
```

The PIN grants access to everyone who knows it, so share it only with devices you trust. The saved PIN stays the same across restarts. If you remove `join-pin.txt`, the next start generates a new PIN unless `SHARE_PIN` is set.

## Operation

The host must stay on and connected for other devices to browse, upload, and download. Shares are kept on the host. To remove a share, use its delete button in the web app. Stopping the server with `Ctrl+C` does not delete saved items.

This first version is LAN-only. For devices on different networks, a private VPN would be needed. Tailscale is one option but uses a third-party coordination service; a self-hosted WireGuard network can avoid that service, though it needs a reachable endpoint and more network setup.
