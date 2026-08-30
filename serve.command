#!/bin/sh
# Double-click to start the concession menu on this Mac.
cd "$(dirname "$0")" || exit 1
echo "Concession Menu running at http://localhost:8000"
echo "On the same Wi-Fi, use http://$(ipconfig getifaddr en0 2>/dev/null || echo THIS-MACS-IP):8000"
echo "Press Control-C to stop."
python3 -m http.server 8000
