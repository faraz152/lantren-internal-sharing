# Lantern Share for Android

The Android app is a small native Kotlin client that opens the Lantern Share room hosted by a Windows PC, Mac, or Linux Mint computer. It includes Android file picking for uploads, the system download manager for downloads, and the web app's notes, image/video/audio previews, and paired-host sync controls.

## Install the APK

1. Copy `LanternShare-Android.apk` from the project folder to your Android phone using a USB cable or a trusted device-to-device transfer method.
2. Open the APK on the phone and allow your file manager/browser to install apps from this source if Android asks.
3. Open **Lantern Share**, enter the local address printed by the host, and tap **Connect**.
4. Enter the host's six-digit room PIN. The app remembers the last host address on that phone.
5. Open **? > Room devices** to see paired hosts and manually start **Sync now** or **Sync all devices now**. A sync transfers data only when you tap a sync button.

The phone and host must be on the same trusted Wi-Fi or wired local network. Use the numeric private address printed by the host if a `.local` address does not resolve on your Android version.

## Build the APK from source

Open the `android/` folder in Android Studio and choose **Build > Build APK(s)**, or open PowerShell in the project's `android` folder and run:

```powershell
.\gradlew.bat assembleDebug
```

The completed debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

This APK is a client. It lets Android browse a host and request manual sync between paired desktop hosts; it does not turn the phone into a background Lantern Share server.
