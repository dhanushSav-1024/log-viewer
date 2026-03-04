#!/bin/bash

URL="https://github.com/dhanushSav-1024/log-viewer/releases/download/v0.2/log-view-x64"
FILE="log-view"

echo "Downloading..."
curl -L "$URL" -o "$FILE"

echo "Making executable..."
chmod +x "$FILE"

echo "Installing to /usr/local/bin..."
sudo mv "$FILE" /usr/local/bin/log-view

echo "Installed successfully!"
echo "Run with: log-view"