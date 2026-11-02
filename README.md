# TAKweb

> **TAKweb** is an independent open-source project and is not affiliated with the TAK Product Center.

**TAKweb** = TAK in the browser (web app), TAK access with registration and approval (OpenTAKServer) and
camera streams that end up in the TAK server automatically. Plus a server and phone app for the Bluetooth helmet camera (ESP32-CAM, firmware from
[ESP32-Flash](https://github.com/fredy060795/ESP32-Flash)).

```
Helmet camera ──Bluetooth──▶ phone (browser, stays online) ──HTTPS──▶ your server ──▶ ATAK / WinTAK / admin
```

- **One link per stream:** `https://<domain>/<user>/<streamId>` – enter this link in ATAK/WinTAK as a video source.
  Every stream has its own random stream id, a user can have several streams. So there are no conflicts,
  even when many streams run at the same time.
- **QR code for the user:** opens the phone app. Connect the camera via Bluetooth, "Start stream" – done.
- **Admin window** (own domain possible): login, password reset by e-mail (SMTP), all streams with status, link
  and QR code. "View" opens freely movable video windows (move, resize, maximize, minimize,
  close). "Block all streams", stop/enable single streams, **kick** a phone or **delete** a stream.

## Links per stream

| Link | Format | Note |
|---|---|---|
| `https://<domain>/<user>/<streamId>` | MJPEG | main link, low latency, no ffmpeg needed. Opened in a browser: fullscreen view (tap: fill/whole image) |
| `https://<domain>/<user>/<streamId>/index.m3u8` | HLS (H.264) | needs ffmpeg on the server, approx. 4–8 s latency; **for OpenTAKServer** |
| `https://<domain>/<user>/<streamId>/stream.ts` | MPEG-TS (H.264) | needs ffmpeg, continuous HTTP stream |
| `https://<domain>/<user>/<streamId>/snapshot.jpg` | JPEG | last image |

Which format your ATAK/WinTAK plays best is easiest to try with a running stream – all three
deliver the same image. The frame rate comes from the camera via Bluetooth (at 320x240 about 2–5 frames/s).

## Automatically in the TAK server (OpenTAKServer)

As soon as OpenTAKServer is connected in the admin under **Settings → OpenTAKServer & registration**, the server registers every
camera stream **automatically** as a video feed in OTS – nothing to do by hand:

- New streams (self-registration, EUD, created manually) get a path from the name, e.g. `cam/alpha-10`.
- OTS/MediaMTX pulls the video itself on demand via the **HLS link** (`…/index.m3u8`, `sourceOnDemand`) –
  for this the streams server needs ffmpeg (included in the Docker image) and a public address
  (Admin → Links & QR codes → address of this server, or `PUBLIC_URL`).
- In ATAK/WinTAK the stream appears under **Video** as `rtsp://<TAK server>:8554/<path>`.
- Blocking, switching off (checkbox in the "TAK path" column) or deleting removes the stream again.

The admin has **one** section for this, **Video feeds**: at the top the cameras from TAKweb (phone/helmet camera – whoever
starts video in TAKweb is an OTS feed `cam/<callsign>` right away), below **all feeds in the TAK server** with their origin
("TAKweb: …" or "external"), the ATAK link to copy and the form for more feeds (path + source
rtsp/rtmp/srt/udp/HLS, MediaMTX pulls the video on demand). For the cameras mainly the **path** is maintained: change the field in the "TAK path" column
and press Enter – the old path is removed in OTS, the new one created (empty = automatic again). The dot shows
the state (green = registered, yellow = waiting, red = error with an explanation on hover). More switches:
"Add new streams automatically", "only while the camera is sending" (otherwise: while enabled), path prefix and
**⟳ Sync** (also happens at startup and every 10 minutes).

Without an OTS connection you can still enter the HLS link (button "QR / Links") by hand in OTS under
**Video streams → Add Video** as a source.

## Drone (DJI), screen and external cameras

Everything ends up as a feed in the TAK server (ATAK/iTAK/WinTAK under "Video") – nothing to create. MediaMTX in
OpenTAKServer checks the **TAK user and password** and creates the feed itself on the first push.

| Source | How |
|---|---|
| **DJI drone** (DJI Fly / DJI Pilot 2) | ⋯ → Transmission/Livestream → **RTMP** → paste the address from the access page |
| **OBS, Larix Broadcaster** | RTMP, RTSP or SRT (addresses below) |
| **Phone screen** | "Larix Screencaster" app (Android) with the RTMP address – phone browsers cannot share the screen |
| **PC screen** | TAKweb → Video → **🖥 Share screen** (desktop browsers only) |
| **Helmet camera / phone as a camera without TAK access** | camera app `/app/` (QR under "Links & QR codes") |

Addresses (filled in on the access page `/access/` and in TAKweb under Video – without typing a password if TAKweb was opened from the access page – and as a template in the admin under Video feeds):

```
rtmp://<TAK server>:1935/drone-<callsign>?user=<user>&pass=<password>
rtsp://<user>:<password>@<TAK server>:8554/drone-<callsign>
srt://<TAK server>:8890?streamid=publish:drone-<callsign>:<user>:<password>
```

Ports 1935 (RTMP), 8554 (RTSP) and 8890/udp (SRT) must be reachable on the TAK server.

**Drone address without a password:** whoever logged in on this device in TAKweb (user + password, QR code with
login, setup package) or opened it from the access page gets the address under Video → Drone right away – unique per
user (`drone-<callsign>`). The password is kept on the device only after the TAK server confirmed it (like ATAK).
**Registered users never type it:** when the device is connected to our OpenTAKServer with the user's certificate (OTS
checked it in the TLS handshake), TAKweb hands over the login it manages for that user – also after a login by data
package/.p12 or in an iPhone home-screen app. Only users TAKweb does not manage (OTS accounts created elsewhere) type
their TAK password once – the TAK server checks it (no new certificate), then it is kept like in ATAK.

## Field of view and drone telemetry (UAS in HQ)

- **Cones ("funnels")** show where a camera looks: for every contact or marker with a field of view (`<sensor>` like in
  ATAK – e.g. ATAK UAS Tool, other TAKweb users), in 2D and 3D.
- **Own stream:** while the phone or helmet camera is live, the own position carries the view direction, angle
  (60°/66°) and 100 m range – ATAK and TAKweb show the cone. Phone camera: direction of the back of the phone (compass,
  also in north-up mode); helmet camera: the GPS course while moving, standing still the phone's compass (fits when
  the phone is carried facing forward). The compass is allowed with the tap on the stream button (iPhone asks once) –
  no need to switch the compass on first. Cones are at least ~70 px long on the screen at any zoom.
