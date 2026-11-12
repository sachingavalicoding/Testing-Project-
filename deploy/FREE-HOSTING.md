# Put Stock IQ online for free (Oracle Cloud)

Oracle Cloud's **Always Free** server is the only free option that fits this app: it stays on 24/7, keeps your data, and has a fixed IP (Upstox needs one for real orders). Render, Koyeb and similar free plans go to sleep when nobody is using them and lose the database, so the auto trader would stop. Railway and Fly.io no longer have a real free plan.

Takes about 30 minutes. You need a computer (a phone works too, just slower), an email, and a **Visa or Mastercard** debit/credit card for Oracle's check (they take a small refundable hold; RuPay cards are often refused). Nothing is charged as long as you use "Always Free" items.

## 1. Make the free server
1. Sign up at https://signup.cloud.oracle.com. Home region: **India West (Mumbai)**. (You can't change it later.)
2. Menu > **Compute > Instances > Create instance**.
   - Image: **Ubuntu 24.04**.
   - Shape: **VM.Standard.A1.Flex** (ARM, 1 OCPU, 6 GB) if available, otherwise **VM.Standard.E2.1.Micro**. Both say "Always Free eligible".
   - SSH keys: **Save private key** (download it, keep it safe).
   - Click **Create**. Copy the **Public IP address** when it is running.
   - If it says "Out of capacity", try again later or pick the Micro shape.
3. Open the web ports: on the instance page click the **Subnet** > **Default Security List** > **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, TCP, destination port `80,443`. Save.

## 2. Free web address (needed for HTTPS and the Upstox login)
1. Go to https://www.duckdns.org, sign in with Google.
2. Make a name, e.g. `sachin-stockiq`, put the server's **Public IP** in the "current ip" box, click **update ip**.
   Your address is now `sachin-stockiq.duckdns.org`.

## 3. Install the app (one command)
Connect to the server with the key you saved. On a Windows/Mac/Linux computer open a terminal (on the phone: Termux, `pkg install openssh`, and copy the key into Termux):
```bash
ssh -i path/to/your-key.key ubuntu@YOUR_PUBLIC_IP
```
Then run (put your own DuckDNS name):
```bash
curl -fsSL https://raw.githubusercontent.com/sachingavalicoding/Testing-Project-/main/deploy/oracle-setup.sh -o setup.sh
sudo bash setup.sh sachin-stockiq.duckdns.org
```
It installs everything, starts the app, turns on HTTPS, and prints an **app password**. Write it down.

Open `https://sachin-stockiq.duckdns.org` on your phone, log in, then Chrome menu > **Add to Home screen**.

## 4. Upstox keys
1. In the Upstox developer app (your brother's account), set the **Redirect URL** to exactly:
   `https://sachin-stockiq.duckdns.org/api/auth/upstox/callback`
2. On the server: `sudo nano /opt/stock-iq/.env`, fill `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, set `FEED=upstox`. Save (Ctrl+O, Enter, Ctrl+X).
3. `sudo systemctl restart stock-iq`
4. In the app tap **Login to Upstox**. Do this **every morning before 9:15**: Upstox tokens expire every night around 3:30 AM.

## Good to know
- **Keys and password live only in `/opt/stock-iq/.env` on the server.** Never put them in GitHub.
- **Update to new code:** run `sudo bash setup.sh sachin-stockiq.duckdns.org` again. Your `.env` and trades stay.
- **See what it's doing:** `sudo journalctl -u stock-iq -f` (Ctrl+C to stop watching).
- **Real money** stays locked (`REAL_TRADING_ENABLED=false`). Before unlocking: register this server's Public IP as the static IP in Upstox, and get your brother's OK.
- Oracle can stop free servers that look idle (very low CPU) for 7 days, and this app is light, so it may count as idle. To avoid that, upgrade the account to **Pay As You Go** (Billing > Upgrade). Always Free items stay free; set a budget alert of ₹1 to be safe.
- Phone (Termux) still works for paper trading if you don't want a server. See the main README.
