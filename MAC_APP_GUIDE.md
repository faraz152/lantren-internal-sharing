# Lantern Share on Mac

This guide covers three Mac roles:

1. **Use the Mac as a client** for the Lantern Share server already running on your Windows PC. This is the simplest path and keeps all shared files on Windows.
2. **Use the Mac as the server** instead. The Mac then stores its own share history and files and serves them to devices on the same local network.
3. **Move the existing sharing room to the Mac** with the encrypted host backup in the app. Windows, Mac, and Linux Mint can run the host.

The Mac app is a Safari web app made with macOS's built-in **Add to Dock** feature. It opens Lantern Share in a separate app window, uses the included logo, and needs no App Store account, public website, cloud host, or Xcode project. On Windows, the same web app can be installed from Microsoft Edge as a PWA.

The project also includes an optional standalone Mac app and DMG builder. It wraps the same Lantern Share interface in a native WebKit window and uses the same lantern icon as Android and the Windows PWA.

## A. Make a Mac app that connects to the Windows PC

The Windows PC remains the host. Keep its Lantern Share startup task installed and leave the PC awake while you need the room.

1. On Windows, find the local address printed by Lantern Share. Use the address for the Windows host.
2. On the Mac, connect to the same non-guest Wi-Fi or wired network and open Safari.
3. Visit `http://<Windows-host-address>:8787`, replacing the placeholder with the Windows address. Enter the existing six-digit Join PIN if asked.
4. In Safari on **macOS Sonoma 14 or later**, choose **File > Add to Dock**, name the app **Lantern Share**, and click **Add**. It will be available in the Dock, Spotlight, and your home folder's Applications folder.
5. To apply the supplied icon, open the new app, choose **Lantern Share > Settings > General**, click the icon, and select `public/brand/lantern-mark.png` from the project folder. The horizontal brand logo is `public/brand/lantern-lockup.svg`.
6. Use the sun/moon button in Lantern Share to switch between light and dark themes. The selected theme is saved in this Mac app's local browser storage.

Safari web apps keep their website data separate from Safari, so the Mac app may ask for the Join PIN the first time even if Safari already joined. Shared files remain on Windows; if the Windows host is asleep or disconnected, the Mac app cannot reach them.

Apple's instructions: [Turn a website into an app in Safari on Mac](https://support.apple.com/en-us/104996). The feature requires macOS Sonoma 14 or later and Safari lets you choose an app name and icon in the web app's General settings.

### macOS earlier than Sonoma

The Safari **Add to Dock** web-app feature requires macOS Sonoma 14 or later. On an earlier version, use Safari normally and bookmark the Lantern Share address. You can also make a small browser-launching app in Script Editor, but it will open a Safari tab rather than the separate Safari web-app window:

```applescript
on run
    open location "http://<Windows-host-address>:8787"
end run
```

In Script Editor, save as **File Format: Application** and name it **Lantern Share**. Replace the sample IP with the Windows PC's address.

## B. Make the Mac the server

Choose this only if you want the Mac to hold the shared files and serve the other devices. If you only need to open the Windows share on Mac, use section A; the Mac does not need Node.js or the project files for that.

### 1. Copy the project and install Node.js

Copy the complete `InternalSharing` project folder to the Mac using a USB drive or a trusted local file share. Keep `server.js`, `host-backup.js`, `public/`, and `mac/` together. The project has no npm packages to install.

