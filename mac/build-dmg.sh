#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE="$SCRIPT_DIR/LanternShareMac.swift"
MARK="$PROJECT_ROOT/public/brand/lantern-mark.png"
OUTPUT_DMG="${1:-$PROJECT_ROOT/LanternShare-Mac.dmg}"

for command_name in xcrun lipo sips iconutil hdiutil codesign; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required macOS build tool '$command_name' was not found. Install Xcode Command Line Tools and retry." >&2
    exit 1
  fi
done
for required_file in "$SOURCE" "$MARK"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required project file is missing: $required_file" >&2
    exit 1
  fi
done

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lantern-share-dmg.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
APP="$BUILD_ROOT/Lantern Share.app"
ICONSET="$BUILD_ROOT/LanternShare.iconset"
STAGING="$BUILD_ROOT/dmg-root"
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$ICONSET" "$STAGING"

for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$MARK" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -s format png -z "$doubled" "$doubled" "$MARK" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/LanternShare.icns"

for arch in arm64 x86_64; do
  xcrun swiftc -O -target "${arch}-apple-macosx12.0" -framework AppKit -framework WebKit \
    "$SOURCE" -o "$BUILD_ROOT/LanternShare-$arch"
done
lipo -create "$BUILD_ROOT/LanternShare-arm64" "$BUILD_ROOT/LanternShare-x86_64" -output "$CONTENTS/MacOS/LanternShare"
chmod 755 "$CONTENTS/MacOS/LanternShare"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>LanternShare</string>
  <key>CFBundleIconFile</key><string>LanternShare</string>
  <key>CFBundleIdentifier</key><string>com.lanternshare.mac</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Lantern Share</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSLocalNetworkUsageDescription</key><string>Lantern Share connects directly to your chosen Lantern host on your local network.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
ditto "$APP" "$STAGING/Lantern Share.app"
ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/Read Me.txt" <<'README'
Lantern Share for Mac

Drag Lantern Share.app into Applications, then open it.
The app connects to a Lantern Share host on your private network.
The Lantern server can be installed separately with mac/install-server.sh.
README

mkdir -p "$(dirname -- "$OUTPUT_DMG")"
hdiutil create -volname "Lantern Share" -srcfolder "$STAGING" -ov -format UDZO "$OUTPUT_DMG" >/dev/null
echo "Created universal Lantern Share Mac app disk image: $OUTPUT_DMG"
