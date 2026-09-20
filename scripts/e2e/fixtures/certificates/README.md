# Local TLS fixture

The certificate and unencrypted private key are public test data for localhost,
not production credentials. The key must never be used outside tests. The
self-signed certificate has a DNS SAN for `localhost` only; requests to
`127.0.0.1` must fail hostname validation even when its CA is trusted.

Generated with OpenSSL (valid for ten years from September 20, 2026):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout localhost-key.pem \
  -out localhost-cert.pem -sha256 -days 3650 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost'
```

The E2E test supplies the certificate only through a child process's
`NODE_EXTRA_CA_CERTS`. It never modifies the machine's certificate stores.
