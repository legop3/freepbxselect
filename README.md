# FreePBX Select

A Docker-hosted three-button contact selector for FreePBX/Asterisk. The single shared menu can be controlled through its minimal web interface or by HTTP requests from a microcontroller. The selected contact's **name** is the only main-screen content. Left = previous, center = start/select/cancel/hang up, right = next.

## Setup

1. In FreePBX, enable the Asterisk HTTP server and REST Interface (ARI), and create an ARI user with write access. Restrict Asterisk's HTTP port to the trusted LAN.
2. Edit **compose.yml directly**: set `ARI_URL`, `ARI_USER`, `ARI_PASSWORD`, `RTP_HOST` (the Docker host IP reachable from FreePBX), `INTERCOM_ENDPOINT`, and `CONTACTS_JSON`.
3. Start with `docker compose up -d`. Open `http://DOCKER-HOST:3000` (change PORT if needed).
4. Allow RTP from Asterisk to the Docker host UDP port 40000. Compose uses Linux host networking.

## TTS

The image includes **Piper TTS** and the `en_US-lessac-medium` neural voice. Piper generates raw 22050 Hz 16-bit mono PCM and FFmpeg converts it to 8 kHz G.711 mu-law for RTP. The voice can be overridden using `PIPER_MODEL` (path inside the container) and `PIPER_SAMPLE_RATE` (match the voice's sample rate). There is no external TTS service.

## Intercom auto-answer

When originating the intercom call, the app requests these SIP headers through ARI:

- `Call-Info: <sip:freepbxselect@localhost>;answer-after=0`
- `Alert-Info: <http://www.notused.com>;info=alert-autoanswer`

Whether auto-answer works depends on the SIP phone model, firmware, and its provisioning. **The headers request auto-answer but cannot override phone firmware restrictions.** Other models may require a different Alert-Info value; no phone settings are automatically changed.

## HTTP API (no authentication)

```sh
curl -X POST http://DOCKER-HOST:3000/api/left
curl -X POST http://DOCKER-HOST:3000/api/right
curl -X POST http://DOCKER-HOST:3000/api/select
curl http://DOCKER-HOST:3000/api/state
```

`GET /api/events` supplies state updates through Server-Sent Events. All clients share the same live menu. Keep the HTTP port private to a trusted network: any machine that can reach these endpoints can control and initiate phone calls.

## Build

Pushes to `main` trigger GitHub Actions, which builds and pushes `ghcr.io/legop3/freepbxselect:latest`.

The Asterisk/Piper functionality must be tested with your actual FreePBX and SIP phone. Watch the Docker logs for speech synthesis errors and ARI failures.
