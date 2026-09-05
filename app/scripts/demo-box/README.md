# Demo box (design review fixture)

A stdlib-Python fake agent on `127.0.0.1:8787` that answers the Console's
endpoints (`/api/status`, `/api/media`, `/api/gaming`, `/api/stream-host`,
`/api/units`, art + cover PNGs) with a populated, slowly moving dataset, so the
web build can be screenshotted fully lit without a real box.

```bash
python3 scripts/demo-box/fixture_server.py          # terminal 1
EXPO_PUBLIC_DEMO=1 npx expo start --web --port 8098  # terminal 2 → http://localhost:8098/?skin=<key>
```

`EXPO_PUBLIC_DEMO=1` makes `lib/demo.ts` pre-pair the web session with this box
(only when nothing is paired yet). Never set it for a store build.
