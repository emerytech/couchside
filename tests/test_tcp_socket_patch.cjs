'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { patchSource, patchPackage, before, after } = require('../app/scripts/patch-tcp-socket-android.cjs');

test('patch is narrowly scoped, repeatable, and refuses unreviewed source', () => {
    const source = `untouched TLS and write methods\n${before}\nuntouched certificate methods`;
    const patched = patchSource(source);
    assert.equal(patched.replace(after, before), source);
    assert.equal(patchSource(patched), patched);
    assert.throws(() => patchSource(source.replace('socketClient.destroy();', 'different();')), /changed upstream/);
    assert.throws(() => patchSource(source + before), /changed upstream/);
});

test('dependency upgrades stop instead of silently skipping the fix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchside-tcp-version-'));
    try {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'react-native-tcp-socket', version: '6.4.3' }));
        assert.throws(() => patchPackage(dir), /review upgrades explicitly/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real dependency cleanup survives queued missing-client closes; existing clients still close', () => {
    // CI supplies an isolated, exact-version dependency. Never patch a shared
    // node_modules tree just to run a test. Execute the dependency's actual end()
    // body on a JVM with the same two-worker executor and concurrent client map.
    const pkgDir = process.env.TCP_SOCKET_PACKAGE_DIR;
    assert.ok(pkgDir, 'set TCP_SOCKET_PACKAGE_DIR to an isolated react-native-tcp-socket 6.4.2 package');
    const file = path.join(pkgDir, 'android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketModule.java');
    const original = fs.readFileSync(file, 'utf8');
    const method = original.includes(before) ? before : after;
    assert.equal(patchPackage(pkgDir), method === before);
    assert.equal(patchPackage(pkgDir), false);
    const patched = fs.readFileSync(file, 'utf8');
    assert.equal(patched.replace(after, before), original.replace(after, before));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchside-tcp-java-'));
    try {
        for (const [name, body, expectedErrors] of [['Before', before, 1], ['After', after, 0]]) {
            const harness = `
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
class ${name} {
  static class TcpSocket {}
  static class TcpSocketClient extends TcpSocket {
    final AtomicInteger closes = new AtomicInteger();
    void destroy() { closes.incrementAndGet(); }
  }
  static class TcpSocketServer extends TcpSocket {}
  final ConcurrentHashMap<Integer,TcpSocket> socketMap = new ConcurrentHashMap<>();
  final AtomicInteger errors = new AtomicInteger();
  final ExecutorService executorService = Executors.newFixedThreadPool(2, r -> {
    Thread t = new Thread(r);
    t.setUncaughtExceptionHandler((thread,e) -> errors.incrementAndGet());
    return t;
  });
  TcpSocketClient getTcpClient(int id) {
    TcpSocket s=socketMap.get(id);
    if(s==null) throw new IllegalArgumentException("No socket with id "+id);
    if(!(s instanceof TcpSocketClient)) throw new IllegalArgumentException("Not a client");
    return (TcpSocketClient)s;
  }
  ${body}
  public static void main(String[] args) throws Exception {
    ${name} m = new ${name}();
    CountDownLatch entered=new CountDownLatch(2), release=new CountDownLatch(1);
    for(int i=0;i<2;i++) m.executorService.execute(() -> {
      entered.countDown();
      try { release.await(); } catch(InterruptedException e) { throw new RuntimeException(e); }
    });
    if(!entered.await(5,TimeUnit.SECONDS)) throw new AssertionError("worker gate");
    TcpSocketClient stale=new TcpSocketClient(), live=new TcpSocketClient(), other=new TcpSocketClient();
    m.socketMap.put(1530,stale); m.socketMap.put(2,live); m.socketMap.put(3,other);
    m.end(1530); // cleanup is queued, then the client is gone before it runs
    m.socketMap.remove(1530);
    m.end(2);
    release.countDown();
    m.executorService.shutdown();
    if(!m.executorService.awaitTermination(5,TimeUnit.SECONDS)) throw new AssertionError("workers leaked");
    if(m.errors.get()!=${expectedErrors}) throw new AssertionError("uncaught errors: "+m.errors);
    if(stale.closes.get()!=0 || live.closes.get()!=1 || other.closes.get()!=0)
      throw new AssertionError("wrong client closed");
    System.out.println("queued-cleanup errors="+m.errors+" live-client-closes="+live.closes);
  }
}`;
            fs.writeFileSync(path.join(dir, `${name}.java`), harness);
            const compiled = spawnSync('javac', [`${name}.java`], { cwd: dir, encoding: 'utf8', timeout: 30000 });
            assert.equal(compiled.status, 0, compiled.stderr);
            const run = spawnSync('java', ['-cp', dir, name], { cwd: dir, encoding: 'utf8', timeout: 10000 });
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, new RegExp(`errors=${expectedErrors} live-client-closes=1`));
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
