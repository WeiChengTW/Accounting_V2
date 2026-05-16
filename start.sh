#!/bin/bash
cd "$(dirname "$0")"

# Kill any existing process on port 5001
fuser -k 5001/tcp 2>/dev/null
sleep 1

# Start Flask app (using venv)
nohup .venv/bin/python3 app.py >> app.log 2>&1 &
sleep 2

# Start ngrok tunnel
ngrok start --all --config ngrok.yml --log /tmp/ngrok_accounting_v2.log &
sleep 3

# Show tunnel URL
curl -s http://localhost:4042/api/tunnels 2>/dev/null \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['tunnels']; [print(x['public_url'], '->', x['config']['addr']) for x in t]" \
  2>/dev/null || cat /tmp/ngrok_accounting_v2.log | head -10

echo ""
echo "Flask running on http://localhost:5001"
echo "Update LINE Developers Console:"
echo "  Webhook URL: <ngrok_url>/callback"
echo "  LIFF Endpoint URL: <ngrok_url>/liff"
