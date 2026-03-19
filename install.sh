#!/bin/env bash
set -e
URL="https://github.com/dhanushSav-1024/log-viewer/releases/download/v0.7/log-view-linux-x64"
BINARY="log-view"
INSTALL_DIR="/usr/local/bin"

echo "Downloading..."
curl -fL --progress-bar "$URL" -o "/tmp/$BINARY"

echo "Installing..."
sudo install -m 755 -o root -g root "/tmp/$BINARY" "$INSTALL_DIR/$BINARY"

rm -f "/tmp/$BINARY"

echo "Installed to $INSTALL_DIR/$BINARY"
echo "Run with: log-view"