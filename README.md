# FreePBX Select

Three-button, single-session Asterisk contact selector. The intercom phone auto-answers; contact names are spoken into the call. The server can be driven by its web page or by HTTP commands from a microcontroller.

**Buttons:** Left = previous, Right = next, Center = start/select/cancel/hang up. The main web interface shows only the current contact name.

## Deployment

1. Configure Asterisk HTTP/ARI and an ARI user; allow the app `freepbxselect` to control calls. ARI must be reachable from the Docker host (usually port 8088), with a suitable firewall. Use a dedicated restricted account and do not expose ARI to the internet.
2. Copy `config.example.json` to `config.json` and set your contacts. Contacts are passed to Asterisk's `from-internal` dialplan through `Local/` channels, so FreePBX routing and permissions apply. Only the contact entries may be dialed.
3. Create a `.env` file with `ARI_URL=http://PBX-IP:8088/ari`, `ARI_USER=...`, `ARI_PASSWORD=...`, `API_KEY=...`, `RTP_HOST=DOCKER-HOST-LAN-IP`.
4. Run `docker compose up -d`. Open `http://DOCKER-HOST:3000`; supply the API key when prompted (stored in the browser session).
5. Configure your intercom extension to **auto-answer ordinary inbound calls**; the ARI originate here does not automatically trigger FreePBX's `*80` paging/intercom signaling.

The container uses **host networking** on Linux so bidirectional RTP between Asterisk and the audio generator works. UDP port 40000 is used for the ARI external-media channel. Keep port 3000 and port 40000 private to trusted hosts and protect API access. Audio synthesis uses eSpeak NG, converted to 8 kHz G.711 mu-law using ffmpeg.

## HTTP controls

```sh
curl -X POST -H 'X-API-Key: YOUR_KEY' http://DOCKER-HOST:3000/api/right
curl -X POST -H 'X-API-Key: YOUR_KEY' http://DOCKER-HOST:3000/api/left
curl -X POST -H 'X-API-Key: YOUR_KEY' http://DOCKER-HOST:3000/api/select
curl -H 'X-API-Key: YOUR_KEY' http://DOCKER-HOST:3000/api/state
```

`GET /api/events` is a server-sent event stream for synchronized UI state. The three controls are shared between all clients.

## Important

This is an initial implementation, **not yet PBX-tested**. ARI must be enabled separately on your FreePBX instance. It needs a successful ARI WebSocket connection and working externalMedia RTP before it can speak names. ExternalMedia normally discovers Asterisk's RTP return address from incoming RTP; if audio never arrives the endpoint or network routing needs investigation. The web UI is deliberately minimal and has no configuration controls.

Pushes to `main` build `ghcr.io/legop3/freepbxselect:latest` using GitHub Actions. The workflow requires GitHub Actions to be enabled and package write access for `GITHUB_TOKEN`.