- **Drone telemetry (KLV, MISB ST 0601):** when a drone feed carries KLV (professional drones, ATAK UAS Tool, QGroundControl,
  STANAG 4609 encoders), TAKweb shows while watching it: **the drone** (position, height, view direction and cone),
  **the image area on the ground** (corners from KLV or computed from height, angle and field of view) and **the image
  centre** (SPI). The player shows e.g. `UAS 1050 m · 227° · FOV 60° ⌖` (tap = drone on the map). The viewer also
  sends the drone to the TAK server, so ATAK in HQ sees it too.
  - The server reads the KLV track with ffmpeg while someone watches (shared by all viewers). For feeds of the own
    TAK server it uses RTSP of MediaMTX with the OTS login (RTSP keeps KLV, OTS's HLS usually does not).
  - **DJI Fly / DJI Pilot 2 (RTMP)** send only the video – no position or direction of the drone. Use a KLV source or
    ATAK UAS Tool for that.

## Aligning the image (every helmet is mounted differently)

The user can align on the phone (card "Align") and the admin in the viewer window – both see the same setting.

- **View** → **∠ Align**: slider for any angle from 0 to 359.5° (clockwise), fine steps
  −90/−5/−1/+1/+5/+90°, 0°, **Mirror** and for oblique angles **Fill** (the edge is cropped, no black
  corners) or **Whole image** (black corners). The result is visible in the live image after about a second.
- The list shows the angle of every stream, and it can be typed in there directly.
- **Settings → rotation:** base angle for new streams (e.g. 90° if the camera sits sideways in the housing),
  optionally applied to all existing streams.

The phone rotates every image before it is sent. So all links (MJPEG, HLS, MPEG-TS, snapshot)
and therefore OpenTAKServer/ATAK already get the aligned image – nothing to adjust on import.
From 45° the image becomes portrait; HLS/MPEG-TS restart briefly when switching landscape/portrait.

## Workflow

1. In the admin window show or print the **QR code for all users** (one code for everyone).
2. The user scans it and enters **name** and **unit** → they automatically get their own stream
   (e.g. `https://<domain>:5036/max-mueller/qugzu48s8q`). The phone remembers the sign-up.
3. Choose the source: **phone camera** (rear camera) or **helmet camera (Bluetooth)** and align it. The page shows
   **"Ready"** – nothing is sent yet.
4. You switch on with **▶ Live** in the admin (list or viewer window); the phone vibrates briefly and sends.
   **■ Live off** or **All to ready** switches back to "Ready".
5. In the admin list: align, image size, TAK path, block, kick or delete.

Keep the phone screen on and the app in the foreground (otherwise the phone stops camera and Bluetooth).

The admin sets the **image size** – per stream in the list or in the viewer window, the default for new streams under
Settings (preset **160x120, very fast**). Choices: 160x120, 320x240, 640x480, 1280x720 (only sensible for the
phone camera). Changes apply immediately on the phone, even while streaming; the user only sees the image size.

**Phone camera:** works in every phone browser over HTTPS – also Safari on iPhone. About 5 frames/s. Under **Camera** all cameras the device reports can be selected: rear/front camera
and connected **USB/UVC cameras** (Windows/macOS/Linux, iPad with USB-C, some Android devices; not iPhone).
The phone remembers the choice.

**Aligning on the phone:** after connecting, the page shows a preview and the card **Align**
(⟲/⟳ 90°, ±5°, ±1°, 0°, Mirror). The preview shows exactly the image that is sent – so align before
"Start stream". The setting applies to the phone and helmet camera, is stored on the server and is visible in the
admin; the admin can change it there at any time.

**Helmet camera (Bluetooth):** Android with **Chrome** (not Samsung Internet/Firefox). On iPhone no browser can do
Bluetooth – use the free **Bluefy** app there; the page shows the way ("Copy the link for Bluefy").

**Address of the server** (in the admin): sets which address appears in QR codes and all links, e.g.
`https://tak.example.com:5036`. Empty or "Automatic" = `PUBLIC_URL` or the address used to open the page. The setting
takes precedence over `PUBLIC_URL` and survives a restart.

**Admin puts streams live** (switch in the admin, default on): after connecting, users wait for "▶ Live". Off =
users start the stream themselves with "Start stream". The page must stay open – browsers stop camera and
Bluetooth when the page goes to the background. On Android use ATAK and the page in **split screen**.

**Users may start by themselves** (only with "Admin puts streams live"): users additionally see "Start stream". The admin
can press "■ Live off" at any time.

**Notifications:** when someone signs up, activates the camera or starts by themselves, a popup with a sound appears in the admin.
With **🔔 Notifications** you can additionally allow desktop notifications – they also arrive when the
admin window is in the background.

**Video from TAKweb/camera app allowed** (switch in the admin) blocks new sign-ups when needed; running streams stay.
Whoever is deleted can sign up again with the general QR code – if that should not be possible, block
self-registration. Optionally streams can still be created manually with their own QR code.

## Android app (APK)

One app for every TAKweb server (`mobile/`, Capacitor): it opens the server from the invitation and adds what a browser
cannot – **the position keeps being sent with the screen locked** (notification "TAKweb"), no new permission prompts
after every start.
- **For users:** access page (or TAKweb → Settings on Android) → **1 · Download the app** → **2 · Open in the TAKweb app**
  – server and login are taken over (`takweb://open?u=…`). Or in the app: **scan the TAKweb QR code** (camera or a photo of
  it). There is no free address field. In the app: Settings → CHANGE SERVER. Android asks once to allow installing apps
  from the browser.
- **Safe:** the app only takes a real TAKweb server (it checks `/api/eud/app`), and a link to *another* server is only
  followed after the user confirmed "Connect to this TAKweb server?" – any web page could offer a `takweb://` link.
  Server not reachable → RETRY or OTHER SERVER, the app is never stuck on a wrong address.
- **Meshtastic over Bluetooth** works in the app too (native Bluetooth instead of Web Bluetooth, `blenative.js`).
- **Permissions in the app:** Android keeps the app's permissions – no permission bar after every start like in the browser. Only when location was really refused does a bar appear; ALLOW opens the app settings.
- **Download:** `/download/takweb.apk` on the TAKweb server – a `takweb.apk` in the data folder (e.g. without internet in
  the field), otherwise the GitHub release (`TAKWEB_APK_URL`, default: release `android` of this repository).
- **Build:** GitHub Actions (`.github/workflows/android.yml`) builds the APK for every change in `mobile/` and publishes it
  on `main` as release `android`. Sign every version with the same key – add the secrets `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (Settings → Secrets → Actions); without them
  the APK is debug-signed and an update needs the old app uninstalled first.
- **iPhone:** no app outside the App Store/TestFlight (Apple developer account needed) – TAKweb in Safari/Bluefy as before.

## TAKweb app (map + situational picture on the phone)

At `https://<server>/eud/` there is **TAKweb**, a lean TAK client as a web app (PWA) at ATAK CoT level,
with an **English** user interface (multinational). Runs on Android and iPhone (Safari → Share → "Add to
Home Screen"). Laid out like ATAK:

- **Top bar like ATAK, put together by the user:** by default maps, markers, draw, chat and video, plus the menu
  (tile grid: Servers, Contacts & Markers, Clear Content, Data Packages, Maps, Overlays, Data Sync, Video, Meshtastic,
  R&B Line, Draw, Bloodhound, Markers, Chat, Settings). Menu → **✎**: tap tools to put them on top
  (★, up to 5 plus the menu – more do not fit in portrait – in the order tapped), DEFAULT resets. Stored on the device in the profile – survives every update.
- **Draw** (top bar, circle-and-square icon like ATAK): opens **Line, Rectangle, Polygon, Circle** and 9 colors.
  Line/polygon: tap the points, then DONE; rectangle: two opposite corners; circle: center and a point on the edge.
  The shapes are ATAK CoT (`u-d-f`, `u-d-r`, `u-d-c-c` with stroke/fill colors) – they show in ATAK/WinTAK/iTAK,
  go to all servers and over Meshtastic, and can be renamed and deleted; the window shows radius/length.
- **Bloodhound:** in the window of a marker, user or drawing → BLOODHOUND, or the Bloodhound tool and tap a target
  (marker, user or a point on the map). A line from the own position to the target with distance, bearing and – while
  moving – time of arrival, updated every second (red, < 500 m yellow, < 100 m green). STOP ends it.
- **Users who lose their connection** (no internet, app closed) stay on the map **greyed out at their last position**
  ("connection lost – last position") – also when the TAK server reports the disconnect – and disappear after 60 min
  without an update, like mesh users. A new position makes them normal again.
- **Contacts & Markers** split by type like the ATAK overlay manager: **Contacts** (users), markers
  **Friendly / Hostile / Neutral / Unknown** (by 2525 affiliation), other points, drawings & routes –
  every group can be expanded and collapsed and cleared on its own with 🗑. **Clear Content** clears several groups at
  once, plus overlays and chat; optionally own markers are deleted on the TAK server too.
- **Left:** compass – the needle always points north. Tap: a map rotated by hand goes back to north up;
  if it is north up, heading up "HDG" (without a sensor by GPS course), again = north up "N".
  The compass button only turns the map – the **own arrow always turns**: GPS course while moving, otherwise the
  phone's compass. Below it "zoom to me".
- **Permissions after every start:** if location or compass are missing (the iPhone asks again each time TAKweb was
  closed and allows the compass only with a tap), a bar appears right away – **ALLOW** asks for both with one tap; if
  still refused it says where to switch it on in the settings.
- **Gestures like ATAK:** rotating two fingers = rotate the map (only after ~12° so zooming does not wobble; on a PC
  Shift + mouse wheel), pushing two fingers up/down together = tilt – also from the flat map.
- **Right:** slider for tilting (double tap = flat). When tilted, TAKweb shows a **real 3D map** like
  WinTAK (MapLibre GL): terrain with elevation, sky and horizon, tilt up to **88°**, symbols stand upright with
  names, routes/areas lie on the terrain, own markers can be moved and tapped in 3D too.
  At 0° it goes back to the flat map (for drawing, measuring, corridor) – with the same extent and the same
  rotation. **3D is the default** (Map → 3D MAP: can be switched off, "Start in 3D view", terrain exaggeration 1–3×). Elevation data:
  the free *AWS Terrain Tiles* (Terrarium) through our own tile cache; "Save for offline use"
  stores them too. Without WebGL 2 or without elevation data: flat tilt (up to 60°) or 3D without terrain.
- **Bottom right:** connection indicator (green = connected, yellow = only some, red = offline; tap =
  servers) and the own position: callsign, MGRS, altitude, direction, speed, accuracy. Scale bottom left.
- **Markers** (marker button at the top): name prefix + index like ATAK; choose affiliation (Unknown/Neutral/Hostile/
  Friendly), dimension (Ground, Air, Sea, Sub, Space) and MIL-STD-2525 symbol (e.g. infantry,
  armor, artillery, helicopter, fighter, drone/UAV, ship, submarine, satellite), then tap the spot.
- **Tapping the own position bottom right** opens the callsign menu.
- All windows open as a sheet at the bottom (on the right in landscape), only one at a time.

**Core functions**

1. Place **markers** (see above). **Move** (like ATAK: tap the marker → MOVE, then drag it or tap the new position –
   so zooming and panning never move a marker by accident), **rename** or delete them in the popup – the change goes to all servers with the same UID, like in ATAK.
2. **Connect servers** – Menu → Servers. **Several TAK servers at once**, everything on one map.
   Per server: QR code (ATAK enrollment `tak://…/enroll?…`, iTAK `name,host,port,ssl`), data package (.zip),
   certificate (.p12), truststore or by hand (address, port, SSL/TCP/UDP, user + password →
   "Request certificate", port 8446). Unknown server certificates only after confirming the fingerprint.
3. **Chat** – chat "All" (GeoChat); the window can be minimized and closed. Messages are deleted automatically after 3 days.
4. **Video stream** – tap "Phone camera" or "Helmet camera (Bluetooth, Android/Chrome)": the stream
   starts right away (also when "Admin puts streams live" is set in the admin – the admin gets a
   notification). The link is in the own position, ATAK users see it on the contact. The own preview can be
   minimized or hidden (the stream keeps running). **Watching streams:** all streams in the situational picture and the
   feeds of the TAK server in the viewer (MJPEG/HLS; RTSP is copied). The viewer behaves like the chat: docked at the
   bottom (landscape: right), minimize = header only, tap the header = large again, fullscreen, close;
   video and chat stack instead of covering each other.
   **Feeds of other systems:** TAKweb plays HLS (`.m3u8`) in all browsers with hls.js (also OpenTAKServer feeds with `?jwt=…` – the key is passed to all parts of the stream); if it fails, the message shows the video server's answer. RTSP feeds from
   OpenTAKServer/MediaMTX (`rtsp://host:8554/path`, as ATAK/iTAK play them) are fetched automatically through the
   HLS output of MediaMTX (`http://host:8888/path/index.m3u8`). This runs through our own server
   (`/api/eud/media`: video files only, the target is checked like the TAK relay) – no mixed content, no CORS.
   If it still fails: a message and a button "Open in new tab" or "Copy address (VLC)".

**TAK data** (Menu → TAK Data, through API port 8443 with the client certificate):
load data packages from the server, **Data Sync** (subscribe to missions – also password-protected ones –, content
is updated automatically on changes, ⟳ reloads right away; with OpenTAKServer the missions created in ATAK
with `tool=public` are found too, and points for which the server only delivers metadata still appear
on the map), **overlays** (KML/KMZ from packages, missions or the
device, also raster maps with several detail levels; stay stored offline).
**Auto push like ATAK:** if the TAK server sends a data package to the device or invites it to a
mission, both are loaded or subscribed automatically. Errors while fetching are in the server log
("EUD TAK-API … error").

**KML/KMZ from any program** (Google Earth, Google My Maps, QGIS, CalTopo, WinTAK …): UTF-16 and ISO-8859-1 files,
prefixed KML (`kml:Placemark`), Google Earth tracks (`gx:Track`), coordinates with spaces; icons that do not load
(offline, `http://` on an https page) become dots. A file that only links to data elsewhere (My Maps "Keep data up to
date") gets a hint to export it with the data.
**Large map images** (GroundOverlay, e.g. a printed game map of 11 000 × 8 000 px in a KMZ or ATAK data package):
phones cannot show them. On import the server (ffmpeg) turns them into an overview (4096 px) plus full-resolution
pieces (2048 px, WebP) – zoomed out the overview, zoomed in only the visible pieces; sharp and light (38 MB -> 5 MB).

**Device profile like ATAK (auto-enrollment):** after logging in, TAKweb fetches the TAK server's enrollment profile
once and on every connection the connection profile (only what is new since the last sync). In OpenTAKServer these
are the data packages marked "install on enrollment/connection", the map sources (they appear under Menu → Maps as
"… (TAK server)", also for saving offline and 3D) and device profile settings (callsign, team, role – an
administrator's assignment in TAKweb has priority).

**Map** (Menu → Map): choose the source (OpenStreetMap, OpenTopoMap, Esri Satellite/Topo or a custom
URL with `{z}/{x}/{y}`). Tiles go through this server and are cached there under `DATA_DIR/tiles`.
**Save offline:** the visible area or a drawn **corridor**
(width in m) with zoom from/to; saved areas can be shown and deleted. Please only load
areas you need – the free map services do not allow bulk downloading.
**Bluefy and other iPhone apps without service workers** (WKWebView): saved areas are kept in the device storage
(IndexedDB) and shown from there – keep TAKweb open while saving. Open TAKweb once online; then the map also works offline.

**Without internet:** the app, saved tiles, situational picture and overlays stay on the device. GPS keeps
running, markers and chats wait in the outbox and go out as soon as the connection is back.

**Meshtastic (LoRa, without internet)** – Menu → **Meshtastic**: TAKweb connects directly to a Meshtastic radio
over Bluetooth (Android: Chrome; iPhone: only in the "Bluefy" app – Safari has no Bluetooth). Positions and chat go
over LoRa as TAK packets (port 72, like the Meshtastic ATAK plugin), so TAKweb users and ATAK users with the plugin
see each other without internet. Players with only the Meshtastic app appear on the map as users like in ATAK
(team colour from the end of the node name like the plugin: "Hans -5" = Red, without a suffix Cyan), their text
messages in the chat. **Markers, moving/renaming and deleting** go over LoRa as CoT on port 257 like the plugin
(zlib; larger ones as fountain blocks with acknowledgement) – also markers from ATAK users arrive this way. Over LoRa go the chat to All (also as Meshtastic text, can be switched off) and direct
messages; team and group chats stay on the TAK server (the TAK packets of the plugin have no rooms).
- **Sending:** by default **always – online and over LoRa**, so devices without internet (only on the mesh) also get
  positions, chat and markers of online users. What arrives twice (server + mesh) is shown once (same UID / message ID).
  "Only when offline" saves airtime when everybody has internet. Position every 30 s / 1 / 2 / 5 min (earlier after moving 50 m), channel selectable.
- **Bridge mesh ↔ TAK server** (on by default): a device with radio and TAK server passes on what only one side has –
  from the mesh to the server positions of TAK users, chat "All", markers, drawings and deletions; from the server over
  LoRa the same (positions of a contact at most every 5 min; markers from WinTAK/ATAK are slimmed to what a TAK client
  needs and, if still larger than one packet, sent in blocks like the ATAK plugin). Only live content – what a server sends
  again right after connecting stays off LoRa (independent of the clocks of WinTAK PCs). Several gateways do not collide: each waits a random moment
  and skips what another one already passed on; passed-on content carries a mark and never goes back (no loops).
  Plain Meshtastic nodes and texts (e.g. strangers on a public channel) are not passed to the TAK server.
  **Direct messages** from the mesh to another device (e.g. one only online, or whose radio is off) go to the TAK server
  addressed to that device alone, and only the recipient shows them. The other way (online sender → mesh-only device)
  only works when the sender has a radio itself: the TAK server delivers a direct message only to its recipient.
- **Video:** while a video stream runs (phone or helmet camera) the radio is released and reconnected when the stream ends.
- If the connection is lost, TAKweb keeps reconnecting; after reloading the page it reconnects by itself where the browser
  allows it, otherwise tap RECONNECT. The icon above the server status shows the state (green = connected, yellow = connecting or paused for
  video, red = not connected).
- A radio accepts only one Bluetooth connection: disconnect the Meshtastic app first. Keep the screen on.
- TAK packets compressed on the radio by older firmware cannot be read; current firmware passes them through unchanged.

**Limits of a web app:** a TAK server on the phone itself (e.g. in the Meshtastic app,
`127.0.0.1:8088`) cannot be reached by a web app – browsers cannot open TCP/TLS connections.
That needs the EUD as an installed app. iOS pauses web apps in the background;
Safari has no Bluetooth (helmet camera on iPhone only through the "Bluefy" app).

**Security:** this server only relays the data (`/ws/tak`, `/api/eud/marti`). Certificates and
keys stay on the phone only. Enter your own TAK server in the admin under "Allowed TAK servers"
so nobody uses the server as an open relay. Without an entry all servers are
allowed – except the server machine itself (`localhost`) and link-local addresses.

## TAK access (OpenTAKServer)

Users request real TAK access here; after approval the app creates the account on the
**OpenTAKServer (OTS)** and the user gets login details, QR codes and an illustrated guide.

> **No OpenTAKServer yet?** [TAKweb Server](https://github.com/fredy060795/5040-TAKweb_Server) is a TAK server in a single
> file for Windows and Raspberry Pi (installs in one step, links several servers via federation) and speaks the same
> OTS web API. Enter `https://<server>:8443` as OTS address with its admin login and allow the self-signed certificate.
> Users, groups, roles, ATAK QR codes, truststore, device profiles and missions work; video feeds (MediaMTX) and
> Meshtastic are not part of it.

**Workflow**

1. The user opens `https://<server>/join/` (QR code in the admin: "Users & requests" → "Registration QR"), reads
   briefly what TAK can do and sends a request (name, unit, requested callsign, e-mail; optional code word,
   optional e-mail confirmation via SMTP). They get a confirmation e-mail right away
   ("TAKweb – registration request received", with their personal status link) and see what happens next
   after submitting. The **status page** shows a timeline (request → e-mail confirmed if needed → approval →
   login details), refreshes itself and says whether the approval comes by e-mail. The admin gets an e-mail for every new request.
2. The admin sees the request (notification + list "Open") and approves it – **nothing happens without
   approval**. They set the **callsign** (overrides e.g. "Horst" with "ALPHA 10"), **team** and **role**.
3. The app creates the OTS account (role "user", username from the callsign, a random password per user
   (optionally a fixed one); afterwards it checks that logging in with it works), sets the
   team groups if needed and creates the ATAK enrollment QR code. The user gets an e-mail (if SMTP)
   or the admin gives them the link shown.
4. On the access page `/access/` (for multinational users): callsign, team, role, server,
   user, password, **truststore download**, QR codes and a step-by-step guide for
   **ATAK** (Android), **iTAK** (iPhone) and **TAKweb** (the QR opens the EUD with all data, the
   certificate is requested automatically).

**Management** (Admin → Users & requests): search/filter, approve, decline, edit, block/unblock
(the OTS account is deactivated), new password, new ATAK QR, copy access link, delete (also on OTS).

**Overriding callsign, team and role:** the app sets OTS device profiles for every device of the user
(`locationCallsign`, `locationTeam`, `atakRoleType`). **ATAK** applies them on its (next) connection to
the server; new devices are detected every 2 minutes ("Sync with OTS" forces it right away). In the
**web EUD** team and role apply immediately and are locked (the relay also enforces them in the sent position);
the **callsign is only a suggestion and stays editable** – several players can share one login (quick game), each with
their own callsign. After a login by QR code/link TAKweb asks once to check the callsign; a later change by the admin
is only taken over if the user kept the previous one. **iTAK** does not apply server profiles – there the user sets callsign/team as shown on the access page.

**ATAK without typing:** the ATAK QR code on the access page is a normal https link – scan it with the phone camera,
the page opens, download the **ATAK setup package** (`.zip`) and open it with ATAK. The package contains server,
user, password, callsign, team, role and the OTS truststore (password configurable, default `atakatak`);
ATAK imports it, requests its certificate and connects. This also works with a self-signed
server certificate. The `tak://…/enroll` QR from OTS stays as an alternative – according to OTS it only works with a publicly
trusted certificate (e.g. Let's Encrypt), and many camera apps do not open `tak://` links at all.
The package can also be opened with iTAK.

**Teams and visibility:** default: everyone sees everyone – every approved user is in the OTS group of their team
(`TEAM_<NAME>`) with **IN + OUT** (send and receive), reads the groups of the other teams and exchanges with devices
without a group (`__ANON__`, e.g. users created by hand). Single users can be set to **receive only** (IN off) or
**send only** (OUT off) under Users → Edit. When a checkbox is removed in the "Who sees whom?" matrix, the team no
longer reads the other's group, OTS then does not deliver its positions, markers and chats. Exchange with devices without a group (`__ANON__`) continues (can be switched off);
a hidden team does not send to `__ANON__`, otherwise it would be visible there after all. At startup and with
"Sync with OTS" all users' groups are brought to this state; devices reconnect afterwards. This lets several units share a server
without disturbing each other. (Requirement: OTS with channels/groups, default `OTS_ENABLE_CHANNELS=True`,
no LDAP.)

**Missions and groups:** OTS only shows users with a group the missions of their IN groups. A mission created
in the admin without choosing groups therefore gets **all** groups; missions without any group are marked
"⚠ none – invisible in ATAK/TAKweb" and can be fixed with **Share with all**.

**Setup:** Admin → Settings → OpenTAKServer & registration:
- Address of the OTS web UI/API (e.g. `https://ots.example.com`, or internally `http://127.0.0.1:8081`
  if both run on the same machine), OTS admin user and password (**without two-factor**).
- Public TAK address for the devices (put into the QR codes) and ports (8089/8446/8443).
- "Test connection", then open registration and hand out the registration QR code.

**Security:** the passwords of the TAK accounts and the OTS admin password are stored in `DATA_DIR/db.json`
(file mode 600) so the access page can show the data; the access link is secret (48 characters) and
worthless after blocking/deleting. Registrations are limited to 5 per hour and IP.

## Clear map on all devices (after a mission)

Admin → **Clear map (all devices)**: choose what to remove (markers by affiliation, other points, drawings & routes,
overlays, contacts, chat) and an optional note. Every TAKweb device asks its user right away (or when it connects next):
**CLEAR NOW** removes it, **LATER** asks again at the next connection. Only content from before the request is removed –
new markers stay – and cleared content does not come back when a TAK server sends it again. A new request replaces the
old one; "Withdraw request" ends it. ATAK/iTAK/WinTAK are not affected.

## Federation (TAK servers exchange data)

Admin → TAK server → **Federation**: OpenTAKServer has no federation of its own – TAKweb connects to every listed
server as a TAK client (own certificate per server) and passes data on **in all directions**:

- **Live data** (positions, markers, drawings, chat, deletions) right away to every other server.
- **Data packages** every N minutes (or "Sync now"): what one server has and another does not is copied – compared
  by SHA-256, so nothing arrives twice; uploaded like ATAK (`/Marti/sync/missionupload`, the server keeps the hash).
- **No loops, no duplicates:** forwarded CoT carries a marker (`<__takwebfed>`) and is never passed on again; the same
  event from two servers is forwarded once; pings, mission changes and file transfer requests stay on their server.
- **Servers:** the own OpenTAKServer from the settings (certificate with the OTS login, automatically) plus any number
  of others: address, ports, and **user + password** (only used to request the certificate – not stored) or a
  **.p12**. An unknown server certificate is asked once (fingerprint). Live data and data packages can be switched
  per server; the table shows status and how much went in/out.
- What TAKweb sees on a server follows the groups of its certificate user there.

## Managing the TAK server (in the TAKweb admin)

Under **TAK server** in the sidebar TAKweb manages OpenTAKServer like its own UI:

- **OTS users:** all accounts from OTS – including those created directly in OTS – with role, active/blocked,
  groups, devices and last login. **New user** creates an account without registration (callsign, optional
  username/password/e-mail, team, role, OTS administrator) and shows the access link. **Import** additionally manages
  an existing OTS user in TAKweb (callsign, team, access page; optionally a new password and
  team groups). Also: role user/administrator, block/activate, set password, maintain groups (IN/OUT), delete.
- **Groups:** create, delete (`__ANON__` stays).
- **Missions (Data Sync):** create (description, password, groups; OTS requires a known device as
  creator – preselected), list, set groups, delete.
- **Meshtastic:** create channels (name, radio preset, region, generate key, up-/downlink) or import via
  Meshtastic link, copy link, delete.

Users & requests shows **all** TAKweb users by default (open requests on top) – approved users
no longer disappear from the list.

## Admin

**TAKweb admin** in a dark ATAK style with a sidebar – daily work on top, one-time settings at the bottom:
- **TAK:** *Users & requests* (number of open requests, button "Registration QR"), *Teams & visibility*,
  *Links & QR codes* – **one** server address for all links and QR codes (registration, TAKweb app, camera app);
  a change applies everywhere right away, also to the video feeds OTS pulls
- **TAK server:** *OTS users*, *Groups*, *Missions*, *Meshtastic*
- **Video:** *Video feeds* (TAKweb cameras and all OTS feeds; switches "Video allowed", "Admin puts streams live"), *Create stream*
- **Settings:** *OpenTAKServer & registration* (connection, passwords, registration – set up once),
  *TAKweb app*, *System* (admin login, SMTP, defaults for new streams)

- **Helpers** (System → Helpers): separate admin logins that may only approve/decline requests, edit users
  (callsign, team, role, block, new password/QR), create new TAK users and show links/QR codes –
  no settings, no deletions, no OTS administrators, no stream keys. The server checks this
  on every request; helpers can only change their own password under "My password".
- **🔔 Notifications** (header): list of the latest events (new registration requests, cameras registered/active,
  live started/ended) with an unread counter and direct buttons ("Open requests", "View", "▶ Live");
  sound, popup and desktop notification can be switched separately there. Popups are for information only: at most 3 at a time, they disappear after 6 s by themselves (a click opens the list with the actions).
- First login: **admin / admin123**. Then your own username and a new password must be set right away
  (nothing else is possible before that).
- **System:** enter the admin e-mail and SMTP server, "Send test mail". SSL/TLS is chosen automatically for ports 465
  (SSL/TLS) and 587/25 (STARTTLS) – this fixes "wrong version number". After that
  "Forgot password?" works on the login page: the reset link is sent to the admin e-mail and is valid for 1 hour.
  The admin e-mail also receives a notification with a link to the admin for every new registration request.
- After 10 wrong passwords the login is blocked for that IP for 15 minutes.

## Testing on a Windows PC

1. Download the repository (**Code → Download ZIP**) and unpack it.
2. Double-click **start.bat**. If Node.js is missing, the window offers to install it (winget); then run start.bat
   again. On the first start the packages are installed (needs internet).
3. On the first start start.bat creates **its own HTTPS certificates** (test CA in `data\certs`) and adds the
   test CA to Windows – Windows asks, choose **"Yes"**. Chrome and Edge then trust the page without a
   warning (if one still appears: restart the browser).
4. The admin window opens at `https://<PC-IP>:5036/admin/` (first login admin / admin123).
   If Windows asks about the firewall, choose "Allow access".
5. Create a stream → **QR / Links**. There you additionally find the QR code **"Certificate for the phone"**:
   scan it once per phone, download the file and install it
   - Android: Settings → Security → Encryption & credentials → Install a certificate →
     CA certificate → choose the file
   - iPhone: download the profile, install it under Settings → General → VPN & Device Management and enable
     "full trust" under About → Certificate Trust Settings
6. Then scan the QR code for all users → sign up → choose the camera → start the stream.

If the page does not load on the phone: is the phone on the same Wi-Fi (no guest Wi-Fi, no mobile data)? start.bat opens port 5036 and
Node.js in the Windows firewall and removes block rules for Node.js (asks once for administrator rights).
If that does not work, double-click **firewall.bat** and choose "Yes" (details in `firewall.log`); if the window shows more
addresses of the PC, try one of them.

The test CA is kept; if the PC's IP changes, only the server certificate is recreated (phones do not have to
install anything again). If an old server is still running on port 5036, start.bat stops it automatically.
For HLS/MPEG-TS on the PC install ffmpeg (`winget install Gyan.FFmpeg`) or put it into `tools\ffmpeg\bin\`.
All messages are also written to `start.log`.

The test certificates are only meant for testing on a PC. On a server on the internet use a real certificate
(Let's Encrypt, see below).

## Installation on the server

### With Docker (recommended) – port 5036

The server runs on **port 5036** with HTTPS (needed for camera and Bluetooth in the phone browser). The easiest way is with the
certificate that already exists on the server (e.g. the Let's Encrypt certificate of the TAK server):

1. In `docker-compose.yml` replace `tak.example.com` with your own domain (in `PUBLIC_URL` and the
   certificate paths).
2. Open port 5036 in the firewall.
3. `docker compose up -d`
4. Open `https://<domain>:5036/admin/` and log in with admin / admin123.

Stream links then look like this: `https://<domain>:5036/<user>/<streamId>`. Renewed certificates are
picked up automatically.

If ports 80/443 are free, Caddy can fetch the certificates instead: `docker compose --profile caddy up -d`
(enter the domains in `deploy/Caddyfile`, remove `TLS_CERT`/`TLS_KEY` from `docker-compose.yml`).

### Without Docker

Requirements: Node.js 20 or newer (recommended: 22 LTS), ffmpeg (for HLS/MPEG-TS, optional) and a certificate. The service
`deploy/helm-camera.service` starts the server with HTTPS directly on port 5036; alternatively behind a
reverse proxy (examples: `deploy/Caddyfile`, `deploy/nginx.conf`).

```sh
sudo useradd --system helmcam
sudo git clone https://github.com/fredy060795/5036-TAKweb /opt/helm-camera
cd /opt/helm-camera && sudo npm ci --omit=dev
sudo cp deploy/helm-camera.service /etc/systemd/system/   # adjust the domains in it
sudo systemctl daemon-reload && sudo systemctl enable --now helm-camera
```

### Settings (environment variables)

| Variable | Meaning | Default |
|---|---|---|
| `PUBLIC_URL` | public address for links, QR codes and reset mails, e.g. `https://tak.example.com:5036` – **set it**, otherwise there are no reset mails | from the request |
| `ADMIN_HOST` | admin only reachable under this domain, e.g. `admin.example.com` | admin on every domain |
| `ADMIN_URL` | address for links in reset mails | from `PUBLIC_URL` (with `ADMIN_HOST` as the domain) |
| `PORT` / `BIND` | port and address of the server | `5036` / `0.0.0.0` |
| `DATA_DIR` | data directory (admin, SMTP, streams) | `./data` |
| `FFMPEG_PATH` | path to ffmpeg | `ffmpeg` |
| `MAX_TAK_PER_IP` | TAKweb devices per public IP (players often share one field router / Starlink) | `40` |
| `TAKWEB_APK_URL` | where `/download/takweb.apk` leads (own build / fork) – a `takweb.apk` in the data folder has priority | release `android` of this repository |
| `TLS_CERT` / `TLS_KEY` | HTTPS directly in the server instead of a reverse proxy | – |
| `TEST_CA_FILE` | test only: CA file offered for download at `/ca.crt` (set by start.bat) | – |
| `TRUST_PROXY` | `1` = evaluate X-Forwarded headers from the reverse proxy | `1`, with `TLS_CERT` `0` |

All data is stored in `DATA_DIR/db.json` (admin password only as a scrypt hash).

**Updating an installation from before November 2026:** the data (`DATA_DIR`) stays as it is. Rename the environment
variables to `TAKWEB_*` (e.g. `TAKWEB_APK_URL`). The Android app has a new app ID and link scheme (`takweb://`):
uninstall the old app on the phones, install TAKweb and open the invitation link again (or scan the QR code).

## For developers

Node.js 20 or newer (22 LTS recommended). Run the commands in the TAKweb folder (the one with `package.json`), and
`npm install` again after every update – otherwise the server stops with a message which packages are missing.
On Ubuntu/Mint the distribution's Node.js is often too old (18):
`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

```sh
npm install
npm start      # http://localhost:5036/admin/
npm test       # end-to-end tests (admin, phone WebSocket, MJPEG, HLS/TS, rotation, stop/kick, SMTP reset, OTS mock)
```

Phone → server: WebSocket `wss://<domain>/ws/publish?u=<user>&s=<streamId>&k=<key>`, every binary message
is a JPEG. The server answers with JSON (`welcome`, `config` with rotation, `stats`, `stopped`, `revoked`, `removed`,
`replaced`, `invalid`).
Camera → phone: for the Bluetooth protocol see `PROTOCOL.md` in the ESP32-Flash repository.
