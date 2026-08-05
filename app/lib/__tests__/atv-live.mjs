/**
 * LIVE hardware check for the SHIPPING Android TV modules. Not part of CI —
 * it needs a real Google TV on the LAN, so it is run by hand:
 *
 *   node --experimental-strip-types lib/__tests__/atv-live.mjs <tv-ip> [--pair]
 *
 * WHY THIS EXISTS. lib/tvdirect/androidtv.ts injects its socket and hashing
 * precisely so the code that ships can be driven from Node against real
 * hardware. Without this file the app-side port would be unproven until it was
 * inside a TestFlight build, which is the slowest possible place to find a
 * protobuf mistake. With it, only the thin RN socket adapter is device-gated.
 *
 * Proven with it on 2026-08-05 against the bedroom Hisense (10.1.1.98).
 */
import fs from 'node:fs';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import forge from 'node-forge';

import { frame, makeFramer } from '../tvdirect/atvproto.ts';
import { AtvSession, pairStart } from '../tvdirect/androidtv.ts';

const HOST = process.argv[2];
const DO_PAIR = process.argv.includes('--pair');
if (!HOST) {
  console.error('usage: atv-live.mjs <tv-ip> [--pair]');
  process.exit(2);
}
const ID_FILE = new URL('./.atv-identity.json', import.meta.url).pathname;
const CODE_FILE = new URL('./.atv-code.txt', import.meta.url).pathname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- the two injected pieces, Node flavour -------------------------------

const sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

const connect = (host, port, certPem, keyPem) =>
  new Promise((resolve, reject) => {
    const sock = tls.connect(
      // The TV's cert is self-signed by the TV itself. Node opts out of
      // verification with this flag; react-native-tcp-socket has no equivalent
      // and must PIN the cert instead — the whole reason the socket is injected.
      { host, port, cert: certPem, key: keyPem, rejectUnauthorized: false },
      () => {
        const framer = makeFramer();
        const frames = [];
        const waiters = [];
        sock.on('data', (d) => {
          for (const f of framer.push(new Uint8Array(d))) {
            const w = waiters.shift();
            if (w) w.resolve(f);
            else frames.push(f);
          }
        });
        const fail = (e) => { const w = waiters.shift(); if (w) w.reject(e); };
        sock.on('error', fail);
        sock.on('close', () => fail(new Error('socket closed')));
        resolve({
          write: (bytes) => sock.write(frame(bytes)),
          recv: (timeoutMs = 20000) =>
            frames.length
              ? Promise.resolve(frames.shift())
              : new Promise((res, rej) => {
                  const t = setTimeout(() => rej(new Error('recv timeout')), timeoutMs);
                  waiters.push({
                    resolve: (f) => { clearTimeout(t); res(f); },
                    reject: (e) => { clearTimeout(t); rej(e); },
                  });
                }),
          close: () => sock.destroy(),
          peerModulusHex: () => sock.getPeerCertificate().modulus,
        });
      },
    );
    sock.on('error', reject);
  });

// ---- identity ------------------------------------------------------------

function mintIdentity() {
  if (fs.existsSync(ID_FILE)) {
    log('reusing persisted identity');
    return JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
  }
  log('minting RSA-2048 client cert (node-forge)…');
  const t0 = Date.now();
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date('2038-01-19T03:14:07Z');
  const attrs = [{ name: 'commonName', value: 'couchside' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'couchside' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  let modulusHex = keys.publicKey.n.toString(16);
  if (modulusHex.length % 2) modulusHex = '0' + modulusHex;
  const id = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    modulusHex,
  };
  fs.writeFileSync(ID_FILE, JSON.stringify(id));
  log(`minted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return id;
}

// ---- run -----------------------------------------------------------------

const identity = mintIdentity();
const deps = { connect, sha256 };

if (DO_PAIR) {
  const session = await pairStart(HOST, identity, deps);
  log('*** THE TV IS SHOWING A 6-DIGIT CODE ***');
  log(`write it to ${CODE_FILE} — polled every 200ms`);
  try { fs.unlinkSync(CODE_FILE); } catch {}
  const shownAt = Date.now();
  let code = '';
  while (Date.now() - shownAt < 240000) {
    try {
      const v = fs.readFileSync(CODE_FILE, 'utf8').trim();
      if (/^[0-9a-fA-F]{6}$/.test(v)) { code = v; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!code) { session.cancel(); throw new Error('no code arrived'); }
  log(`code ${code} after ${((Date.now() - shownAt) / 1000).toFixed(1)}s — finishing`);
  await session.finish(code);
  log('*** PAIRED (shipping module) ***');
}

const remote = new AtvSession(HOST, identity, deps);
const seq = ['home', 'down', 'down', 'right', 'volume_up', 'volume_up'];
log(`remote session: sending ${seq.join(', ')} (4s apart — watch the TV)`);
for (const k of seq) {
  await remote.sendKey(k);
  log(`  sent ${k}`);
  await new Promise((r) => setTimeout(r, 4000));
}
remote.close();
log('DONE — a sent key is NOT an observed key; confirm on the screen.');
