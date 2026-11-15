'use strict';

// react-native-tcp-socket is MIT licensed; its existing notices stay intact.
// Android 6.4.2 queues destroy() through end(). A failed/cancelled connection
// can have no client registered when that worker runs. getTcpClient() throws
// outside a catch there, killing the app (Razr crash: TcpSocketModule.java:143).
// Also bound native TCP/TLS connects below. Certificate verification, writes and iOS are untouched.
const fs = require('node:fs');
const path = require('node:path');

const before = `    public void end(final Integer cId) {
        executorService.execute(new Runnable() {
            @Override
            public void run() {
                TcpSocketClient socketClient = getTcpClient(cId);
                socketClient.destroy();
            }
        });
    }`;
const after = `    public void end(final Integer cId) {
        executorService.execute(new Runnable() {
            @Override
            public void run() {
                // Couchside: closing an absent client is already complete.
                // A connect failure/cancellation can race this queued cleanup.
                TcpSocket socket = socketMap.get(cId);
                if (socket instanceof TcpSocketClient) {
                    ((TcpSocketClient) socket).destroy();
                }
            }
        });
    }`;

function patchSource(source) {
    if (source.split(after).length === 2 && !source.includes(before)) return source;
    if (source.split(before).length !== 2 || source.includes(after)) {
        throw new Error('TCP socket Android cleanup changed upstream; review this patch before building.');
    }
    return source.replace(before, after);
}

// Both native workers can otherwise wait for OS TCP timeouts (or forever in
// TLS negotiation), with JS destroy() queued behind them. Bound the native
// attempt itself, including handshake, so switching boxes can make progress.
const connectBefore = `        final int connectTimeout = options.hasKey("connectTimeout") ? options.getInt("connectTimeout") : 0;${String.fromCharCode(32)}
        socket.connect(new InetSocketAddress(remoteInetAddress, port), connectTimeout);
        if (socket instanceof SSLSocket) ((SSLSocket) socket).startHandshake();
        startListening();`;
const connectAfter = `        final int requestedTimeout = options.hasKey("connectTimeout") ? options.getInt("connectTimeout") : 4000;
        final int connectTimeout = requestedTimeout > 0 ? Math.min(requestedTimeout, 4000) : 4000;
        final long deadline = System.nanoTime() + connectTimeout * 1000000L;
        try {
            socket.connect(new InetSocketAddress(remoteInetAddress, port), connectTimeout);
            if (socket instanceof SSLSocket) {
                final int previousTimeout = socket.getSoTimeout();
                final long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new java.net.SocketTimeoutException("TLS connect deadline");
                socket.setSoTimeout((int) Math.max(1L, remaining / 1000000L));
                try { ((SSLSocket) socket).startHandshake(); }
                finally { if (!socket.isClosed()) socket.setSoTimeout(previousTimeout); }
            }
            startListening();
        } catch (IOException | RuntimeException e) {
            try { socket.close(); } catch (IOException ignored) { }
            throw e;
        }`;

function patchConnectSource(source) {
    if (source.split(connectAfter).length === 2 && !source.includes(connectBefore)) return source;
    if (source.split(connectBefore).length !== 2 || source.includes(connectAfter)) {
        throw new Error('TCP socket Android connect changed upstream; review this patch before building.');
    }
    return source.replace(connectBefore, connectAfter);
}

function patchPackage(packageDir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (pkg.name !== 'react-native-tcp-socket' || pkg.version !== '6.4.2') {
        throw new Error('TCP socket patch supports only react-native-tcp-socket 6.4.2; review upgrades explicitly.');
    }
    const file = path.join(packageDir, 'android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketModule.java');
    const source = fs.readFileSync(file, 'utf8');
    const patched = patchSource(source);
    const clientFile = path.join(packageDir, 'android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketClient.java');
    const client = fs.readFileSync(clientFile, 'utf8');
    const patchedClient = patchConnectSource(client);
    if (source !== patched) fs.writeFileSync(file, patched);
    if (client !== patchedClient) fs.writeFileSync(clientFile, patchedClient);
    return source !== patched || client !== patchedClient;
}

module.exports = { patchSource, patchPackage, before, after, patchConnectSource, connectBefore, connectAfter };
if (require.main === module) {
    patchPackage(path.resolve(__dirname, '../node_modules/react-native-tcp-socket'));
    console.log('Verified Android TCP socket cleanup patch (6.4.2).');
}
