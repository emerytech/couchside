/**
 * P4b H.264 WebCodecs tier — the DECODER. Hosts a react-native-webview whose OWN
 * JS opens the box's `ws://<host>:<port>/ws/h264` WebSocket, segments the raw
 * H.264 Annex-B byte stream into access units (on the AUD start code), and feeds
 * each AU to a WebCodecs `VideoDecoder`, painting the `VideoFrame`s to a canvas.
 *
 * WHY THE WEBSOCKET LIVES IN THE PAGE, NOT RN: the 60fps video bytes must NOT
 * cross the RN bridge (base64 + JS marshalling was the MJPEG-tier ceiling). The
 * page opens the socket directly to the agent; RN only receives small JSON stats.
 *
 * WHY baseUrl `http://localhost/`: WebCodecs `VideoDecoder` is gated on a SECURE
 * CONTEXT (a null-origin inline page returns `VideoDecoder === undefined` — a
 * false negative, proven with the probe). `http://localhost` IS a secure context
 * (localhost is "potentially trustworthy"), AND — unlike `https://localhost` — an
 * http-origin page may open a plain `ws://` without a mixed-content block (the
 * agent is LAN-only http, no TLS). The page reports `isSecureContext` in its
 * first `env` message so a device-side false negative is caught immediately.
 *
 * ANNEX-B, NOT AVCC: the decoder is configured with NO `description`, so it reads
 * the Annex-B elementary stream directly; SPS/PPS ride inline before each IDR
 * (the box encodes with h264parse config-interval=-1). The codec string is parsed
 * from the SPS (profile/constraint/level) so the level always covers the stream.
 */
