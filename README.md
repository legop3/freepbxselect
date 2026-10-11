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


## Persistent menu and incoming calls to extension 777

The Docker app now automatically calls the intercom whenever ARI connects, and reconnects if the menu phone is hung up. When a caller dials **777**, Asterisk can pass that caller to the same existing ARI bridge. The caller and the intercom speak without the intercom receiving a second call. On caller hangup, the menu resumes.

**This requires one manual FreePBX dialplan configuration** (the GitHub repository cannot install configuration on your PBX):

1. Back up `/etc/asterisk/extensions_override_freepbx.conf` on the FreePBX host.
2. Review [freepbx/extensions_override_freepbx.conf](freepbx/extensions_override_freepbx.conf). Merge its `[ext-local]` extension-777 override and `[freepbxselect-fallback]` context into the existing file. Do not duplicate an existing context heading. If you already have an override for 777, reconcile it instead of replacing it.
3. Run `fwconsole reload`, then `asterisk -rx 'dialplan show 777@ext-local'` to verify the effective dialplan goes through `Stasis(freepbxselect,incoming)`.
4. Test by calling **777** from a different extension. The existing intercom menu call should transition into the incoming call and return to the menu afterward.
5. Stop the Docker app and call 777 again: the fallback should dial the PJSIP phone normally. This fallback uses a direct `Dial(PJSIP/777,30)`, so it does not reproduce every FreePBX feature such as Follow Me or voicemail.

**Caution:** `extensions_override_freepbx.conf` overrides FreePBX's generated dialplan. Only extension 777 should be overridden. Review the effective dialplan before putting the change into service, especially if 777 already has custom dialplan behavior. If the PJSIP device ID differs from 777, adjust the fallback.

When an incoming call arrives during an outbound call, the app transfers it to the fallback instead of taking over the active conversation. Incoming calls are handled deterministically by the Stasis dialplan entry rather than an event-monitoring race.

## Build

Pushes to `main` trigger GitHub Actions, which builds and pushes `ghcr.io/legop3/freepbxselect:latest`.

The Asterisk/Piper functionality must be tested with your actual FreePBX and SIP phone. Watch the Docker logs for speech synthesis errors and ARI failures.
