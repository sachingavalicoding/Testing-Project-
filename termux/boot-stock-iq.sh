#!/data/data/com.termux/files/usr/bin/bash
# Copied to ~/.termux/boot/ by setup.sh. With the Termux:Boot app installed, this starts Stock IQ when the phone restarts.
termux-wake-lock
cd "$HOME/stock-iq" 2>/dev/null || exit 0
nohup bash termux/start.sh > data/boot.log 2>&1 &