Install Node.js 20 or later from the [official Node.js downloads page](https://nodejs.org/en/download). Then open Terminal and check:

```sh
node --version
```

The version must be `v20` or later. Node.js is a local runtime; the app does not send shares or analytics to Node.js or another hosted service.

### 2. Start and confirm the Mac server

In Terminal, change into the copied project folder and run:

```sh
node server.js
```

The terminal prints the Join PIN and local addresses. On this Mac, open `http://localhost:8787`. On the Windows PC or phone, use the Mac's printed local address, such as `http://<Mac-host-address>:8787`. Enter the six-digit PIN.

The Mac stores data in `~/.lantern-share/` by default. Its PIN stays the same across restarts because it is stored there. To make the Mac another host in the Windows room, use the pairing steps below after installing the updated project files.

### Pair the Mac with the Windows room

1. Copy the current complete project folder to the Mac, replacing the older project files. Your shares and PIN remain in `~/.lantern-share/`, outside the project folder. From the updated folder, rerun `chmod +x mac/install-server.sh mac/uninstall-server.sh && ./mac/install-server.sh`; this updates and restarts the LaunchAgent with the new server code.
2. On Windows, open Lantern Share on the Windows host and choose **? > Room devices > Create pairing code**. Keep that window/code available.
3. On the Mac, open `http://localhost:8787`, sign in with its current PIN, and choose **? > Pair this host**. Enter a Windows LAN address and the temporary pairing code.
4. The Mac is now paired and takes the Windows room PIN, but it has no Windows notes or files yet. From the Windows or Mac host address on any signed-in device, open **? > Room devices** and tap **Sync now** for a specific host, or **Sync all devices now**.

No content is copied on a timer. Each host keeps its last synchronized snapshot until someone starts a sync. Once the Mac has received a copy, it can serve that copy while Windows is off. Changes made while hosts are apart are exchanged after both hosts are online and someone starts another sync. This works across devices on the same trusted wired or Wi-Fi subnet.

If macOS asks whether Node may accept incoming connections, allow it on your trusted local network. Use the same regular Wi-Fi or wired LAN on every device. Guest Wi-Fi and client isolation can prevent devices from reaching each other.

### 3. Start the server automatically when you sign in

The included LaunchAgent runs the server for your Mac account when you log in and restarts it if it exits. It does not run before anyone signs in, and the Mac must stay awake and connected to the network.

In Terminal, change to the project folder and run:

```sh
chmod +x mac/install-server.sh mac/uninstall-server.sh
./mac/install-server.sh
```

No `sudo` is needed. The installer checks for Node.js 20+, writes a per-user file at `~/Library/LaunchAgents/com.lanternshare.server.plist`, and starts the service. It does not change router settings or create a public address.

Check status and the saved PIN with:

```sh
launchctl print "gui/$(id -u)/com.lanternshare.server"
cat ~/.lantern-share/join-pin.txt
tail -n 40 ~/.lantern-share/server.log
```

### 4. Create the Mac app for the Mac-hosted server

After the server is running, open `http://localhost:8787` in Safari and enter the Join PIN. On macOS Sonoma 14 or later, choose **File > Add to Dock**, name it **Lantern Share**, and add it. In the app's **General** settings, choose `public/brand/lantern-mark.png` as the icon. Use the theme control in the app to choose light or dark mode.

To have the app window open at sign-in, add **Lantern Share** under **System Settings > General > Login Items**. This opens the UI; the LaunchAgent separately starts the server.

### Stop or remove Mac automatic startup

Run:

```sh
./mac/uninstall-server.sh
```

This removes the LaunchAgent and stops its service. It leaves the project folder and `~/.lantern-share/` data in place.

## Build the standalone Mac app DMG

On the Mac, copy the latest complete `InternalSharing` project folder. The builder uses Apple's Swift compiler and disk-image tools already available through Xcode Command Line Tools; it does not download app libraries.

In Terminal, run:

```sh
cd ~/Downloads/InternalSharing
chmod +x mac/build-dmg.sh
./mac/build-dmg.sh
```

The universal app image is created as `LanternShare-Mac.dmg` in the project folder. Open the DMG, drag **Lantern Share.app** to **Applications**, then open it. The app remembers the last local Lantern host address. The server remains a separate install: `mac/install-server.sh` starts it at sign-in if you want this Mac to host. If Xcode Command Line Tools are missing, run `xcode-select --install` and then rerun the builder. If macOS blocks the first launch because the app is not notarized, Control-click the app in Applications and choose **Open** once.

The DMG build reads its icon from `public/brand/lantern-mark.png`; the same mark is available as a scalable SVG and is included in the Android and Windows app icons. See [LOGO_GUIDE.md](LOGO_GUIDE.md) for the logo asset set.

### Move the Windows room to this Mac

1. On Windows, open Lantern Share locally, choose **? > Move this sharing room**, and pause the Windows host.
2. Choose a backup passphrase of at least 12 characters and create the encrypted `.lshare` backup. Copy it to the Mac with a USB drive or a trusted local file share.
3. Start the Mac host with the steps above. Open `http://localhost:8787` in Safari and sign in with its temporary PIN.
4. Choose **? > Move this sharing room**, select the backup, enter its passphrase, and import. The destination must have an empty shelf. Import verifies the backup before replacing the temporary PIN with the Windows room's PIN.
5. Open the Mac's printed private IPv4 address on each device. The source Windows host stays paused; resume it only if you cancel the move. Keep one host active for this room.

The `.lshare` file includes the shelf, uploaded files, and room PIN in encrypted form. Store the passphrase separately from the backup.

## Install the Windows taskbar app with its logo

The earlier Windows shortcut opens a website in an Edge app-style window. Pinning that shortcut or a browser tab can show a generic webpage/Edge icon. For the proper Lantern Share name and logo, install the PWA once:

1. On the Windows host PC, open Microsoft Edge at `http://127.0.0.1:8787` and enter the Join PIN if asked.
2. Select the **App available** icon in the address bar. If it is not shown, use **Settings and more (…) > More tools > Apps > Install this site as an app**.
3. Name it **Lantern Share**. In the install dialog or the app's details, choose **Pin to taskbar**.
4. Unpin the old generic webpage shortcut from the taskbar to avoid duplicates.

Microsoft's guide: [Install, manage, or uninstall apps in Microsoft Edge](https://support.microsoft.com/en-us/edge/install-manage-or-uninstall-apps-in-microsoft-edge). The app manifest supplies the lantern logo and keeps the app in a standalone window.

## Privacy and network notes

- No public domain, cloud storage, third-party file service, analytics, or VPN is required for devices on the same private LAN.
- Use the numeric private IPv4 address printed by the host. Do not use a public IP, router port forwarding, or a public tunnel.
- Keep devices on a trusted regular LAN, not a guest network that blocks device-to-device traffic.
- The default is HTTP on the local network. HTTP is not encrypted against someone who can monitor that network, so use a trusted Wi-Fi password and operating-system firewall.
- The service worker is network pass-through only. It deliberately does not cache notes, files, API results, or credentials for offline access.
- Keep the host awake and connected whenever another device needs to browse, upload, or download.
