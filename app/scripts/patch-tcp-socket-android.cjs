'use strict';

// react-native-tcp-socket is MIT licensed; its existing notices stay intact.
// Android 6.4.2 queues destroy() through end(). A failed/cancelled connection
// can have no client registered when that worker runs. getTcpClient() throws
// outside a catch there, killing the app (Razr crash: TcpSocketModule.java:143).
// Change only this cleanup lookup. TLS verification, writes and iOS are untouched.
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

function patchPackage(packageDir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (pkg.name !== 'react-native-tcp-socket' || pkg.version !== '6.4.2') {
        throw new Error('TCP socket patch supports only react-native-tcp-socket 6.4.2; review upgrades explicitly.');
    }
    const file = path.join(packageDir, 'android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketModule.java');
    const source = fs.readFileSync(file, 'utf8');
    const patched = patchSource(source);
    if (source !== patched) fs.writeFileSync(file, patched);
    return source !== patched;
}

module.exports = { patchSource, patchPackage, before, after };
if (require.main === module) {
    patchPackage(path.resolve(__dirname, '../node_modules/react-native-tcp-socket'));
    console.log('Verified Android TCP socket cleanup patch (6.4.2).');
}
