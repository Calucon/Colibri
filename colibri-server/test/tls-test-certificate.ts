// Self-signed certificates for the TLS tests, made with the openssl command line tool so that the
// fingerprint the server computes is checked against one it did not compute itself. Each one is
// valid for localhost and 127.0.0.1, for two days: long enough for any run, and never committed.
import { execFileSync } from 'child_process';
import { X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';

export interface TestCertificate {
    certPath: string;
    keyPath: string;
    cert: Buffer;
    key: Buffer;
    // As openssl prints it: colon-separated upper-case hex.
    fingerprint256: string;
    // Milliseconds since the epoch.
    validFrom: number;
    validTo: number;
}

const openssl = function (args: string[]): string {
    try {
        return execFileSync('openssl', args, { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] });
    } catch (err) {
        throw new Error(
            'The TLS tests make their certificates with the openssl command line tool, which failed. Is it installed ' +
                `and on PATH? (Git for Windows ships one in usr/bin.) ${err instanceof Error ? err.message : String(err)}`
        );
    }
};

// Writes <name>.pem and <name>.key into `dir`.
export const createTestCertificate = function (dir: string, name = 'server', commonName = 'localhost'): TestCertificate {
    const certPath = path.join(dir, `${name}.pem`);
    const keyPath = path.join(dir, `${name}.key`);
    openssl([
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '2',
        '-subj', `/CN=${commonName}`, '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    // "sha256 Fingerprint=AB:CD:..." (the prefix's case differs between OpenSSL versions)
    const fingerprint256 = openssl([ 'x509', '-in', certPath, '-noout', '-fingerprint', '-sha256' ]).trim().split('=')[1]!;
    const cert = readFileSync(certPath);
    const x509 = new X509Certificate(cert);
    return {
        certPath, keyPath, cert, key: readFileSync(keyPath), fingerprint256,
        validFrom: x509.validFromDate.getTime(), validTo: x509.validToDate.getTime(),
    };
};

// Writes the key of `certificate`, protected by a passphrase, to <format>.key in `dir`: as PKCS #8
// ("BEGIN ENCRYPTED PRIVATE KEY"), or in the traditional format ("Proc-Type: 4,ENCRYPTED").
export const encryptTestKey = function (dir: string, certificate: TestCertificate, format: 'pkcs8' | 'traditional' = 'pkcs8'): string {
    const keyPath = path.join(dir, `${format}.key`);
    openssl([
        'pkey', '-in', certificate.keyPath, '-out', keyPath, '-aes256', '-passout', 'pass:colibri-test',
        ...(format === 'traditional' ? [ '-traditional' ] : []),
    ]);
    return keyPath;
};
