#!/bin/bash
# Builds the macOS release files (Apple silicon) into release/:
#   Tadcap-<version>-arm64.dmg   drag-and-drop installer
#   Tadcap-<version>-arm64.zip   the app for scripts/install.sh
#
# Signing (docs/release-notarization.md):
# - APPLE_SIGNING_IDENTITY unset (or "-"): the app is ad-hoc signed and not notarized.
# - APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)": Tauri signs the app with the hardened
#   runtime, notarizes and staples it before it builds the dmg; this script then signs, notarizes and staples the dmg
#   and checks that Gatekeeper accepts both. Notarization uses an App Store Connect API key: APPLE_API_ISSUER (issuer
#   ID), APPLE_API_KEY (key ID) and APPLE_API_KEY_PATH (the AuthKey_<key id>.p8 file).
# CI=true makes the Tauri bundler pass --skip-jenkins to bundle_dmg.sh, which skips the AppleScript that asks
# Finder to lay out the dmg window. That script needs permission to control Finder, which a terminal or a CI
# runner may not have; without it the dmg keeps the default layout (the app and an Applications link).
set -euo pipefail

cd "$(dirname "$0")/.."
version="$(node -p "require('./package.json').version")"
bundle="src-tauri/target/release/bundle"

notarize=0
if [ "${APPLE_SIGNING_IDENTITY:-"-"}" = "-" ]; then
  export APPLE_SIGNING_IDENTITY="-"
else
  # Without these Tauri signs the app but skips notarization with only a warning; stop before the long build instead.
  for v in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
    [ -n "${!v:-}" ] || { echo "$v is required to notarize (APPLE_SIGNING_IDENTITY is set)" >&2; exit 1; }
  done
  [ -f "$APPLE_API_KEY_PATH" ] || { echo "APPLE_API_KEY_PATH: $APPLE_API_KEY_PATH not found" >&2; exit 1; }
  notarize=1
fi

CI=true npm run tauri build -- --bundles app,dmg

app="$bundle/macos/Tadcap.app"
dmg="release/Tadcap-$version-arm64.dmg"
rm -f release/Tadcap-*-arm64.dmg release/Tadcap-*-arm64.zip
mkdir -p release
cp "$bundle/dmg/Tadcap_${version}_aarch64.dmg" "$dmg"

if [ "$notarize" = 1 ]; then
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
  # notarytool can exit 0 for a rejected submission, so read the status from its JSON output.
  result="$(xcrun notarytool submit "$dmg" --wait --timeout 1h --output-format json \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")"
  status="$(node -p 'JSON.parse(process.argv[1]).status' "$result")"
  if [ "$status" != "Accepted" ]; then
    id="$(node -p 'JSON.parse(process.argv[1]).id' "$result")"
    echo "notarization of $dmg: $status (see: xcrun notarytool log $id --key ... --key-id ... --issuer ...)" >&2
    exit 1
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  xcrun stapler validate "$app"
  spctl -a -vv -t install "$dmg"
  spctl -a -vv "$app"
fi

# ditto keeps the bundle's symlinks, extended attributes, signature and stapled ticket intact (zip -r does not).
ditto -c -k --sequesterRsrc --keepParent "$app" "release/Tadcap-$version-arm64.zip"
ls -l release/
