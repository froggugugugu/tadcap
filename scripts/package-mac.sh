#!/bin/bash
# Builds the macOS release files (Apple silicon) into release/:
#   Tadcap-<version>-arm64.dmg   drag-and-drop installer
#   Tadcap-<version>-arm64.zip   the app for scripts/install.sh
#
# The app is ad-hoc signed (tauri.conf.json: bundle.macOS.signingIdentity "-") and not notarized.
# CI=true makes the Tauri bundler pass --skip-jenkins to bundle_dmg.sh, which skips the AppleScript that asks
# Finder to lay out the dmg window. That script needs permission to control Finder, which a terminal or a CI
# runner may not have; without it the dmg keeps the default layout (the app and an Applications link).
set -euo pipefail

cd "$(dirname "$0")/.."
version="$(node -p "require('./package.json').version")"
bundle="src-tauri/target/release/bundle"

CI=true npm run tauri build -- --bundles app,dmg

rm -f release/Tadcap-*-arm64.dmg release/Tadcap-*-arm64.zip
mkdir -p release
cp "$bundle/dmg/Tadcap_${version}_aarch64.dmg" "release/Tadcap-$version-arm64.dmg"
# ditto keeps the bundle's symlinks, extended attributes and signature intact (zip -r does not).
ditto -c -k --sequesterRsrc --keepParent "$bundle/macos/Tadcap.app" "release/Tadcap-$version-arm64.zip"
ls -l release/