import { useMemo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';

export type H264Profile = '720p30' | '720p60' | '1080p30' | '1080p60';

/** Messages the decoder page posts back to RN (small JSON, not the video path). */
export type H264Msg =
  | { t: 'env'; hasVideoDecoder: boolean; isSecureContext: boolean | null; origin: string }
  | { t: 'wsopen' }
  | { t: 'wsclose'; code: number }
  | { t: 'wserror' }
  | { t: 'configured'; codec: string }
  | { t: 'cfgerror'; codec: string; msg: string }
  | { t: 'firstframe'; ms: number }
  | { t: 'decerror'; msg: string }
  | { t: 'chunkerror'; msg: string }
  | {
      t: 'stats';
      decFps: number;
      paintFps: number;
      framesDecoded: number;
      framesPainted: number;
      kbRx: number;
      queue: number;
      codec: string | null;
      decErrs: number;
    };

type Props = {
  host: string;
  port: number;
  token: string;
  profile?: H264Profile;
  onMessage?: (m: H264Msg) => void;
  style?: StyleProp<ViewStyle>;
};

// The decoder page. WS_URL is substituted per-connection (see buildHtml). Kept as
// a single string so the whole hot path lives in the WebView engine.
function decoderScript(): string {
  return `
var canvas=document.getElementById('c'), ctx=canvas.getContext('2d');
function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
post({t:'env', hasVideoDecoder: typeof VideoDecoder!=='undefined',
      isSecureContext: (typeof isSecureContext!=='undefined'? isSecureContext : null),
      origin: location.origin});

var decoder=null, configured=false, codecStr=null, gotKey=false;
var framesDecoded=0, framesPainted=0, bytesRx=0, tFirstFrame=0, decErrs=0;
var ts=0, fps=30, tStart=Date.now();

function hx(n){ return ('0'+((n)&0xff).toString(16)).slice(-2); }
function scLen(a,i){ if(a[i]===0&&a[i+1]===0){ if(a[i+2]===1)return 3; if(a[i+2]===0&&a[i+3]===1)return 4; } return 0; }
function codecFromAU(au){ for(var i=0;i<au.length-4;){ var sc=scLen(au,i);
  if(sc){ var t=au[i+sc]&0x1f; if(t===7) return 'avc1.'+hx(au[i+sc+1])+hx(au[i+sc+2])+hx(au[i+sc+3]); i+=sc+1; } else i++; } return null; }
function auHasIDR(au){ for(var i=0;i<au.length-4;){ var sc=scLen(au,i);
  if(sc){ if((au[i+sc]&0x1f)===5) return true; i+=sc+1; } else i++; } return false; }

function setupDecoder(cs){ codecStr=cs;
  decoder=new VideoDecoder({
    output:function(frame){ framesDecoded++;
      if(!tFirstFrame){ tFirstFrame=Date.now(); post({t:'firstframe', ms: tFirstFrame - tStart}); }
      try{ if(canvas.width!==frame.displayWidth){ canvas.width=frame.displayWidth; canvas.height=frame.displayHeight; }
           ctx.drawImage(frame,0,0); framesPainted++; }catch(e){}
      frame.close();
    },
    error:function(e){ decErrs++; post({t:'decerror', msg:String(e&&e.message||e)}); }
  });
  try{ decoder.configure({ codec: cs, optimizeForLatency:true, hardwareAcceleration:'prefer-hardware' });
       configured=true; post({t:'configured', codec: cs}); }
  catch(e){ post({t:'cfgerror', codec: cs, msg:String(e&&e.message||e)}); }
}

var buf=new Uint8Array(0);
function findAUDs(a){ var pos=[]; for(var i=0;i<a.length-4;){ var sc=scLen(a,i);
  if(sc){ if((a[i+sc]&0x1f)===9) pos.push(i); i+=sc+1; } else i++; } return pos; }
function feed(u8){ bytesRx+=u8.length;
  var nb=new Uint8Array(buf.length+u8.length); nb.set(buf); nb.set(u8,buf.length); buf=nb;
  var pos=findAUDs(buf); if(pos.length<2) return;
  for(var k=0;k+1<pos.length;k++){ handleAU(buf.subarray(pos[k],pos[k+1])); }
  buf=buf.slice(pos[pos.length-1]);
}
function handleAU(au){
  if(!configured){ var cs=codecFromAU(au); if(cs){ setupDecoder(cs); } else { return; } }
  if(!configured) return;
  var key=auHasIDR(au);
  if(!gotKey){ if(!key) return; gotKey=true; }   // must start on a keyframe
  try{ decoder.decode(new EncodedVideoChunk({ type: key?'key':'delta', timestamp: ts, data: au }));
       ts += Math.round(1e6/fps); }
  catch(e){ decErrs++; post({t:'chunkerror', msg:String(e&&e.message||e)}); }
}

var ws;
try{ ws=new WebSocket(WS_URL); }catch(e){ post({t:'wserror'}); }
if(ws){ ws.binaryType='arraybuffer';
  ws.onopen=function(){ post({t:'wsopen'}); };
  ws.onclose=function(e){ post({t:'wsclose', code:e.code}); };
  ws.onerror=function(){ post({t:'wserror'}); };
  ws.onmessage=function(ev){ if(typeof ev.data!=='string'){ feed(new Uint8Array(ev.data)); } };
}

var lastDec=0, lastPaint=0, lastT=Date.now();
setInterval(function(){ var now=Date.now(); var dt=(now-lastT)/1000||1;
  post({t:'stats', decFps:+(((framesDecoded-lastDec)/dt).toFixed(1)),
        paintFps:+(((framesPainted-lastPaint)/dt).toFixed(1)),
        framesDecoded:framesDecoded, framesPainted:framesPainted,
        kbRx:Math.round(bytesRx/1024), queue: decoder?decoder.decodeQueueSize:-1,
        codec:codecStr, decErrs:decErrs });
  lastDec=framesDecoded; lastPaint=framesPainted; lastT=now;
}, 1000);
`;
}

function buildHtml(host: string, port: number, token: string, profile: H264Profile): string {
  const wsUrl = `ws://${host}:${port}/ws/h264?token=${encodeURIComponent(token)}&profile=${profile}`;
  // JSON.stringify safely injects the URL as a JS string literal.
  const script = decoderScript().replace('WS_URL', JSON.stringify(wsUrl));
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"></head>
<body style="margin:0;background:#000;overflow:hidden;height:100vh">
<div style="display:flex;align-items:center;justify-content:center;width:100vw;height:100vh">
<canvas id="c" style="max-width:100%;max-height:100%"></canvas></div>
<script>${script}</script>
</body></html>`;
}

export function H264DecoderView({ host, port, token, profile = '720p30', onMessage, style }: Props) {
  const html = useMemo(() => buildHtml(host, port, token, profile), [host, port, token, profile]);
  return (
    <WebView
      style={style}
      originWhitelist={['*']}
      javaScriptEnabled
      // http://localhost/ = secure context (VideoDecoder present) AND allows ws://.
      source={{ html, baseUrl: 'http://localhost/' }}
      onMessage={(e) => {
        try {
          onMessage?.(JSON.parse(e.nativeEvent.data) as H264Msg);
        } catch {
          /* ignore non-JSON */
        }
      }}
    />
  );
}
